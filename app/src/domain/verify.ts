import {
  ANSWER_ACTIONS,
  CryptoEnvelope,
  DecisionContentV1,
  EventData,
  HumanAnswerContentV1,
  MESSAGE_RECORD_TYPE,
  MessageContentV1,
  ProxyAnswerContentV1,
  QuestionRecord,
  imagesMatchRecord,
  messageEnvelopeIssues,
  provenanceForAction,
  roleMaySign,
  type ActionRecord,
  type MessageRecord,
  type Provenance,
  type Role,
} from '@daintreehq/decisions-protocol';
import {
  decryptEnvelope,
  verifyRecordAndEnvelope,
  type EpochKey,
} from '@daintreehq/decisions-crypto';
import type { TrustStore } from './trust.js';

export type Verified<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * A genuine, correctly signed question sealed under a content key this phone was never given (typically one
 * asked before this phone was paired, since a new phone receives only the current key). Not a sign of
 * tampering, so the app tells it apart from every other failure.
 */
export const NO_EPOCH_KEY = 'this phone holds no epoch key for this question';

export interface VerifyCtx {
  installationId: string;
  trust: TrustStore;
  epochKeys: ReadonlyMap<number, EpochKey>;
}

const DESKTOP: readonly Role[] = ['owner-desktop', 'desktop-host'];
const HUMAN: readonly Role[] = ['phone', 'tablet'];
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export interface VerifiedQuestion {
  record: QuestionRecord;
  content: DecisionContentV1;
}

export async function verifyQuestionEvent(
  data: unknown,
  occurredAt: string,
  ctx: VerifyCtx,
  /** The ledger event's own (unsigned) question id; it must be the one the signer actually signed. */
  eventQuestionId: string | null,
): Promise<Verified<VerifiedQuestion>> {
  const parsed = EventData.created.safeParse(data);
  if (!parsed.success) return fail('malformed question event');
  const { record, envelope } = parsed.data;
  // Checked before anything is decrypted: a relay must not be able to file one question's signed content under another id.
  if (eventQuestionId !== record.question_id || envelope.aad.question_id !== record.question_id) {
    return fail('question id does not match the signed record');
  }
  if (record.installation_id !== ctx.installationId)
    return fail('question belongs to another installation');
  if (record.signer_device_id !== record.originating_device_id)
    return fail('signer is not the originating device');
  const signer = ctx.trust.get(record.signer_device_id);
  if (!signer) return fail('unknown signer');
  if (!DESKTOP.includes(signer.role)) return fail('questions may only be signed by a desktop');
  if (signer.revokedAt && occurredAt > signer.revokedAt)
    return fail('signed by a device after it was revoked');
  if (!(await verifyRecordAndEnvelope(record, envelope, signer.signingKey))) {
    return fail('signature or ciphertext does not match');
  }
  if (envelope.aad.record_type !== 'question') return fail('wrong record type');
  // Only once the signature and every binding hold: an unsigned, altered or misbound question is a failure,
  // whatever its epoch says. (decryptEnvelope checks the same bindings, but only after looking up the key.)
  if (
    envelope.aad.installation_id !== ctx.installationId ||
    envelope.aad.sender_device_id !== record.signer_device_id ||
    envelope.purpose !== 'question-content'
  )
    return fail('envelope binding mismatch');
  if (!ctx.epochKeys.has(envelope.key_epoch)) return fail(NO_EPOCH_KEY);
  let plain: unknown;
  try {
    plain = await decryptEnvelope(envelope, ctx.epochKeys, {
      installationId: ctx.installationId,
      questionId: record.question_id,
      senderDeviceId: record.signer_device_id,
      purpose: 'question-content',
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'could not decrypt');
  }
  const content = DecisionContentV1.safeParse(plain);
  if (!content.success) return fail('question content is malformed');
  return { ok: true, value: { record, content: content.data } };
}

export interface VerifiedMessage {
  record: MessageRecord;
  signerRole: Role;
  content: MessageContentV1;
}

/**
 * A thread message (docs/protocol.md section 16): a human one signed by a paired phone or tablet, an agent one
 * signed by the desktop that published the question (`publisherDeviceId`) and by no other. Its content is opened
 * only once the signature, the envelope's bindings and the signer's role all hold, and it is shown only when the
 * content says the same side and lists the same images as the signed record.
 */
export async function verifyMessageEvent(
  data: unknown,
  occurredAt: string,
  ctx: VerifyCtx,
  eventQuestionId: string | null,
  publisherDeviceId: string,
): Promise<Verified<VerifiedMessage>> {
  const parsed = EventData.messagePosted.safeParse(data);
  if (!parsed.success) return fail('malformed message event');
  const { record, envelope } = parsed.data;
  if (eventQuestionId !== record.question_id || envelope.aad.question_id !== record.question_id) {
    return fail('question id does not match the signed record');
  }
  if (record.installation_id !== ctx.installationId)
    return fail('message belongs to another installation');
  if (messageEnvelopeIssues(record, envelope).length > 0) return fail('envelope binding mismatch');
  const signer = ctx.trust.get(record.signer_device_id);
  if (!signer) return fail('unknown signer');
  if (record.side === 'human' && !HUMAN.includes(signer.role))
    return fail(`a ${signer.role} cannot sign a human message`);
  if (
    record.side === 'agent' &&
    (!DESKTOP.includes(signer.role) || record.signer_device_id !== publisherDeviceId)
  )
    return fail('only the desktop that asked the question speaks for its agent');
  if (signer.revokedAt && occurredAt > signer.revokedAt)
    return fail('signed by a device after it was revoked');
  if (!(await verifyRecordAndEnvelope(record, envelope, signer.signingKey))) {
    return fail('signature or ciphertext does not match');
  }
  if (!ctx.epochKeys.has(envelope.key_epoch)) return fail(NO_EPOCH_KEY);
  let plain: unknown;
  try {
    plain = await decryptEnvelope(envelope, ctx.epochKeys, {
      installationId: ctx.installationId,
      questionId: record.question_id,
      senderDeviceId: record.signer_device_id,
      recordType: MESSAGE_RECORD_TYPE,
      revision: 0,
      purpose: 'message-content',
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'could not decrypt');
  }
  const content = MessageContentV1.safeParse(plain);
  if (!content.success) return fail('message content is malformed');
  if (content.data.side !== record.side) return fail('message content disagrees with its record');
  const images = content.data.side === 'human' ? content.data.images : [];
  if (!imagesMatchRecord(record.attachment_ids, images))
    return fail('message images disagree with its record');
  return { ok: true, value: { record, signerRole: signer.role, content: content.data } };
}

export type AnswerContent = HumanAnswerContentV1 | ProxyAnswerContentV1;

export interface VerifiedAction {
  record: ActionRecord;
  provenance: Provenance | null;
  signerRole: Role;
  content: AnswerContent | null;
  /**
   * A human answer's photos are exactly the ones its signed record lists (docs/protocol.md section 17). When they
   * are not, the answer still stands and its photos show as unavailable; nothing of them is fetched.
   */
  imagesOk: boolean;
}

export async function verifyActionEvent(
  data: unknown,
  occurredAt: string,
  ctx: VerifyCtx,
  eventQuestionId: string | null,
): Promise<Verified<VerifiedAction>> {
  const parsed = EventData.action.safeParse(data);
  if (!parsed.success) return fail('malformed action event');
  const { record, envelope } = parsed.data;
  if (
    eventQuestionId !== record.question_id ||
    (envelope && envelope.aad.question_id !== record.question_id)
  ) {
    return fail('question id does not match the signed record');
  }
  if (record.installation_id !== ctx.installationId)
    return fail('action belongs to another installation');
  if (record.action !== parsed.data.action)
    return fail('relay metadata disagrees with the signed action');
  const signer = ctx.trust.get(record.signer_device_id);
  if (!signer) return fail('unknown signer');
  if (!roleMaySign(record.action, signer.role)) {
    return fail(`a ${signer.role} cannot sign ${record.action}`);
  }
  if (signer.revokedAt && occurredAt > signer.revokedAt)
    return fail('signed by a device after it was revoked');
  const provenance = provenanceForAction(record.action);
  const claimed = parsed.data.provenance;
  if ((provenance === 'none' ? null : provenance) !== claimed)
    return fail('relay provenance disagrees with the signed action');
  if (ANSWER_ACTIONS.includes(record.action) && !envelope) return fail('answer without content');
  if (!(await verifyRecordAndEnvelope(record, envelope, signer.signingKey))) {
    return fail('signature or ciphertext does not match');
  }
  let content: AnswerContent | null = null;
  let imagesOk = true;
  if (envelope) {
    let plain: unknown;
    try {
      plain = await decryptEnvelope(CryptoEnvelope.parse(envelope), ctx.epochKeys, {
        installationId: ctx.installationId,
        questionId: record.question_id,
        senderDeviceId: record.signer_device_id,
        purpose: 'answer-content',
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'could not decrypt');
    }
    const c = (provenance === 'proxy' ? ProxyAnswerContentV1 : HumanAnswerContentV1).safeParse(
      plain,
    );
    if (!c.success) return fail('answer content is malformed');
    content = c.data;
    if (provenance !== 'proxy')
      imagesOk = imagesMatchRecord(
        record.attachment_ids,
        (c.data as HumanAnswerContentV1).images ?? [],
      );
  }
  return {
    ok: true,
    value: {
      record,
      provenance: provenance === 'none' ? null : provenance,
      signerRole: signer.role,
      content,
      imagesOk,
    },
  };
}
