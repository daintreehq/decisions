import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  utf8ToBytes,
} from '@daintreehq/decisions-protocol';

export interface SealedBlob {
  iv: Uint8Array;
  ct: Uint8Array;
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/** Device-local AES-GCM key that protects drafts and the outbox at rest. Never extractable. */
export async function generateCacheKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** `label` is bound as AAD so a sealed row cannot be moved to a different record id. */
export async function seal(key: CryptoKey, value: unknown, label: string): Promise<SealedBlob> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: buf(iv), additionalData: buf(utf8ToBytes(label)) },
      key,
      buf(utf8ToBytes(JSON.stringify(value))),
    ),
  );
  return { iv, ct };
}

export async function open<T>(key: CryptoKey, blob: SealedBlob, label: string): Promise<T> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: buf(blob.iv), additionalData: buf(utf8ToBytes(label)) },
    key,
    buf(blob.ct),
  );
  return JSON.parse(bytesToUtf8(new Uint8Array(pt))) as T;
}

/** Raw bytes sealed as they are (a photo), so a megabyte is never inflated through JSON. Same key, same AAD rule. */
export async function sealBytes(
  key: CryptoKey,
  bytes: Uint8Array,
  label: string,
): Promise<SealedBlob> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: buf(iv), additionalData: buf(utf8ToBytes(label)) },
      key,
      buf(bytes),
    ),
  );
  return { iv, ct };
}

export async function openBytes(
  key: CryptoKey,
  blob: SealedBlob,
  label: string,
): Promise<Uint8Array> {
  return new Uint8Array(
    await subtle().decrypt(
      { name: 'AES-GCM', iv: buf(blob.iv), additionalData: buf(utf8ToBytes(label)) },
      key,
      buf(blob.ct),
    ),
  );
}

export { base64UrlToBytes, bytesToBase64Url };
