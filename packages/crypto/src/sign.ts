import {
  base64UrlToBytes,
  bytesToBase64Url,
  signingString,
  utf8ToBytes,
} from '@daintreehq/decisions-protocol';
import { buf, subtle } from './util.js';

const ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** ECDSA P-256 / SHA-256. WebCrypto returns IEEE P1363 (r||s, 64 bytes) in every runtime. */
export async function signString(privateKey: CryptoKey, message: string): Promise<string> {
  const sig = new Uint8Array(await subtle.sign(ALG, privateKey, buf(utf8ToBytes(message))));
  return bytesToBase64Url(sig);
}

export async function verifyString(
  publicKey: CryptoKey,
  message: string,
  signatureB64: string,
): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = base64UrlToBytes(signatureB64);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return subtle.verify(ALG, publicKey, buf(sig), buf(utf8ToBytes(message)));
}

/** Sign any object (cert, grant, record) over its canonical form minus `signature`. */
export async function signObject<T extends Record<string, unknown>>(
  privateKey: CryptoKey,
  obj: T,
): Promise<T & { signature: string }> {
  const signature = await signString(privateKey, signingString(obj));
  return { ...obj, signature };
}

export async function verifyObject(
  publicKey: CryptoKey,
  obj: { signature?: unknown; [k: string]: unknown },
): Promise<boolean> {
  if (typeof obj.signature !== 'string') return false;
  return verifyString(publicKey, signingString(obj), obj.signature);
}
