import {
  base64UrlToBytes,
  bytesToBase64Url,
  PushConfig,
  PushTestResponse,
} from '@daintreehq/decisions-protocol';
import type { Relay } from '../data/relay.js';
import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';

export type PushSupport = { ok: true } | { ok: false; reason: 'ios-not-installed' | 'unsupported' };

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
}

/** On iOS, web push exists only for apps added to the Home Screen (16.4+). Say so instead of failing silently. */
export function pushSupport(): PushSupport {
  if (isIos() && !isStandalone()) return { ok: false, reason: 'ios-not-installed' };
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return { ok: false, reason: 'unsupported' };
  }
  return { ok: true };
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Must be called from a user gesture (a tap). */
export async function enablePush(relay: Relay): Promise<void> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted')
    throw new Error(
      'Notifications were not allowed. You can change this in your browser or system settings.',
    );
  const reg = await navigator.serviceWorker.ready;
  const cfg = PushConfig.parse(await relay.json('GET', '/push/config'));
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(cfg.vapid_public_key) as unknown as BufferSource,
    }));
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh ?? bytesToBase64Url(new Uint8Array(sub.getKey('p256dh')!));
  const auth = json.keys?.auth ?? bytesToBase64Url(new Uint8Array(sub.getKey('auth')!));
  await relay.json('POST', '/push/subscriptions', {
    body: { protocol_version: PROTOCOL_VERSION, endpoint: sub.endpoint, p256dh, auth },
  });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  await sub?.unsubscribe();
}

export async function sendTestPush(relay: Relay) {
  return PushTestResponse.parse(
    await relay.json('POST', '/push/test', { body: { protocol_version: PROTOCOL_VERSION } }),
  );
}
