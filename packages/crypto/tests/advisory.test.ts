import { describe, expect, it } from 'vitest';
import {
  DecisionContentV1,
  SignedQuestion,
  replyModeOf,
  type CryptoEnvelope,
} from '@daintreehq/decisions-protocol';
import {
  ADVISORY_QUESTION_FIXTURE,
  BLOCKING_APPROVAL_FIXTURE,
} from '@daintreehq/decisions-protocol/fixtures';
import {
  buildSignedQuestion,
  decryptEnvelope,
  encryptEnvelope,
  generateDeviceKeys,
  generateEpochKeyBytes,
  importEpochKey,
  verifyRecordAndEnvelope,
} from '../src/index.js';

/** Encrypts and signs a fixture question with fresh keys, as the asking desktop does. */
async function sign(f: typeof ADVISORY_QUESTION_FIXTURE | typeof BLOCKING_APPROVAL_FIXTURE) {
  const keys = await generateDeviceKeys(true);
  const epoch = await importEpochKey(generateEpochKeyBytes(), 1, false);
  const envelope = await encryptEnvelope({
    epochKey: epoch,
    installationId: f.record.installation_id,
    questionId: f.record.question_id,
    recordId: f.envelope.record_id,
    recordType: 'question',
    revision: 0,
    senderDeviceId: f.record.signer_device_id,
    purpose: 'question-content',
    ...(f.envelope.aad.reply_mode ? { replyMode: f.envelope.aad.reply_mode } : {}),
    plaintext: f.content,
  });
  const q = await buildSignedQuestion({
    installationId: f.record.installation_id,
    questionId: f.record.question_id,
    signerDeviceId: f.record.signer_device_id,
    signingKey: keys.signing.privateKey,
    targetHostId: f.record.target_host_id,
    originRef: f.record.origin_ref,
    requirement: f.record.requirement,
    workflowGateIdHash: f.record.workflow_gate_id_hash,
    policyVersion: f.record.policy_version,
    expiresAt: f.record.expires_at,
    createdAt: f.record.created_at,
    attachmentIds: f.record.attachment_ids,
    envelope,
  });
  return { q, pub: keys.signing.publicKey, keys: new Map([[1, epoch]]) };
}

describe('the advisory question signature (protocol section 21)', () => {
  it('encrypts the fixture into a valid advisory question whose AAD matches the published binding', async () => {
    const { q, pub, keys } = await sign(ADVISORY_QUESTION_FIXTURE);
    expect(SignedQuestion.safeParse(q).success).toBe(true);
    expect(q.envelope.aad).toEqual(ADVISORY_QUESTION_FIXTURE.envelope.aad);
    expect(replyModeOf(q.envelope)).toBe('advisory');
    expect(await verifyRecordAndEnvelope(q.record, q.envelope, pub)).toBe(true);
    const content = DecisionContentV1.parse(await decryptEnvelope(q.envelope, keys));
    expect(content.planned_fallback).toBe(ADVISORY_QUESTION_FIXTURE.content.planned_fallback);
    // What travels in the clear holds neither the plan nor its field name.
    const wire = JSON.stringify(q);
    expect(wire).not.toContain(ADVISORY_QUESTION_FIXTURE.content.planned_fallback);
    expect(wire).not.toContain('planned_fallback');
  });

  it('marks nothing unless asked: a question without a reply mode is blocking', async () => {
    const { q, pub, keys } = await sign(BLOCKING_APPROVAL_FIXTURE);
    expect('reply_mode' in q.envelope.aad).toBe(false);
    expect(replyModeOf(q.envelope)).toBe('blocking');
    expect(await verifyRecordAndEnvelope(q.record, q.envelope, pub)).toBe(true);
    expect(DecisionContentV1.parse(await decryptEnvelope(q.envelope, keys)).kind).toBe('approval');
  });

  it('a relay can neither drop the mode, move it to another round, nor change the deadline', async () => {
    const { q, pub, keys } = await sign(ADVISORY_QUESTION_FIXTURE);
    const { reply_mode: _dropped, ...blockingAad } = q.envelope.aad;
    const stripped: CryptoEnvelope = { ...q.envelope, aad: blockingAad };
    expect(await verifyRecordAndEnvelope(q.record, stripped, pub)).toBe(false);
    await expect(decryptEnvelope(stripped, keys)).rejects.toThrow(/decryption failed/);
    const moved: CryptoEnvelope = { ...q.envelope, aad: { ...q.envelope.aad, revision: 1 } };
    expect(await verifyRecordAndEnvelope(q.record, moved, pub)).toBe(false);
    await expect(decryptEnvelope(moved, keys)).rejects.toThrow(/decryption failed/);
    const later = {
      ...q.record,
      expires_at: new Date(Date.parse(q.record.expires_at!) + 60_000).toISOString(),
    };
    expect(await verifyRecordAndEnvelope(later, q.envelope, pub)).toBe(false);
  });

  it('a relay cannot make a blocking question advisory', async () => {
    const { q, pub, keys } = await sign(BLOCKING_APPROVAL_FIXTURE);
    expect(await verifyRecordAndEnvelope(q.record, q.envelope, pub)).toBe(true);
    const marked: CryptoEnvelope = {
      ...q.envelope,
      aad: { ...q.envelope.aad, reply_mode: 'advisory' },
    };
    expect(await verifyRecordAndEnvelope(q.record, marked, pub)).toBe(false);
    await expect(decryptEnvelope(marked, keys)).rejects.toThrow(/decryption failed/);
  });
});
