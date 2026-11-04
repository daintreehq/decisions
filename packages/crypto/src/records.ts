import {
  PROTOCOL_VERSION,
  type ActionKind,
  type ActionRecord,
  MESSAGE_RECORD_TYPE,
  type CryptoEnvelope,
  type MessageRecord,
  type MessageSide,
  type QuestionRecord,
  type Requirement,
} from '@daintreehq/decisions-protocol';
import { envelopeDigest } from './envelope.js';
import { signObject, verifyObject } from './sign.js';
import { newId, nowIso } from './util.js';

export interface BuildQuestionInput {
  installationId: string;
  questionId: string;
  signerDeviceId: string;
  signingKey: CryptoKey;
  targetHostId: string;
  originRef: string;
  requirement: Requirement;
  workflowGateIdHash?: string | null;
  policyVersion?: number | null;
  expiresAt: string | null;
  attachmentIds: string[];
  envelope: CryptoEnvelope;
  createdAt?: string;
}

export async function buildSignedQuestion(i: BuildQuestionInput): Promise<{
  record: QuestionRecord;
  envelope: CryptoEnvelope;
}> {
  const record = (await signObject(i.signingKey, {
    v: PROTOCOL_VERSION,
    type: 'question' as const,
    installation_id: i.installationId,
    question_id: i.questionId,
    originating_device_id: i.signerDeviceId,
    target_host_id: i.targetHostId,
    origin_ref: i.originRef,
    requirement: i.requirement,
    workflow_gate_id_hash: i.workflowGateIdHash ?? null,
    policy_version: i.policyVersion ?? null,
    created_at: i.createdAt ?? nowIso(),
    expires_at: i.expiresAt,
    key_epoch: i.envelope.key_epoch,
    envelope_digest: await envelopeDigest(i.envelope),
    attachment_ids: i.attachmentIds,
    signer_device_id: i.signerDeviceId,
  })) as QuestionRecord;
  return { record, envelope: i.envelope };
}

export interface BuildActionInput {
  installationId: string;
  questionId: string;
  action: ActionKind;
  signerDeviceId: string;
  signingKey: CryptoKey;
  expectedRevision: number;
  envelope?: CryptoEnvelope | null;
  confirmsActionId?: string | null;
  expiresAt?: string | null;
  actionId?: string;
  createdAt?: string;
  /** `answer` / `override` only: the phone images the encrypted content references (protocol section 17). */
  attachmentIds?: string[];
}

export async function buildSignedAction(i: BuildActionInput): Promise<{
  record: ActionRecord;
  envelope: CryptoEnvelope | null;
}> {
  const envelope = i.envelope ?? null;
  const record = (await signObject(i.signingKey, {
    v: PROTOCOL_VERSION,
    type: 'action' as const,
    action: i.action,
    installation_id: i.installationId,
    question_id: i.questionId,
    action_id: i.actionId ?? newId(),
    expected_revision: i.expectedRevision,
    created_at: i.createdAt ?? nowIso(),
    envelope_digest: envelope ? await envelopeDigest(envelope) : null,
    confirms_action_id: i.confirmsActionId ?? null,
    expires_at: i.expiresAt ?? null,
    // Left out when absent, so records signed without images stay byte-identical to 0.3.0 ones.
    ...(i.attachmentIds !== undefined ? { attachment_ids: i.attachmentIds } : {}),
    signer_device_id: i.signerDeviceId,
  })) as ActionRecord;
  return { record, envelope };
}

export interface BuildMessageInput {
  installationId: string;
  questionId: string;
  /** Chosen by the signer, stable for the message's lifetime, and also the envelope's `record_id`. */
  messageId: string;
  side: MessageSide;
  signerDeviceId: string;
  signingKey: CryptoKey;
  /** Agent only: the agent is waiting on the person. */
  expectsReply?: boolean;
  /** Human only: the phone images the content references. */
  attachmentIds?: string[];
  envelope: CryptoEnvelope;
  createdAt?: string;
}

/** A signed thread message (docs/protocol.md section 16): its record and the envelope it commits to. */
export async function buildSignedMessage(i: BuildMessageInput): Promise<{
  record: MessageRecord;
  envelope: CryptoEnvelope;
}> {
  const record = (await signObject(i.signingKey, {
    v: PROTOCOL_VERSION,
    type: MESSAGE_RECORD_TYPE,
    installation_id: i.installationId,
    question_id: i.questionId,
    message_id: i.messageId,
    side: i.side,
    expects_reply: i.expectsReply ?? false,
    attachment_ids: i.attachmentIds ?? [],
    created_at: i.createdAt ?? nowIso(),
    envelope_digest: await envelopeDigest(i.envelope),
    signer_device_id: i.signerDeviceId,
  })) as MessageRecord;
  return { record, envelope: i.envelope };
}

/** Verifies the record signature and that the envelope is the one the signer committed to. */
export async function verifyRecordAndEnvelope(
  record: { signature?: unknown; envelope_digest?: string | null; [k: string]: unknown },
  envelope: CryptoEnvelope | null,
  signerSigningPub: CryptoKey,
): Promise<boolean> {
  if (!(await verifyObject(signerSigningPub, record))) return false;
  if (record.envelope_digest == null) return envelope === null;
  if (!envelope) return false;
  return (await envelopeDigest(envelope)) === record.envelope_digest;
}
