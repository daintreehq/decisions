import { describe, expect, it } from 'vitest';
import { bytesToBase64Url } from '@daintreehq/decisions-protocol';
import {
  issueDeviceCert,
  newId,
  randomBytes,
  generateDeviceKeys,
  exportPublicKey,
} from '@daintreehq/decisions-crypto';
import { TrustStore } from '../src/domain/trust.js';
import { NO_EPOCH_KEY, verifyActionEvent, verifyQuestionEvent } from '../src/domain/verify.js';
import { actionEvent, makeWorld, questionEvent, type World } from './helpers.js';

const ctx = (w: World) => ({
  installationId: w.installationId,
  trust: w.trust,
  epochKeys: w.epochs,
});
const NOW = new Date().toISOString();

describe('question verification', () => {
  it('verifies, decrypts and validates a genuine question', async () => {
    const w = await makeWorld();
    const e = await questionEvent(w);
    const r = await verifyQuestionEvent(e.data, NOW, ctx(w), e.question_id!);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.content.question).toBe('Use the compact sidebar?');
      expect(r.value.content.options).toHaveLength(2);
    }
  });

  it('rejects tampered ciphertext (relay swapped bytes)', async () => {
    const w = await makeWorld();
    const e = await questionEvent(w, {
      tamper: (env) => {
        env.ciphertext =
          env.ciphertext.slice(0, -2) + (env.ciphertext.endsWith('AA') ? 'BB' : 'AA');
      },
    });
    const r = await verifyQuestionEvent(e.data, NOW, ctx(w), e.question_id!);
    expect(r).toMatchObject({ ok: false });
  });

  it('rejects a question signed by a phone', async () => {
    const w = await makeWorld();
    const e = await questionEvent(w, { signer: w.phone });
    const r = await verifyQuestionEvent(e.data, NOW, ctx(w), e.question_id!);
    expect(r).toEqual({ ok: false, reason: 'questions may only be signed by a desktop' });
  });

  it('rejects an unknown signer and a signer certified by someone other than the owner', async () => {
    const w = await makeWorld();
    const rogue = await generateDeviceKeys(true);
    const rogueId = newId();
    const rogueCert = await issueDeviceCert({
      issuerDeviceId: rogueId,
      issuerSigningKey: rogue.signing.privateKey,
      installationId: w.installationId,
      deviceId: rogueId,
      role: 'desktop-host',
      label: 'evil',
      signingPub: await exportPublicKey(rogue.signing.publicKey),
      exchangePub: await exportPublicKey(rogue.exchange.publicKey),
    });
    // The pinned owner key never signed this certificate, so the trust store refuses it.
    expect(await w.trust.addCert(rogueCert, null)).toBe(false);
    const e = await questionEvent(w, {
      signer: { id: rogueId, keys: rogue, cert: rogueCert, signingPub: '', exchangePub: '' },
    });
    expect(await verifyQuestionEvent(e.data, NOW, ctx(w), e.question_id!)).toEqual({
      ok: false,
      reason: 'unknown signer',
    });
  });

  it('rejects content that fails the schema and the wrong key epoch', async () => {
    const w = await makeWorld();
    const bad = await questionEvent(w, { content: { question: '' } });
    expect(await verifyQuestionEvent(bad.data, NOW, ctx(w), bad.question_id!)).toEqual({
      ok: false,
      reason: 'question content is malformed',
    });
    const e = await questionEvent(w);
    const r = await verifyQuestionEvent(
      e.data,
      NOW,
      { ...ctx(w), epochKeys: new Map() },
      e.question_id!,
    );
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/epoch key/);
  });

  it('tells a genuine question sealed under a key this phone lacks apart from a forged one', async () => {
    const w = await makeWorld();
    const noKeys = { ...ctx(w), epochKeys: new Map() };
    const genuine = await questionEvent(w);
    expect(await verifyQuestionEvent(genuine.data, NOW, noKeys, genuine.question_id!)).toEqual({
      ok: false,
      reason: NO_EPOCH_KEY,
    });
    // altered in transit: still a verification failure, never "just a missing key"
    const forged = await questionEvent(w, {
      tamper: (env) => {
        env.ciphertext =
          env.ciphertext.slice(0, -2) + (env.ciphertext.endsWith('AA') ? 'BB' : 'AA');
      },
    });
    const r = await verifyQuestionEvent(forged.data, NOW, noKeys, forged.question_id!);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).not.toBe(NO_EPOCH_KEY);
    // signed by the desktop but sealed for another purpose: misbound, so never "just a missing key"
    const misbound = await questionEvent(w, { purpose: 'answer-content' });
    expect(await verifyQuestionEvent(misbound.data, NOW, noKeys, misbound.question_id!)).toEqual({
      ok: false,
      reason: 'envelope binding mismatch',
    });
  });

  it('rejects another installation', async () => {
    const w = await makeWorld();
    const other = await makeWorld();
    const e = await questionEvent(other);
    expect(await verifyQuestionEvent(e.data, NOW, ctx(w), e.question_id!)).toEqual({
      ok: false,
      reason: 'question belongs to another installation',
    });
  });
});

describe('action verification and provenance', () => {
  it('accepts a human answer from a phone and a proxy answer from a desktop', async () => {
    const w = await makeWorld();
    const q = await questionEvent(w, { requirement: 'proxy-ok' });
    const human = await actionEvent(w, { questionId: q.question_id!, action: 'answer' });
    const hr = await verifyActionEvent(human.data, NOW, ctx(w), human.question_id!);
    expect(hr.ok && hr.value.provenance).toBe('human');
    if (hr.ok)
      expect(hr.value.content).toMatchObject({ selected_option_ids: ['yes'], text: 'go ahead' });
    const proxy = await actionEvent(w, { questionId: q.question_id!, action: 'proxy-answer' });
    const pr = await verifyActionEvent(proxy.data, NOW, ctx(w), proxy.question_id!);
    expect(pr.ok && pr.value.provenance).toBe('proxy');
  });

  it('rejects a desktop forging a HUMAN answer', async () => {
    const w = await makeWorld();
    const q = await questionEvent(w);
    const forged = await actionEvent(w, {
      questionId: q.question_id!,
      action: 'answer',
      signer: w.desktop,
    });
    const r = await verifyActionEvent(forged.data, NOW, ctx(w), forged.question_id!);
    expect(r).toEqual({ ok: false, reason: 'a owner-desktop cannot sign answer' });
  });

  it('rejects a phone signing a PROXY answer', async () => {
    const w = await makeWorld();
    const q = await questionEvent(w);
    const forged = await actionEvent(w, {
      questionId: q.question_id!,
      action: 'proxy-answer',
      signer: w.phone,
    });
    expect(await verifyActionEvent(forged.data, NOW, ctx(w), forged.question_id!)).toEqual({
      ok: false,
      reason: 'a phone cannot sign proxy-answer',
    });
  });

  it('rejects a relay relabelling a proxy answer as human', async () => {
    const w = await makeWorld();
    const q = await questionEvent(w, { requirement: 'proxy-ok' });
    const proxy = await actionEvent(w, {
      questionId: q.question_id!,
      action: 'proxy-answer',
      provenance: 'human',
    });
    expect(await verifyActionEvent(proxy.data, NOW, ctx(w), proxy.question_id!)).toEqual({
      ok: false,
      reason: 'relay provenance disagrees with the signed action',
    });
  });

  it('rejects an answer envelope lifted from another question', async () => {
    const w = await makeWorld();
    const a = await questionEvent(w);
    const b = await questionEvent(w);
    // Valid signature over question B, but the ciphertext was encrypted for question A.
    const lifted = await actionEvent(w, {
      questionId: b.question_id!,
      action: 'answer',
      envelopeQuestionId: a.question_id!,
    });
    const r = await verifyActionEvent(lifted.data, NOW, ctx(w), lifted.question_id!);
    expect(r).toEqual({ ok: false, reason: 'question id does not match the signed record' });
  });

  it('rejects a corrupted signature', async () => {
    const w = await makeWorld();
    const q = await questionEvent(w);
    const e = await actionEvent(w, { questionId: q.question_id!, action: 'answer' });
    const rec = (e.data as { record: { signature: string } }).record;
    rec.signature = bytesToBase64Url(randomBytes(64));
    expect(await verifyActionEvent(e.data, NOW, ctx(w), e.question_id!)).toEqual({
      ok: false,
      reason: 'signature or ciphertext does not match',
    });
  });
});

describe('revoked devices keep their history but lose the future', () => {
  it('accepts events from before the revocation and refuses events after', async () => {
    const w = await makeWorld();
    const q = await questionEvent(w);
    const revokedAt = '2026-11-01T10:00:00.000Z';
    w.trust.markRevoked(w.phone.id, revokedAt);
    const before = await actionEvent(w, { questionId: q.question_id!, action: 'answer' });
    const ok = await verifyActionEvent(
      before.data,
      '2026-11-01T09:59:59.000Z',
      ctx(w),
      before.question_id!,
    );
    expect(ok.ok).toBe(true);
    const after = await verifyActionEvent(
      before.data,
      '2026-11-01T10:00:01.000Z',
      ctx(w),
      before.question_id!,
    );
    expect(after).toEqual({ ok: false, reason: 'signed by a device after it was revoked' });
  });
});

describe('trust store', () => {
  it('pins the owner and refuses a second owner or a mismatched key', async () => {
    const w = await makeWorld();
    const other = await makeWorld();
    await expect(TrustStore.create(w.installationId, other.owner.cert)).rejects.toThrow(
      /another installation/,
    );
    await expect(
      TrustStore.create(w.installationId, w.owner.cert, other.owner.signingPub),
    ).rejects.toThrow(/pinned/);
    expect(await w.trust.addCert(other.owner.cert, null)).toBe(false);
    expect(w.trust.get(w.phone.id)?.role).toBe('phone');
  });
});

describe('question id binding (event ↔ signed record ↔ envelope)', () => {
  it('rejects a genuine question delivered under another question’s id', async () => {
    const w = await makeWorld();
    const a = await questionEvent(w);
    const b = await questionEvent(w);
    const r = await verifyQuestionEvent(a.data, NOW, ctx(w), b.question_id!);
    expect(r).toEqual({ ok: false, reason: 'question id does not match the signed record' });
    expect((await verifyQuestionEvent(a.data, NOW, ctx(w), a.question_id!)).ok).toBe(true);
  });

  it('rejects a validly signed record whose envelope was encrypted for a different question', async () => {
    const w = await makeWorld();
    const other = await questionEvent(w);
    const e = await questionEvent(w, { envelopeQuestionId: other.question_id! });
    const r = await verifyQuestionEvent(e.data, NOW, ctx(w), e.question_id!);
    expect(r).toEqual({ ok: false, reason: 'question id does not match the signed record' });
  });

  it('rejects an action delivered under another question’s id, before decrypting anything', async () => {
    const w = await makeWorld();
    const a = await questionEvent(w);
    const b = await questionEvent(w);
    const answerForA = await actionEvent(w, { questionId: a.question_id!, action: 'answer' });
    const r = await verifyActionEvent(answerForA.data, NOW, ctx(w), b.question_id!);
    expect(r).toEqual({ ok: false, reason: 'question id does not match the signed record' });
  });
});
