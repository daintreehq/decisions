import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalize,
  utf8ToBytes,
  type PairingInvitePayload,
} from '@daintreehq/decisions-protocol';
import { randomBytes, sha256, sha256Hex } from './util.js';

export function generatePairingSecret(): string {
  return bytesToBase64Url(randomBytes(32));
}

export async function inviteDigest(secretB64: string): Promise<string> {
  return sha256Hex(base64UrlToBytes(secretB64));
}

export function encodeInvite(p: PairingInvitePayload): string {
  return bytesToBase64Url(utf8ToBytes(JSON.stringify(p)));
}

export function decodeInvite(fragment: string): PairingInvitePayload {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const p = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw))) as PairingInvitePayload;
  if (p.v !== 1 || !p.o || !p.i || !p.p || !p.s || !p.k || !p.d || !p.e)
    throw new Error('invalid invite');
  return p;
}

export function inviteUrl(p: PairingInvitePayload): string {
  return `${p.o.replace(/\/$/, '')}/pair#${encodeInvite(p)}`;
}

/**
 * Six-digit short authentication string both sides display so the owner can confirm the
 * candidate device is the phone in their hand (defeats a stolen / forwarded QR).
 */
export async function pairingShortCode(p: {
  pairingId: string;
  signingPub: string;
  exchangePub: string;
}): Promise<string> {
  const h = await sha256(
    canonicalize({
      t: 'pairing.sas',
      pairing_id: p.pairingId,
      signing_pub: p.signingPub,
      exchange_pub: p.exchangePub,
    }),
  );
  const n = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  const s = String(n % 1_000_000).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
