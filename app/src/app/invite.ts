import type { PairingInvitePayload } from '@daintreehq/decisions-protocol';
import { decodeInvite } from '@daintreehq/decisions-crypto';

let pending: { invite?: PairingInvitePayload; error?: string } | null = null;

/**
 * Called once at startup. The invite lives in the URL fragment (never sent to a server); it is read into
 * memory and removed from the address bar and history immediately so it cannot leak via sharing or back/forward.
 */
export function captureInviteFromLocation(): void {
  if (location.pathname !== '/pair' || location.hash.length < 2) return;
  try {
    pending = { invite: decodeInvite(location.hash) };
  } catch {
    pending = { error: 'This pairing link is not valid.' };
  }
  history.replaceState(null, '', '/pair');
}

export function setPendingInvite(invite: PairingInvitePayload): void {
  pending = { invite };
}

export function peekPendingInvite() {
  return pending;
}

export function clearPendingInvite(): void {
  pending = null;
}

/** Accepts a full pairing URL or bare fragment, as scanned from a QR code or pasted. */
export function parseInviteText(text: string, expectedOrigin: string): PairingInvitePayload {
  const t = text.trim();
  let fragment = t;
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    if (u.origin !== expectedOrigin) throw new Error('This QR code belongs to a different relay.');
    fragment = u.hash;
  }
  return decodeInvite(fragment);
}
