import type {
  MessageDeliveryStatus,
  MessageSide,
  PhoneImageReference,
} from '@daintreehq/decisions-protocol';

/**
 * Thread messages (protocol section 16) as the desktop keeps them: one `StoredMessage` per verified message in
 * `QuestionRow.messages_json`, in ledger order. Routing and delivery bookkeeping are in clear; what was said is
 * sealed (`sealed` is the message's relay envelope, the ciphertext the relay holds) and opened in memory only to
 * type it or show it (`openMessageContent`).
 *
 * A message never answers the question: nothing here touches the answer history, the revision, the question's
 * answer delivery status or any gate.
 */

/** A human message's local delivery status: the protocol's, less `relay-queued`, which only the relay reports. */
export type LocalMessageStatus = Exclude<MessageDeliveryStatus, 'relay-queued'>;

/** Where one human message stands on its way into the asking pane. */
export interface MessageDelivery {
  /**
   * `received` once it is stored here and waiting for the pane (also while the pane is busy or the host is
   * offline); `terminal-delivered` once typed; `needs-attention` when nothing was typed and a human has to act;
   * `delivery-uncertain` when it may have been typed and is never typed again automatically.
   */
  status: LocalMessageStatus;
  /** False once the question was withdrawn or deleted: it is kept for the thread but never typed. */
  deliver: boolean;
  received_at: string;
  terminal_delivered_at: string | null;
  /** The injection id of the attempt that typed it (or may have). */
  injection_id: string | null;
  error_code: string | null;
  /**
   * The latest status the relay accepted (or refused for good), so each change is reported once and `received`
   * always first. Null until the first receipt lands.
   */
  reported: LocalMessageStatus | null;
  /** Phone images the host already stored for this message, as for an answer (`AnswerEntry.stored_images`). */
  stored_images?: { attachment_id: string; path: string }[];
}

export interface StoredMessage {
  message_id: string;
  /** Relay-assigned order within the question, from 1. */
  message_seq: number;
  /** Ledger seq of the `decision.message.posted` event: the message's place among the question's answers. */
  event_seq: number;
  side: MessageSide;
  expects_reply: boolean;
  signer_device_id: string;
  /** The phone images the signed record lists. */
  attachment_ids: string[];
  created_at: string;
  committed_at: string;
  /** The signed record's `envelope_digest`: a replay of the same message id must carry the same content. */
  envelope_digest: string;
  /** The message's relay envelope, as JSON. */
  sealed: string;
  /** Human messages only; null for the agent's own. */
  delivery: MessageDelivery | null;
}

/** A message's content, opened in memory. Never stored. */
export interface MessageContent {
  text: string;
  /** Human only: the phone images, in the order the person attached them. */
  images: PhoneImageReference[];
}

export function parseMessages(json: string | null | undefined): StoredMessage[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as StoredMessage[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const serializeMessages = (m: readonly StoredMessage[]): string => JSON.stringify(m);

/** A human message that still has to reach the pane (not typed, not withdrawn), whatever is holding it. */
export function isUndeliveredMessage(m: StoredMessage): boolean {
  return (
    m.side === 'human' &&
    !!m.delivery &&
    m.delivery.deliver &&
    m.delivery.status !== 'terminal-delivered'
  );
}

/** A human message waiting to be typed: received here, not withdrawn, not held for a human. */
export function isPendingMessage(m: StoredMessage): boolean {
  return isUndeliveredMessage(m) && m.delivery!.status === 'received';
}

/**
 * The receipts still owed to the relay for a message, in order. `received` goes first, once; every later status
 * is reported when it differs from the last one reported. A retry that sends a message back to `received` is
 * not reported: the relay learns what the retry led to.
 */
export function unreportedStatuses(d: MessageDelivery): LocalMessageStatus[] {
  if (d.reported === null)
    return d.status === 'received' ? ['received'] : ['received', d.status];
  return d.status === 'received' || d.status === d.reported ? [] : [d.status];
}
