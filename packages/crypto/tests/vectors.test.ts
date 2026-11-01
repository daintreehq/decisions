import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalize,
  envelopeAadString,
  utf8ToBytes,
} from '@daintree/decisions-protocol';
import {
  decryptEnvelope,
  encryptEnvelope,
  exportPublicKey,
  generateDeviceKeys,
  importEpochKey,
  importSigningPublicKey,
  signString,
  verifyString,
  type EpochKey,
} from '../src/index.js';

/**
 * Cross-runtime vectors. The same fixture file must verify in the browser (PWA test suite),
 * Node (desktop) and workerd (relay). Regenerate only deliberately: WRITE_VECTORS=1 pnpm test.
 */
const FILE = fileURLToPath(new URL('../fixtures/vectors.json', import.meta.url));

interface Vectors {
  canonical: { input: unknown; expected: string }[];
  signature: { signing_pub: string; message: string; signature: string };
  envelope: {
    epoch_key: string;
    nonce: string;
    envelope: unknown;
    plaintext: unknown;
    aad_string: string;
  };
}

async function generate(): Promise<Vectors> {
  const keys = await generateDeviceKeys(true);
  const message = canonicalize({ b: 1, a: [true, null, 'é'] });
  const epochRaw = base64UrlToBytes('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
  const epoch: EpochKey = await importEpochKey(epochRaw, 1, false);
  const nonce = base64UrlToBytes('AQIDBAUGBwgJCgsM');
  const plaintext = {
    question: 'Ship the compact sidebar? 🚀',
    options: [{ id: 'yes', label: 'Yes' }],
  };
  const envelope = await encryptEnvelope({
    epochKey: epoch,
    installationId: 'inst-vector-0001',
    questionId: 'question-vec-0001',
    recordId: 'record-vec-00001',
    recordType: 'question',
    revision: 0,
    senderDeviceId: 'device-vec-00001',
    purpose: 'question-content',
    plaintext,
    _testNonce: nonce,
  });
  return {
    canonical: [
      { input: { b: 1, a: 2 }, expected: '{"a":2,"b":1}' },
      {
        input: { '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4 },
        expected: '{"\\r":2,"1":4,"\u20ac":1,"\ufb33":3}',
      },
      { input: [1e21, 0.000001, -0, 4.5], expected: '[1e+21,0.000001,0,4.5]' },
    ],
    signature: {
      signing_pub: await exportPublicKey(keys.signing.publicKey),
      message,
      signature: await signString(keys.signing.privateKey, message),
    },
    envelope: {
      epoch_key: bytesToBase64Url(epochRaw),
      nonce: bytesToBase64Url(nonce),
      envelope,
      plaintext,
      aad_string: envelopeAadString(envelope),
    },
  };
}

describe('cross-runtime vectors', () => {
  it('fixture file verifies', async () => {
    if (process.env.WRITE_VECTORS === '1' || !existsSync(FILE)) {
      writeFileSync(FILE, JSON.stringify(await generate(), null, 2) + '\n');
    }
    const v = JSON.parse(readFileSync(FILE, 'utf8')) as Vectors;
    for (const c of v.canonical) expect(canonicalize(c.input)).toBe(c.expected);
    expect(
      await verifyString(
        await importSigningPublicKey(v.signature.signing_pub),
        v.signature.message,
        v.signature.signature,
      ),
    ).toBe(true);
    const epoch = await importEpochKey(base64UrlToBytes(v.envelope.epoch_key), 1, false);
    const env = v.envelope.envelope as Parameters<typeof decryptEnvelope>[0];
    expect(await decryptEnvelope(env, new Map([[1, epoch]]))).toEqual(v.envelope.plaintext);
    expect(envelopeAadString(env)).toBe(v.envelope.aad_string);
    // encryption with the pinned nonce is byte-for-byte reproducible (AES-GCM is deterministic given key+nonce+aad)
    const again = await encryptEnvelope({
      epochKey: epoch,
      installationId: env.aad.installation_id,
      questionId: env.aad.question_id,
      recordId: env.record_id,
      recordType: env.aad.record_type,
      revision: env.aad.revision,
      senderDeviceId: env.aad.sender_device_id,
      purpose: env.purpose,
      plaintext: v.envelope.plaintext,
      _testNonce: base64UrlToBytes(v.envelope.nonce),
    });
    expect(again).toEqual(env);
    expect(utf8ToBytes(v.envelope.aad_string).length).toBeGreaterThan(0);
  });
});
