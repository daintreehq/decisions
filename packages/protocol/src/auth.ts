import { canonicalize } from './canonical.js';
import { PROTOCOL_VERSION } from './version.js';

/**
 * Every authenticated request carries:
 *   Authorization: Decisions-Sig v=1,i=<installation>,d=<device>,t=<epoch ms>,n=<nonce>,s=<sig b64url>
 *
 * The signature (ECDSA P-256 / SHA-256, IEEE P1363 r||s encoding) is over the UTF-8 bytes of
 * canonicalize({ v, method, path, query, body_sha256, installation_id, device_id, ts, nonce }).
 * `query` is the raw query string without the leading "?" with parameters sorted by key then value.
 */
export const AUTH_SCHEME = 'Decisions-Sig';

export interface RequestSigningInput {
  method: string;
  path: string;
  query: string;
  bodySha256: string;
  installationId: string;
  deviceId: string;
  ts: number;
  nonce: string;
}

export function normalizeQuery(search: string | URLSearchParams): string {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  params.forEach((v, k) => {
    // Duplicate keys make "first value" vs "last value" interpretation diverge between signer and
    // verifier while normalising to identical signing bytes, so they are rejected outright.
    if (seen.has(k)) throw new Error('duplicate query parameter');
    seen.add(k);
    pairs.push([k, v]);
  });
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export function requestSigningString(i: RequestSigningInput): string {
  return canonicalize({
    v: PROTOCOL_VERSION,
    method: i.method.toUpperCase(),
    path: i.path,
    query: i.query,
    body_sha256: i.bodySha256,
    installation_id: i.installationId,
    device_id: i.deviceId,
    ts: i.ts,
    nonce: i.nonce,
  });
}

export interface ParsedAuthHeader {
  v: number;
  installationId: string;
  deviceId: string;
  ts: number;
  nonce: string;
  signature: string;
}

export function formatAuthHeader(h: ParsedAuthHeader): string {
  return `${AUTH_SCHEME} v=${h.v},i=${h.installationId},d=${h.deviceId},t=${h.ts},n=${h.nonce},s=${h.signature}`;
}

export function parseAuthHeader(header: string | null | undefined): ParsedAuthHeader | null {
  if (!header || !header.startsWith(AUTH_SCHEME + ' ')) return null;
  const rest = header.slice(AUTH_SCHEME.length + 1);
  const fields: Record<string, string> = {};
  for (const part of rest.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 1) return null;
    fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const { v, i, d, t, n, s } = fields;
  if (!v || !i || !d || !t || !n || !s) return null;
  const ver = Number(v);
  const ts = Number(t);
  if (!Number.isInteger(ver) || !Number.isSafeInteger(ts)) return null;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(i) || !/^[A-Za-z0-9_-]{8,64}$/.test(d)) return null;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(n) || !/^[A-Za-z0-9_-]{86}$/.test(s)) return null;
  return { v: ver, installationId: i, deviceId: d, ts, nonce: n, signature: s };
}

/** Canonical bytes a candidate signs to prove possession of its signing key during pairing. */
export function pairingPopString(p: {
  pairingId: string;
  deviceId: string;
  exchangePub: string;
  signingPub: string;
}): string {
  return canonicalize({
    v: PROTOCOL_VERSION,
    type: 'pairing.pop',
    pairing_id: p.pairingId,
    device_id: p.deviceId,
    exchange_pub: p.exchangePub,
    signing_pub: p.signingPub,
  });
}

/** Payload placed in the QR code URL fragment: https://<origin>/pair#<base64url(JSON)> */
export interface PairingInvitePayload {
  v: 1;
  /** relay origin */
  o: string;
  /** installation id */
  i: string;
  /** pairing id */
  p: string;
  /** one-time 256-bit secret, base64url */
  s: string;
  /** expiry, epoch ms */
  e: number;
  /** owner signing public key, base64url */
  k: string;
  /** owner device id */
  d: string;
  /** role the new device will receive */
  r: 'phone' | 'tablet';
}
