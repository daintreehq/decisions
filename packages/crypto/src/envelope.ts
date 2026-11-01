import {
  CRYPTO_SUITE,
  CRYPTO_VERSION,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  envelopeAadString,
  envelopeDigestInput,
  envelopeKeyInfo,
  utf8ToBytes,
  type CryptoEnvelope,
  type EnvelopePurpose,
} from '@daintree/decisions-protocol';
import { buf, randomBytes, sha256Hex, subtle } from './util.js';

/** An installation content key for one epoch. `key` is an HKDF CryptoKey; `raw` only exists where grants are minted. */
export interface EpochKey {
  epoch: number;
  key: CryptoKey;
  raw?: Uint8Array;
}

export function generateEpochKeyBytes(): Uint8Array {
  return randomBytes(32);
}

export async function importEpochKey(
  raw: Uint8Array,
  epoch: number,
  keepRaw: boolean,
): Promise<EpochKey> {
  if (raw.length !== 32) throw new Error('epoch key must be 32 bytes');
  const key = await subtle.importKey('raw', buf(raw), 'HKDF', false, ['deriveKey']);
  return keepRaw ? { epoch, key, raw: new Uint8Array(raw) } : { epoch, key };
}

const HKDF_SALT = utf8ToBytes('decisions/v1');

export async function deriveAesKey(
  epochKey: CryptoKey,
  info: string,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(HKDF_SALT), info: buf(utf8ToBytes(info)) },
    epochKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

export interface EncryptEnvelopeInput {
  epochKey: EpochKey;
  installationId: string;
  questionId: string;
  recordId: string;
  recordType: string;
  revision: number;
  senderDeviceId: string;
  purpose: EnvelopePurpose;
  plaintext: unknown;
  /** Test vectors only. Production code must never pass a nonce. */
  _testNonce?: Uint8Array;
}

export async function encryptEnvelope(i: EncryptEnvelopeInput): Promise<CryptoEnvelope> {
  const base = {
    crypto_version: CRYPTO_VERSION,
    suite: CRYPTO_SUITE,
    key_epoch: i.epochKey.epoch,
    record_id: i.recordId,
    purpose: i.purpose,
    aad: {
      installation_id: i.installationId,
      question_id: i.questionId,
      record_type: i.recordType,
      revision: i.revision,
      sender_device_id: i.senderDeviceId,
    },
  } as const;
  const aesKey = await deriveAesKey(i.epochKey.key, envelopeKeyInfo(base), ['encrypt']);
  const nonce = i._testNonce ?? randomBytes(12);
  const ct = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: buf(nonce),
        additionalData: buf(utf8ToBytes(envelopeAadString(base))),
      },
      aesKey,
      buf(utf8ToBytes(JSON.stringify(i.plaintext))),
    ),
  );
  return { ...base, nonce: bytesToBase64Url(nonce), ciphertext: bytesToBase64Url(ct) };
}

export interface ExpectedBinding {
  installationId?: string;
  questionId?: string;
  recordType?: string;
  revision?: number;
  senderDeviceId?: string;
  purpose?: EnvelopePurpose;
}

/**
 * Decrypt and authenticate an envelope. `expected` pins the visible fields the caller already
 * knows from the enclosing signed record; any mismatch fails closed (never plaintext fallback).
 */
export async function decryptEnvelope<T = unknown>(
  env: CryptoEnvelope,
  epochKeys: ReadonlyMap<number, EpochKey> | ((epoch: number) => EpochKey | undefined),
  expected: ExpectedBinding = {},
): Promise<T> {
  const lookup = typeof epochKeys === 'function' ? epochKeys : (e: number) => epochKeys.get(e);
  if (env.crypto_version !== CRYPTO_VERSION || env.suite !== CRYPTO_SUITE) {
    throw new Error('unsupported crypto version');
  }
  const a = env.aad;
  if (
    (expected.installationId !== undefined && a.installation_id !== expected.installationId) ||
    (expected.questionId !== undefined && a.question_id !== expected.questionId) ||
    (expected.recordType !== undefined && a.record_type !== expected.recordType) ||
    (expected.revision !== undefined && a.revision !== expected.revision) ||
    (expected.senderDeviceId !== undefined && a.sender_device_id !== expected.senderDeviceId) ||
    (expected.purpose !== undefined && env.purpose !== expected.purpose)
  ) {
    throw new Error('envelope binding mismatch');
  }
  const epochKey = lookup(env.key_epoch);
  if (!epochKey) throw new Error(`missing epoch key ${env.key_epoch}`);
  const aesKey = await deriveAesKey(epochKey.key, envelopeKeyInfo(env), ['decrypt']);
  const nonce = base64UrlToBytes(env.nonce);
  if (nonce.length !== 12) throw new Error('invalid nonce');
  let pt: ArrayBuffer;
  try {
    pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(utf8ToBytes(envelopeAadString(env))) },
      aesKey,
      buf(base64UrlToBytes(env.ciphertext)),
    );
  } catch {
    throw new Error('decryption failed');
  }
  return JSON.parse(bytesToUtf8(new Uint8Array(pt))) as T;
}

/** SHA-256 hex over the canonical envelope; this is what signed records commit to. */
export async function envelopeDigest(env: CryptoEnvelope): Promise<string> {
  return sha256Hex(envelopeDigestInput(env));
}
