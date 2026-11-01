import { bytesToHex, utf8ToBytes } from '@daintree/decisions-protocol';

export const subtle: SubtleCrypto = globalThis.crypto.subtle;

/** TS 5.9 distinguishes Uint8Array<ArrayBufferLike> from BufferSource; WebCrypto accepts both at runtime. */
export const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? utf8ToBytes(data) : data;
  return new Uint8Array(await subtle.digest('SHA-256', buf(bytes)));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256(data));
}

/** UUIDv7-style sortable id (48-bit ms timestamp + 74 random bits), formatted as 32 hex chars, no dashes. */
export function newId(now = Date.now()): string {
  const b = randomBytes(16);
  b[0] = (now / 2 ** 40) & 255;
  b[1] = (now / 2 ** 32) & 255;
  b[2] = (now >>> 24) & 255;
  b[3] = (now >>> 16) & 255;
  b[4] = (now >>> 8) & 255;
  b[5] = now & 255;
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return bytesToHex(b);
}

export const nowIso = (ms = Date.now()): string => new Date(ms).toISOString();
