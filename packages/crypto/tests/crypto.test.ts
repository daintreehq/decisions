import { describe, expect, it } from 'vitest';
import {
  CryptoEnvelope as EnvelopeSchema,
  DeviceCert as CertSchema,
  EpochGrant as GrantSchema,
  QuestionRecord as QuestionSchema,
  SignedAction,
  SignedMessage,
  bytesToBase64Url,
  parseAuthHeader,
} from '@daintreehq/decisions-protocol';
import {
  buildSignedAction,
  buildSignedMessage,
  buildSignedQuestion,
  createEpochGrant,
  decodeInvite,
  decryptAttachment,
  decryptEnvelope,
  decryptRecoveryBundle,
  deserializeDeviceKeys,
  encodeInvite,
  encryptAttachment,
  encryptEnvelope,
  encryptRecoveryBundle,
  envelopeDigest,
  exportPublicKey,
  fingerprint,
  generateDeviceKeys,
  generateEpochKeyBytes,
  generatePairingSecret,
  importEpochKey,
  importSigningPublicKey,
  inviteDigest,
  inviteUrl,
  issueDeviceCert,
  newId,
  openEpochGrant,
  pairingShortCode,
  randomBytes,
  serializeDeviceKeys,
  sha256Hex,
  signPairingPop,
  signRequest,
  verifyDeviceCert,
  verifyPairingPop,
  verifyRecordAndEnvelope,
  verifyRequestSignature,
  verifySelfSignedCert,
  verifyString,
  signString,
} from '../src/index.js';

const INST = newId();

async function world() {
  const ownerKeys = await generateDeviceKeys(true);
  const phoneKeys = await generateDeviceKeys(false);
  const ownerId = newId();
  const phoneId = newId();
  const ownerSigningPub = await exportPublicKey(ownerKeys.signing.publicKey);
  const ownerExchangePub = await exportPublicKey(ownerKeys.exchange.publicKey);
  const phoneSigningPub = await exportPublicKey(phoneKeys.signing.publicKey);
  const phoneExchangePub = await exportPublicKey(phoneKeys.exchange.publicKey);
  const epochRaw = generateEpochKeyBytes();
  const ownerEpoch = await importEpochKey(epochRaw, 1, true);
  return {
    ownerKeys,
    phoneKeys,
    ownerId,
    phoneId,
    ownerSigningPub,
    ownerExchangePub,
    phoneSigningPub,
    phoneExchangePub,
    epochRaw,
    ownerEpoch,
  };
}

describe('keys and signatures', () => {
  it('public keys are 87 chars and signatures 86 chars (schema-compatible)', async () => {
    const w = await world();
    expect(w.ownerSigningPub).toHaveLength(87);
    const sig = await signString(w.ownerKeys.signing.privateKey, 'hello');
    expect(sig).toHaveLength(86);
    expect(await verifyString(w.ownerKeys.signing.publicKey, 'hello', sig)).toBe(true);
    expect(await verifyString(w.ownerKeys.signing.publicKey, 'hellp', sig)).toBe(false);
    expect(await verifyString(w.phoneKeys.signing.publicKey, 'hello', sig)).toBe(false);
    expect(await verifyString(w.ownerKeys.signing.publicKey, 'hello', 'AAAA')).toBe(false);
  });
  it('desktop keys survive PKCS#8 round trip; phone keys are non-extractable', async () => {
    const w = await world();
    const s = await serializeDeviceKeys(w.ownerKeys);
    const back = await deserializeDeviceKeys(s);
    const sig = await signString(back.signing.privateKey, 'x');
    expect(await verifyString(await importSigningPublicKey(w.ownerSigningPub), 'x', sig)).toBe(
      true,
    );
    await expect(serializeDeviceKeys(w.phoneKeys)).rejects.toThrow();
    expect((await fingerprint(w.ownerSigningPub)).split(' ')).toHaveLength(8);
  });
});

describe('certificates and grants', () => {
  it('owner issues a phone cert; phone verifies against the pinned owner key', async () => {
    const w = await world();
    const cert = await issueDeviceCert({
      issuerDeviceId: w.ownerId,
      issuerSigningKey: w.ownerKeys.signing.privateKey,
      installationId: INST,
      deviceId: w.phoneId,
      role: 'phone',
      label: 'iPhone',
      signingPub: w.phoneSigningPub,
      exchangePub: w.phoneExchangePub,
    });
    expect(CertSchema.safeParse(cert).success).toBe(true);
    expect(await verifyDeviceCert(cert, w.ownerKeys.signing.publicKey)).toBe(true);
    expect(
      await verifyDeviceCert({ ...cert, role: 'owner-desktop' }, w.ownerKeys.signing.publicKey),
    ).toBe(false);
    const own = await issueDeviceCert({
      issuerDeviceId: w.ownerId,
      issuerSigningKey: w.ownerKeys.signing.privateKey,
      installationId: INST,
      deviceId: w.ownerId,
      role: 'owner-desktop',
      label: 'Mac',
      signingPub: w.ownerSigningPub,
      exchangePub: w.ownerExchangePub,
    });
    expect(await verifySelfSignedCert(own)).toBe(true);
  });
  it('epoch grant opens only for the intended device and verified issuer', async () => {
    const w = await world();
    const grant = await createEpochGrant({
      issuerDeviceId: w.ownerId,
      issuerSigningKey: w.ownerKeys.signing.privateKey,
      installationId: INST,
      recipientDeviceId: w.phoneId,
      recipientExchangePub: w.phoneExchangePub,
      epoch: 1,
      epochKeyRaw: w.epochRaw,
    });
    expect(GrantSchema.safeParse(grant).success).toBe(true);
    const opened = await openEpochGrant({
      grant,
      ownerSigningPublicKey: w.ownerKeys.signing.publicKey,
      exchangePrivateKey: w.phoneKeys.exchange.privateKey,
      expectedInstallationId: INST,
      expectedDeviceId: w.phoneId,
    });
    // the phone can now decrypt what the owner encrypts
    const env = await encryptEnvelope({
      epochKey: w.ownerEpoch,
      installationId: INST,
      questionId: 'q'.repeat(10),
      recordId: newId(),
      recordType: 'question',
      revision: 0,
      senderDeviceId: w.ownerId,
      purpose: 'question-content',
      plaintext: { question: 'hi' },
    });
    expect(await decryptEnvelope(env, new Map([[1, opened]]))).toEqual({ question: 'hi' });
    // wrong device key
    const other = await generateDeviceKeys(true);
    await expect(
      openEpochGrant({
        grant,
        ownerSigningPublicKey: w.ownerKeys.signing.publicKey,
        exchangePrivateKey: other.exchange.privateKey,
        expectedInstallationId: INST,
        expectedDeviceId: w.phoneId,
      }),
    ).rejects.toThrow();
    // forged issuer
    await expect(
      openEpochGrant({
        grant,
        ownerSigningPublicKey: other.signing.publicKey,
        exchangePrivateKey: w.phoneKeys.exchange.privateKey,
        expectedInstallationId: INST,
        expectedDeviceId: w.phoneId,
      }),
    ).rejects.toThrow(/signature/);
    // swapped recipient
    await expect(
      openEpochGrant({
        grant,
        ownerSigningPublicKey: w.ownerKeys.signing.publicKey,
        exchangePrivateKey: w.phoneKeys.exchange.privateKey,
        expectedInstallationId: INST,
        expectedDeviceId: newId(),
      }),
    ).rejects.toThrow(/another device/);
    // tampered sealed key breaks the signature
    await expect(
      openEpochGrant({
        grant: { ...grant, sealed: bytesToBase64Url(randomBytes(48)) },
        ownerSigningPublicKey: w.ownerKeys.signing.publicKey,
        exchangePrivateKey: w.phoneKeys.exchange.privateKey,
        expectedInstallationId: INST,
        expectedDeviceId: w.phoneId,
      }),
    ).rejects.toThrow();
    // phone-side epoch key has no raw bytes
    expect(opened.raw).toBeUndefined();
  });
});

describe('envelopes', () => {
  async function sealed() {
    const w = await world();
    const env = await encryptEnvelope({
      epochKey: w.ownerEpoch,
      installationId: INST,
      questionId: 'question01',
      recordId: newId(),
      recordType: 'question',
      revision: 0,
      senderDeviceId: w.ownerId,
      purpose: 'question-content',
      plaintext: { question: 'Use the compact sidebar?', n: 1 },
    });
    return { w, env, keys: new Map([[1, w.ownerEpoch]]) };
  }
  it('round-trips and conforms to the schema', async () => {
    const { env, keys } = await sealed();
    expect(EnvelopeSchema.safeParse(env).success).toBe(true);
    expect(await decryptEnvelope(env, keys, { questionId: 'question01', revision: 0 })).toEqual({
      question: 'Use the compact sidebar?',
      n: 1,
    });
  });
  it('never reuses a nonce and never leaks plaintext', async () => {
    const { w } = await sealed();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const e = await encryptEnvelope({
        epochKey: w.ownerEpoch,
        installationId: INST,
        questionId: 'question01',
        recordId: newId(),
        recordType: 'question',
        revision: 0,
        senderDeviceId: w.ownerId,
        purpose: 'question-content',
        plaintext: { a: 'SECRET-MARKER' },
      });
      seen.add(e.nonce);
      expect(JSON.stringify(e)).not.toContain('SECRET-MARKER');
    }
    expect(seen.size).toBe(200);
  });
  it('fails closed on tampering with any visible field', async () => {
    const { env, keys } = await sealed();
    const bad = [
      { ...env, aad: { ...env.aad, question_id: 'question02' } },
      { ...env, aad: { ...env.aad, revision: 1 } },
      { ...env, aad: { ...env.aad, sender_device_id: 'someoneelse' } },
      { ...env, aad: { ...env.aad, installation_id: 'otherinstall' } },
      { ...env, purpose: 'answer-content' as const },
      { ...env, record_id: newId() },
      { ...env, nonce: bytesToBase64Url(randomBytes(12)) },
      {
        ...env,
        ciphertext: env.ciphertext.slice(0, -2) + (env.ciphertext.endsWith('AA') ? 'BB' : 'AA'),
      },
    ];
    for (const e of bad) await expect(decryptEnvelope(e, keys)).rejects.toThrow();
    await expect(decryptEnvelope(env, keys, { questionId: 'other-question' })).rejects.toThrow(
      /binding/,
    );
    await expect(decryptEnvelope(env, new Map())).rejects.toThrow(/missing epoch key/);
    await expect(decryptEnvelope({ ...env, suite: 'x' } as never, keys)).rejects.toThrow(
      /unsupported/,
    );
  });
  it('signed records bind the exact envelope bytes', async () => {
    const { w, env } = await sealed();
    const q = await buildSignedQuestion({
      installationId: INST,
      questionId: 'question01',
      signerDeviceId: w.ownerId,
      signingKey: w.ownerKeys.signing.privateKey,
      targetHostId: 'host_aaaaaaaa',
      originRef: 'pane_aaaaaaaa',
      requirement: 'human-required',
      expiresAt: null,
      attachmentIds: [],
      envelope: env,
    });
    expect(QuestionSchema.safeParse(q.record).success).toBe(true);
    const pub = w.ownerKeys.signing.publicKey;
    expect(await verifyRecordAndEnvelope(q.record, q.envelope, pub)).toBe(true);
    expect(
      await verifyRecordAndEnvelope(
        q.record,
        { ...env, nonce: bytesToBase64Url(randomBytes(12)) },
        pub,
      ),
    ).toBe(false);
    expect(await verifyRecordAndEnvelope({ ...q.record, requirement: 'proxy-ok' }, env, pub)).toBe(
      false,
    );
    expect(await verifyRecordAndEnvelope(q.record, null, pub)).toBe(false);
    const a = await buildSignedAction({
      installationId: INST,
      questionId: 'question01',
      action: 'cancel',
      signerDeviceId: w.ownerId,
      signingKey: w.ownerKeys.signing.privateKey,
      expectedRevision: 0,
    });
    expect(SignedAction.safeParse(a).success).toBe(true);
    expect(await verifyRecordAndEnvelope(a.record, null, pub)).toBe(true);
    expect(await envelopeDigest(env)).toHaveLength(64);
  });
  it('signed thread messages carry the side and expects_reply and bind the envelope', async () => {
    const w = await world();
    const messageId = newId();
    const env = await encryptEnvelope({
      epochKey: w.ownerEpoch,
      installationId: INST,
      questionId: 'question01',
      recordId: messageId,
      recordType: 'thread.message',
      revision: 0,
      senderDeviceId: w.ownerId,
      purpose: 'message-content',
      plaintext: { content_version: 1, side: 'agent', text: 'Which of the two?' },
    });
    const m = await buildSignedMessage({
      installationId: INST,
      questionId: 'question01',
      messageId,
      side: 'agent',
      expectsReply: true,
      signerDeviceId: w.ownerId,
      signingKey: w.ownerKeys.signing.privateKey,
      envelope: env,
    });
    expect(SignedMessage.safeParse(m).success).toBe(true);
    expect(m.record).toMatchObject({
      type: 'thread.message',
      message_id: messageId,
      side: 'agent',
      expects_reply: true,
      attachment_ids: [],
    });
    const pub = w.ownerKeys.signing.publicKey;
    expect(await verifyRecordAndEnvelope(m.record, m.envelope, pub)).toBe(true);
    expect(await verifyRecordAndEnvelope({ ...m.record, expects_reply: false }, env, pub)).toBe(
      false,
    );
    const quiet = await buildSignedMessage({
      installationId: INST,
      questionId: 'question01',
      messageId,
      side: 'agent',
      signerDeviceId: w.ownerId,
      signingKey: w.ownerKeys.signing.privateKey,
      envelope: env,
    });
    expect(quiet.record.expects_reply).toBe(false);
  });
});

describe('attachments', () => {
  it('encrypts, binds to question/attachment, and detects tampering', async () => {
    const w = await world();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const b = {
      installationId: INST,
      questionId: 'question01',
      attachmentId: 'attach001',
      keyEpoch: 1,
    };
    const enc = await encryptAttachment(w.ownerEpoch, b, png);
    expect(enc.ciphertext.length).toBe(png.length + 16);
    expect(
      await decryptAttachment(w.ownerEpoch, b, enc.nonce, enc.ciphertext, enc.sha256Plaintext),
    ).toEqual(png);
    await expect(
      decryptAttachment(
        w.ownerEpoch,
        { ...b, questionId: 'question02' },
        enc.nonce,
        enc.ciphertext,
      ),
    ).rejects.toThrow();
    await expect(
      decryptAttachment(
        w.ownerEpoch,
        { ...b, attachmentId: 'attach002' },
        enc.nonce,
        enc.ciphertext,
      ),
    ).rejects.toThrow();
    const flipped = enc.ciphertext.slice();
    flipped[3] = flipped[3]! ^ 1;
    await expect(decryptAttachment(w.ownerEpoch, b, enc.nonce, flipped)).rejects.toThrow();
    await expect(
      decryptAttachment(w.ownerEpoch, b, enc.nonce, enc.ciphertext, 'a'.repeat(64)),
    ).rejects.toThrow(/digest/);
  });
});

describe('request signing', () => {
  it('verifies and rejects any changed component', async () => {
    const w = await world();
    const body = JSON.stringify({ a: 1 });
    const { authorization, bodySha256 } = await signRequest({
      method: 'POST',
      path: '/api/v1/x',
      query: 'b=2&a=1',
      body,
      installationId: INST,
      deviceId: w.ownerId,
      signingKey: w.ownerKeys.signing.privateKey,
    });
    const header = parseAuthHeader(authorization)!;
    expect(header).not.toBeNull();
    const base = {
      header,
      method: 'POST',
      path: '/api/v1/x',
      query: 'a=1&b=2',
      bodySha256,
      devicePublicKey: w.ownerKeys.signing.publicKey,
    };
    expect(await verifyRequestSignature(base)).toBe(true);
    expect(await verifyRequestSignature({ ...base, method: 'GET' })).toBe(false);
    expect(await verifyRequestSignature({ ...base, path: '/api/v1/y' })).toBe(false);
    expect(await verifyRequestSignature({ ...base, query: 'a=1&b=3' })).toBe(false);
    expect(await verifyRequestSignature({ ...base, bodySha256: await sha256Hex('other') })).toBe(
      false,
    );
    expect(
      await verifyRequestSignature({ ...base, header: { ...header, ts: header.ts + 1 } }),
    ).toBe(false);
    expect(
      await verifyRequestSignature({ ...base, devicePublicKey: w.phoneKeys.signing.publicKey }),
    ).toBe(false);
  });
});

describe('pairing helpers and recovery', () => {
  it('invite round-trips and digests the secret', async () => {
    const secret = generatePairingSecret();
    expect(secret).toHaveLength(43);
    const p = {
      v: 1 as const,
      o: 'https://x.workers.dev',
      i: INST,
      p: newId(),
      s: secret,
      e: Date.now() + 1000,
      k: 'k',
      d: newId(),
      r: 'phone' as const,
    };
    expect(decodeInvite(inviteUrl(p).split('#')[1]!)).toEqual(p);
    expect(decodeInvite('#' + encodeInvite(p))).toEqual(p);
    expect(await inviteDigest(secret)).toHaveLength(64);
    expect(() => decodeInvite(bytesToBase64Url(new TextEncoder().encode('{"v":2}')))).toThrow();
  });
  it('proof of possession and short code', async () => {
    const w = await world();
    const args = {
      pairingId: newId(),
      deviceId: w.phoneId,
      exchangePub: w.phoneExchangePub,
      signingPub: w.phoneSigningPub,
    };
    const pop = await signPairingPop(w.phoneKeys.signing.privateKey, args);
    expect(await verifyPairingPop(pop, args)).toBe(true);
    expect(await verifyPairingPop(pop, { ...args, exchangePub: w.ownerExchangePub })).toBe(false);
    const code = await pairingShortCode({
      pairingId: args.pairingId,
      signingPub: w.phoneSigningPub,
      exchangePub: w.phoneExchangePub,
    });
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect(
      await pairingShortCode({
        pairingId: args.pairingId,
        signingPub: w.phoneSigningPub,
        exchangePub: w.phoneExchangePub,
      }),
    ).toBe(code);
  });
  it('recovery bundle needs the right passphrase', async () => {
    const f = await encryptRecoveryBundle(
      { secret: 'owner keys' },
      'correct horse battery',
      100_000,
    );
    expect(await decryptRecoveryBundle(f, 'correct horse battery')).toEqual({
      secret: 'owner keys',
    });
    await expect(decryptRecoveryBundle(f, 'wrong passphrase!!')).rejects.toThrow();
    await expect(encryptRecoveryBundle({}, 'short')).rejects.toThrow(/12/);
  });
});
