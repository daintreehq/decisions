import {
  ANSWER_ACTIONS,
  CryptoEnvelope,
  DecisionContentV1,
  EventData,
  HumanAnswerContentV1,
  ProxyAnswerContentV1,
  QuestionRecord,
  provenanceForAction,
  type ActionKind,
  type ActionRecord,
  type Provenance,
  type Role,
} from '@daintree/decisions-protocol';
import {
  decryptEnvelope,
  verifyRecordAndEnvelope,
  type EpochKey,
} from '@daintree/decisions-crypto';
import type { TrustStore } from './trust.js';

export type Verified<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface VerifyCtx {
  installationId: string;
  trust: TrustStore;
  epochKeys: ReadonlyMap<number, EpochKey>;
}

const DESKTOP: readonly Role[] = ['owner-desktop', 'desktop-host'];
const HUMAN: readonly Role[] = ['phone', 'tablet'];
/** Mirrors the relay's role table (protocol state.ts); duplicated because the protocol keeps it private. */
const ACTION_ROLES: Record<ActionKind, readonly Role[]> = {
  answer: HUMAN,
  override: HUMAN,
  'confirm-proxy': HUMAN,
  'proxy-answer': DESKTOP,
  'proxy-abstain': DESKTOP,
  cancel: DESKTOP,
  reopen: ['owner-desktop'],
};

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export interface VerifiedQuestion {
  record: QuestionRecord;
  content: DecisionContentV1;
}

export async function verifyQuestionEvent(
  data: unknown,
  occurredAt: string,
  ctx: VerifyCtx,
): Promise<Verified<VerifiedQuestion>> {
  const parsed = EventData.created.safeParse(data);
  if (!parsed.success) return fail('malformed question event');
  const { record, envelope } = parsed.data;
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

export type AnswerContent = HumanAnswerContentV1 | ProxyAnswerContentV1;

export interface VerifiedAction {
  record: ActionRecord;
  provenance: Provenance | null;
  signerRole: Role;
  content: AnswerContent | null;
}

export async function verifyActionEvent(
  data: unknown,
  occurredAt: string,
  ctx: VerifyCtx,
): Promise<Verified<VerifiedAction>> {
  const parsed = EventData.action.safeParse(data);
  if (!parsed.success) return fail('malformed action event');
  const { record, envelope } = parsed.data;
  if (record.installation_id !== ctx.installationId)
    return fail('action belongs to another installation');
  if (record.action !== parsed.data.action)
    return fail('relay metadata disagrees with the signed action');
  const signer = ctx.trust.get(record.signer_device_id);
  if (!signer) return fail('unknown signer');
  if (!ACTION_ROLES[record.action].includes(signer.role)) {
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
  }
  return {
    ok: true,
    value: {
      record,
      provenance: provenance === 'none' ? null : provenance,
      signerRole: signer.role,
      content,
    },
  };
}
