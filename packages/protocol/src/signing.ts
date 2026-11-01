import { canonicalize } from './canonical.js';
import type { CryptoEnvelope } from './schema.js';

type Signed = { signature?: unknown; [k: string]: unknown };

/** Canonical bytes (as string) a record/cert/grant signature covers: everything except `signature`. */
export function signingString(obj: Signed): string {
  const { signature: _omit, ...rest } = obj;
  return canonicalize(rest);
}

/** Envelope digest input: the canonical JSON of the whole envelope. SHA-256 hex of this is `envelope_digest`. */
export function envelopeDigestInput(envelope: CryptoEnvelope): string {
  return canonicalize(envelope);
}

/** AAD string bound into AES-GCM: every visible envelope field that must not change. */
export function envelopeAadString(
  e: Pick<
    CryptoEnvelope,
    'crypto_version' | 'suite' | 'key_epoch' | 'record_id' | 'purpose' | 'aad'
  >,
): string {
  return canonicalize({
    crypto_version: e.crypto_version,
    suite: e.suite,
    key_epoch: e.key_epoch,
    record_id: e.record_id,
    purpose: e.purpose,
    aad: e.aad,
  });
}

export function envelopeKeyInfo(
  e: Pick<CryptoEnvelope, 'key_epoch' | 'record_id' | 'purpose' | 'aad'>,
): string {
  return canonicalize({
    label: 'decisions/v1/record',
    installation_id: e.aad.installation_id,
    question_id: e.aad.question_id,
    record_id: e.record_id,
    purpose: e.purpose,
    key_epoch: e.key_epoch,
  });
}

export function attachmentAadString(a: {
  installationId: string;
  questionId: string;
  attachmentId: string;
  keyEpoch: number;
}): string {
  return canonicalize({
    purpose: 'attachment',
    installation_id: a.installationId,
    question_id: a.questionId,
    attachment_id: a.attachmentId,
    key_epoch: a.keyEpoch,
  });
}

export function attachmentKeyInfo(a: {
  installationId: string;
  questionId: string;
  attachmentId: string;
  keyEpoch: number;
}): string {
  return canonicalize({
    label: 'decisions/v1/attachment',
    installation_id: a.installationId,
    question_id: a.questionId,
    attachment_id: a.attachmentId,
    key_epoch: a.keyEpoch,
  });
}

export function grantAadString(g: {
  installation_id: string;
  device_id: string;
  key_epoch: number;
  ephemeral_pub: string;
}): string {
  return canonicalize({
    purpose: 'epoch.grant',
    installation_id: g.installation_id,
    device_id: g.device_id,
    key_epoch: g.key_epoch,
    ephemeral_pub: g.ephemeral_pub,
  });
}

export function grantKeyInfo(g: {
  installation_id: string;
  device_id: string;
  key_epoch: number;
}): string {
  return canonicalize({
    label: 'decisions/v1/grant',
    installation_id: g.installation_id,
    device_id: g.device_id,
    key_epoch: g.key_epoch,
  });
}
