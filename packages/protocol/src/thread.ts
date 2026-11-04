import { z } from 'zod';
import { canonicalize } from './canonical.js';
import { utf8ByteLength } from './encoding.js';
import { ApiError } from './errors.js';
import { LIMITS } from './limits.js';
import {
  CryptoEnvelope,
  DESKTOP_ROLES,
  HUMAN_ROLES,
  Id,
  IsoTime,
  PhoneImageReferences,
  Sha256Hex,
  SigB64,
  type PhoneImageReference,
  type QuestionStatus,
  type Role,
} from './schema.js';
import type { QuestionState } from './state.js';
import { PROTOCOL_VERSION } from './version.js';

/*
 * Thread messages (docs/protocol.md section 16): follow-ups on one existing question, from the human (signed by a
 * paired phone or tablet) or from the agent (signed by the desktop that published the question). A message is its
 * own signed record, never an action: it never changes the answer in force, the revision, `deliverable` or any
 * gate outcome, and it never counts as approval.
 */

/** `aad.record_type` and the signed record's `type`. */
export const MESSAGE_RECORD_TYPE = 'thread.message' as const;

export const MessageSide = z.enum(['human', 'agent']);
export type MessageSide = z.infer<typeof MessageSide>;

export const MessageText = z
  .string()
  .refine((v) => utf8ByteLength(v) <= LIMITS.messageTextBytes, 'message text too large');

export const MessageRecord = z
  .looseObject({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal(MESSAGE_RECORD_TYPE),
    installation_id: Id,
    question_id: Id,
    /** Chosen by the signer, stable for the message's lifetime, and never reused within the installation. */
    message_id: Id,
    side: MessageSide,
    /** Agent only: the agent is waiting on the person. Always false on a human message. */
    expects_reply: z.boolean(),
    /** Human only: the phone images the encrypted content references. Always empty on an agent message. */
    attachment_ids: z.array(Id).max(LIMITS.phoneImagesPerContent),
    created_at: IsoTime,
    envelope_digest: Sha256Hex,
    signer_device_id: Id,
    signature: SigB64,
  })
  .superRefine((r, ctx) => {
    if (r.side === 'human' && r.expects_reply) {
      ctx.addIssue({
        code: 'custom',
        path: ['expects_reply'],
        message: 'only an agent message can expect a reply',
      });
    }
    if (r.side === 'agent' && r.attachment_ids.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['attachment_ids'],
        message: 'an agent message carries no phone images',
      });
    }
    if (new Set(r.attachment_ids).size !== r.attachment_ids.length) {
      ctx.addIssue({ code: 'custom', path: ['attachment_ids'], message: 'duplicate image id' });
    }
  });
export type MessageRecord = z.infer<typeof MessageRecord>;

/**
 * The visible fields a message envelope must carry. `record_id` is the message id; `aad.revision` is always 0,
 * because a message is independent of the answer revision and its order is assigned by the relay afterwards.
 */
export function messageEnvelopeIssues(record: MessageRecord, env: CryptoEnvelope): string[] {
  const issues: string[] = [];
  if (env.purpose !== 'message-content') issues.push('purpose must be message-content');
  if (env.record_id !== record.message_id) issues.push('record_id must be the message id');
  if (env.aad.record_type !== MESSAGE_RECORD_TYPE) issues.push('aad.record_type mismatch');
  if (env.aad.revision !== 0) issues.push('aad.revision must be 0');
  if (env.aad.installation_id !== record.installation_id) issues.push('installation mismatch');
  if (env.aad.question_id !== record.question_id) issues.push('question mismatch');
  if (env.aad.sender_device_id !== record.signer_device_id) issues.push('sender mismatch');
  return issues;
}

export const SignedMessage = z
  .object({ record: MessageRecord, envelope: CryptoEnvelope })
  .superRefine((m, ctx) => {
    for (const message of messageEnvelopeIssues(m.record, m.envelope)) {
      ctx.addIssue({ code: 'custom', path: ['envelope'], message });
    }
  });
export type SignedMessage = z.infer<typeof SignedMessage>;

/* ---------- decrypted content ---------- */

/** What the person wrote: text, images, or both. Fields of an answer (options, approval, reason) do not exist here. */
export const HumanMessageContentV1 = z
  .object({
    content_version: z.literal(1).default(1),
    side: z.literal('human'),
    text: MessageText.default(''),
    images: PhoneImageReferences.default([]),
  })
  .refine((c) => c.text.trim() !== '' || c.images.length > 0, 'a message needs text or an image');
export type HumanMessageContentV1 = z.infer<typeof HumanMessageContentV1>;

export const AgentMessageContentV1 = z.object({
  content_version: z.literal(1).default(1),
  side: z.literal('agent'),
  text: MessageText.refine((t) => t.trim() !== '', 'a message needs text'),
});
export type AgentMessageContentV1 = z.infer<typeof AgentMessageContentV1>;

export const MessageContentV1 = z.discriminatedUnion('side', [
  HumanMessageContentV1,
  AgentMessageContentV1,
]);
export type MessageContentV1 = z.infer<typeof MessageContentV1>;

/**
 * True when decrypted content references exactly the images its signed record lists: none the relay did not
 * bind, none missing. Clients check this (and, for a message, that `content.side === record.side`) before
 * showing a message or an image-bearing answer.
 */
export function imagesMatchRecord(
  attachmentIds: readonly string[] | undefined,
  images: readonly PhoneImageReference[] | undefined,
): boolean {
  const ids = attachmentIds ?? [];
  const refs = images ?? [];
  if (ids.length !== refs.length) return false;
  const want = new Set(ids);
  if (want.size !== ids.length) return false;
  return refs.every((r) => want.delete(r.attachment_id)) && want.size === 0;
}

/* ---------- committed messages, requests and responses ---------- */

/** A message as the relay committed it. `message_seq` is the relay-assigned order within the question, from 1. */
export const MessageEntry = z.object({
  message_seq: z.number().int().min(1),
  committed_at: IsoTime,
  record: MessageRecord,
  envelope: CryptoEnvelope,
});
export type MessageEntry = z.infer<typeof MessageEntry>;

export const MessageDeliveryStatus = z.enum([
  'relay-queued',
  'received',
  'terminal-delivered',
  'needs-attention',
  'delivery-uncertain',
]);
export type MessageDeliveryStatus = z.infer<typeof MessageDeliveryStatus>;

/** Where a human message stands on its way into the pane. Agent messages have none. */
export const MessageDeliveryInfo = z.object({
  status: MessageDeliveryStatus,
  received_at: IsoTime.nullable(),
  terminal_delivered_at: IsoTime.nullable(),
  injection_id: Id.nullable(),
  error_code: z.string().nullable(),
});
export type MessageDeliveryInfo = z.infer<typeof MessageDeliveryInfo>;

export const MessageView = MessageEntry.extend({
  /** Ledger seq of the `decision.message.posted` event; orders messages against answers. */
  event_seq: z.number().int().min(1),
  delivery: MessageDeliveryInfo.nullable(),
});
export type MessageView = z.infer<typeof MessageView>;

/** `POST /questions/{id}/messages`. */
export const MessageBody = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  idempotency_key: Id,
  message: SignedMessage,
});
export type MessageBody = z.infer<typeof MessageBody>;

export const MessageReceipt = z.object({
  question_id: Id,
  message_id: Id,
  message_seq: z.number().int().min(1),
  event_seq: z.number().int().min(1),
  committed_at: IsoTime,
});
export type MessageReceipt = z.infer<typeof MessageReceipt>;

/** `GET /questions/{id}/messages?after=<message_seq>&limit=<n>`. */
export const MessagesPage = z.object({
  question_id: Id,
  messages: z.array(MessageView).max(LIMITS.messagePageSize),
  next_after: z.number().int().min(0),
  has_more: z.boolean(),
});
export type MessagesPage = z.infer<typeof MessagesPage>;

const receiptBase = {
  protocol_version: z.literal(PROTOCOL_VERSION),
  idempotency_key: Id,
  question_id: Id,
  message_id: Id,
  host_id: Id,
};
const ErrorCode = z.string().regex(/^[a-z0-9_.-]{1,48}$/);

/**
 * `POST /deliveries/messages`: the desktop that published the question reports one human message as durably
 * received, typed into the pane, or needing attention. A ledger acknowledgement never stands in for `received`.
 */
export const MessageReceiptBody = z.discriminatedUnion('status', [
  z.object({ ...receiptBase, status: z.literal('received') }),
  z.object({ ...receiptBase, status: z.literal('terminal-delivered'), injection_id: Id }),
  z.object({ ...receiptBase, status: z.literal('needs-attention'), error_code: ErrorCode }),
  z.object({ ...receiptBase, status: z.literal('delivery-uncertain'), error_code: ErrorCode }),
]);
export type MessageReceiptBody = z.infer<typeof MessageReceiptBody>;

/**
 * The crash-recovery key for typing one message into a pane, in place of an answer's `(question_id,
 * answer_revision)`. A host writes its injection intent under this key before touching the terminal and reuses
 * the intent's `injection_id` after a restart.
 */
export function messageDeliveryKey(questionId: string, messageId: string): string {
  return canonicalize({ kind: 'message', question_id: questionId, message_id: messageId });
}

/* ---------- rules ---------- */

/** Expired and cancelled (shown as "withdrawn") questions take no messages and keep no snapshot. */
export const isThreadClosedStatus = (s: QuestionStatus): boolean =>
  s === 'expired' || s === 'cancelled';

export interface MessageTransition {
  /** The question state, unchanged: a message never moves the answer, revision or proxy state. */
  state: QuestionState;
  /** Always false: a message is never an answer to deliver. */
  deliverable: false;
  /** Always false: a message never satisfies a gate or counts as approval. */
  approval: false;
  /** True for a human message, which the publishing desktop types into the pane under its own receipt. */
  deliverToHost: boolean;
}

/**
 * Pure acceptance rule for a new message. Throws `ApiError` when the message must be refused; otherwise returns
 * the question state untouched. `signerIsPublisher` is true when the signer is the question's
 * `originating_device_id`. `messageCount` is the question's lifetime message count before this one.
 */
export function applyMessage(
  state: QuestionState,
  m: { side: MessageSide; role: Role; signerIsPublisher: boolean; messageCount: number },
): MessageTransition {
  if (m.side === 'human' && !HUMAN_ROLES.includes(m.role)) {
    throw new ApiError('forbidden', `role ${m.role} may not send a human message`);
  }
  if (m.side === 'agent' && !(DESKTOP_ROLES.includes(m.role) && m.signerIsPublisher)) {
    throw new ApiError(
      'forbidden',
      'only the desktop that published the question speaks for its agent',
    );
  }
  if (state.status === 'expired') throw new ApiError('expired', 'question expired');
  if (isThreadClosedStatus(state.status)) {
    throw new ApiError('invalid_state', `a ${state.status} question takes no messages`);
  }
  if (m.messageCount >= LIMITS.messagesPerQuestion) {
    throw new ApiError('invalid_state', 'this question has reached its message limit');
  }
  return {
    state: { ...state },
    deliverable: false,
    approval: false,
    deliverToHost: m.side === 'human',
  };
}

/**
 * Whether the thread is waiting on the person: the latest agent message expects a reply and nothing human came
 * after it (a human message, or a human answer, override or confirmation, compared by ledger seq). An open
 * question needs the person anyway; this is what brings an answered one back.
 */
export function threadAwaitsHuman(i: {
  status: QuestionStatus;
  messages: readonly { side: MessageSide; expects_reply: boolean; event_seq: number }[];
  /** Ledger seq of the latest human answer, override or confirm-proxy, if any. */
  lastHumanActionSeq?: number | null;
}): boolean {
  if (isThreadClosedStatus(i.status)) return false;
  let lastAgent: { expects_reply: boolean; event_seq: number } | null = null;
  let lastHuman = i.lastHumanActionSeq ?? 0;
  for (const m of i.messages) {
    if (m.side === 'agent') {
      if (!lastAgent || m.event_seq > lastAgent.event_seq) lastAgent = m;
    } else if (m.event_seq > lastHuman) {
      lastHuman = m.event_seq;
    }
  }
  return !!lastAgent && lastAgent.expects_reply && lastAgent.event_seq > lastHuman;
}

/* ---------- push ---------- */

/**
 * Every push payload the relay may send: an attention signal (type and question id) and nothing else. No
 * question, answer, message or snapshot field fits, which is the rule. `decision-reply` is an agent message that
 * expects a reply.
 */
export const PushPayload = z.union([
  z.strictObject({ type: z.literal('test') }),
  z.strictObject({
    type: z.enum(['decision-new', 'decision-reminder', 'decision-proxy', 'decision-reply']),
    question_id: Id,
  }),
]);
export type PushPayload = z.infer<typeof PushPayload>;
