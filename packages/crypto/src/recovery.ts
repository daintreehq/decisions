import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  utf8ToBytes,
} from '@daintree/decisions-protocol';
import { buf, randomBytes, subtle, type Usage } from './util.js';

export interface RecoveryBundleFile {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export const RECOVERY_KDF_ITERATIONS = 600_000;

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number, usage: Usage[]) {
  const base = await subtle.importKey(
    'raw',
    buf(utf8ToBytes(passphrase.normalize('NFKC'))),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

/**
 * Passphrase-protected owner recovery kit (owner keys + epoch keys). PBKDF2-SHA256 is used because it is
 * available in every WebCrypto runtime; the passphrase policy (>= 12 chars) is enforced here.
 */
export async function encryptRecoveryBundle(
  secret: unknown,
  passphrase: string,
  iterations = RECOVERY_KDF_ITERATIONS,
): Promise<RecoveryBundleFile> {
  if (passphrase.length < 12) throw new Error('recovery passphrase must be at least 12 characters');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(passphrase, salt, iterations, ['encrypt']);
  const ct = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: buf(nonce),
        additionalData: buf(utf8ToBytes('decisions/v1/recovery')),
      },
      key,
      buf(utf8ToBytes(JSON.stringify(secret))),
    ),
  );
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: bytesToBase64Url(salt),
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(ct),
  };
}

export async function decryptRecoveryBundle<T = unknown>(
  file: RecoveryBundleFile,
  passphrase: string,
): Promise<T> {
  if (file.v !== 1 || file.kdf !== 'PBKDF2-SHA256' || file.iterations < 100_000) {
    throw new Error('unsupported recovery bundle');
  }
  const key = await deriveKey(passphrase, base64UrlToBytes(file.salt), file.iterations, [
    'decrypt',
  ]);
  try {
    const pt = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buf(base64UrlToBytes(file.nonce)),
        additionalData: buf(utf8ToBytes('decisions/v1/recovery')),
      },
      key,
      buf(base64UrlToBytes(file.ciphertext)),
    );
    return JSON.parse(bytesToUtf8(new Uint8Array(pt))) as T;
  } catch {
    throw new Error('wrong passphrase or corrupted recovery bundle');
  }
}
