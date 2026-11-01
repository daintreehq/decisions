/** Platform-neutral byte helpers (browser, Node, Workers). No Buffer, no atob/btoa quirks. */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i++) B64URL_LOOKUP[B64URL.charAt(i)] = i;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

export function base64UrlToBytes(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error('invalid base64url');
  if (input.length % 4 === 1) throw new Error('invalid base64url length');
  const out = new Uint8Array(Math.floor((input.length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < input.length; i += 4) {
    const n =
      (B64URL_LOOKUP[input[i]!]! << 18) |
      (B64URL_LOOKUP[input[i + 1]!]! << 12) |
      (B64URL_LOOKUP[input[i + 2]!]! << 6) |
      B64URL_LOOKUP[input[i + 3]!]!;
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rem = input.length - i;
  if (rem === 2) {
    // Canonical encoding only: unused trailing bits must be zero (RFC 4648 section 3.5),
    // otherwise two different strings decode to the same bytes (signature malleability).
    if ((B64URL_LOOKUP[input[i + 1]!]! & 15) !== 0) throw new Error('non-canonical base64url');
    const n = (B64URL_LOOKUP[input[i]!]! << 18) | (B64URL_LOOKUP[input[i + 1]!]! << 12);
    out[o++] = (n >> 16) & 255;
  } else if (rem === 3) {
    if ((B64URL_LOOKUP[input[i + 2]!]! & 3) !== 0) throw new Error('non-canonical base64url');
    const n =
      (B64URL_LOOKUP[input[i]!]! << 18) |
      (B64URL_LOOKUP[input[i + 1]!]! << 12) |
      (B64URL_LOOKUP[input[i + 2]!]! << 6);
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8ToBytes = (s: string): Uint8Array => encoder.encode(s);
export const bytesToUtf8 = (b: Uint8Array): string => decoder.decode(b);

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Constant-time equality for equal-purpose secrets/digests. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function utf8ByteLength(s: string): number {
  return encoder.encode(s).length;
}
