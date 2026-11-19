import {
  base64UrlToBytes,
  bytesToBase64Url,
  FeatureList,
  PushConfig,
  PushSubscriptionInfo,
  PushTestResponse,
  type ProtocolFeature,
} from '@daintreehq/decisions-protocol';
import { z } from 'zod';
import type { Relay } from '../data/relay.js';
import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import { FEATURES_REQUEST } from '../sw-core.js';

/** The `agent-stopped` push (docs/protocol.md section 11), declared on a subscription whose worker can show it. */
export const AGENT_STOPPED_PUSH: ProtocolFeature = 'agent-stopped-push-v1';

/** How long the service worker has to say what it can show before it counts as unable. */
export const WORKER_ASK_MS = 2_000;

export interface PushFeatureGate {
  /** Whether the relay advertises `agent-stopped-push-v1` in `GET /info`, read again before every declaration. */
  served: () => boolean;
  /** False once the pairing this started under has gone (wipe, revocation, re-pair): nothing more is sent for it. */
  current?: () => boolean;
  timeoutMs?: number;
}

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

/**
 * Whether this phone gets notifications: the browser holds a subscription and the relay still sends
 * to one of its subscriptions. A relay that can't be asked doesn't turn a subscription off.
 */
export async function pushIsOn(relay: Relay | null): Promise<boolean> {
  if (!(await currentSubscription())) return false;
  if (!relay) return true;
  try {
    const { subscriptions } = SubscriptionList.parse(
      await relay.json('GET', '/push/subscriptions'),
    );
    return subscriptions.some((s) => s.enabled);
  } catch {
    return true;
  }
}

/**
 * The registration's active worker, when it says it can show an `agent-stopped` push; null when it can't, can't be
 * asked or doesn't answer in time. Only the active worker counts: it is the one pushes are delivered to, and a page
 * can be a newer build than it while the newer worker waits. The caller checks it is still active before declaring.
 */
export async function agentStoppedWorker(
  reg: ServiceWorkerRegistration,
  timeoutMs = WORKER_ASK_MS,
): Promise<ServiceWorker | null> {
  const worker = reg.active;
  if (!worker) return null;
  return (await askFeatures(worker, timeoutMs)).includes(AGENT_STOPPED_PUSH) ? worker : null;
}

const WorkerFeatures = z.object({ features: FeatureList });

/** What a worker says it can show. An older build never answers, so silence, like a malformed reply, is nothing. */
function askFeatures(worker: ServiceWorker, timeoutMs: number): Promise<readonly string[]> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const settle = (features: readonly string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.onmessageerror = null;
      channel.port1.close();
      resolve(features);
    };
    const timer = setTimeout(() => settle([]), timeoutMs);
    channel.port1.onmessage = (e: MessageEvent) => {
      const r = WorkerFeatures.safeParse(e.data);
      settle(r.success ? r.data.features : []);
    };
    channel.port1.onmessageerror = () => settle([]);
    try {
      worker.postMessage({ type: FEATURES_REQUEST }, [channel.port2]);
    } catch {
      channel.port2.close();
      settle([]);
    }
  });
}

/** The fields of a subscription body that name the browser's push subscription. */
function subscriptionBody(sub: PushSubscription) {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh ?? bytesToBase64Url(new Uint8Array(sub.getKey('p256dh')!));
  const auth = json.keys?.auth ?? bytesToBase64Url(new Uint8Array(sub.getKey('auth')!));
  return { protocol_version: PROTOCOL_VERSION, endpoint: sub.endpoint, p256dh, auth };
}

/**
 * The `features` a subscription declares: the `agent-stopped` push only when the relay advertises it and the worker
 * that said it can show one is still the active worker. A relay that doesn't advertise it is never sent the field.
 */
function declared(
  reg: ServiceWorkerRegistration,
  worker: ServiceWorker | null,
  gate: PushFeatureGate,
): { features?: ProtocolFeature[] } {
  return worker && reg.active === worker && gate.served() ? { features: [AGENT_STOPPED_PUSH] } : {};
}

const notificationsGranted = () =>
  typeof Notification !== 'undefined' && Notification.permission === 'granted';

/**
 * Declare the `agent-stopped` push on the subscription this browser already has, for an app updated in place: the
 * person doesn't turn notifications on again. It never asks for permission, subscribes or removes anything.
 *
 * Re-sending a subscription turns its relay row back on, and rows name no endpoint, so it declares only when none
 * is disabled (a dead row may be this browser's; turning notifications on again in Settings replaces it) and one
 * doesn't declare yet. The worker is asked first, so the rows are read just before the send: a push service that
 * reports this endpoint gone while the worker answers is seen, not undone. Resolves true when it declared.
 */
export async function declareAgentStoppedPush(
  relay: Relay,
  reg: ServiceWorkerRegistration,
  gate: PushFeatureGate,
): Promise<boolean> {
  const current = gate.current ?? (() => true);
  if (!gate.served() || !notificationsGranted()) return false;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return false;
  const worker = await agentStoppedWorker(reg, gate.timeoutMs);
  if (!worker || !current()) return false;
  const { subscriptions } = SubscriptionList.parse(await relay.json('GET', '/push/subscriptions'));
  if (subscriptions.some((s) => !s.enabled)) return false;
  // No rows at all means the relay holds none for this phone: nothing to declare, and no new row to make.
  if (subscriptions.every((s) => s.features?.includes(AGENT_STOPPED_PUSH))) return false;
  const now = await reg.pushManager.getSubscription();
  const features = declared(reg, worker, gate);
  if (!features.features || now?.endpoint !== sub.endpoint || !current() || !notificationsGranted())
    return false;
  await relay.json('POST', '/push/subscriptions', {
    body: { ...subscriptionBody(sub), ...features },
  });
  return true;
}

/** Must be called from a user gesture (a tap). */
export async function enablePush(relay: Relay, gate: PushFeatureGate): Promise<void> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted')
    throw new Error(
      'Notifications were not allowed. You can change this in your browser or system settings.',
    );
  const reg = await navigator.serviceWorker.ready;
  const cfg = PushConfig.parse(await relay.json('GET', '/push/config'));
  // The push service said a subscription of this phone no longer exists. Sending the browser's
  // current one again would only turn the dead endpoint back on, so it is replaced.
  const { subscriptions } = SubscriptionList.parse(await relay.json('GET', '/push/subscriptions'));
  const gone = subscriptions.filter((s) => !s.enabled && s.last_error_code === 'gone');
  let sub = await reg.pushManager.getSubscription();
  if (sub && gone.length > 0) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(cfg.vapid_public_key) as unknown as BufferSource,
  });
  // Each subscription replaces the endpoint's declaration, so it says what the worker that receives it can show.
  const worker = gate.served() ? await agentStoppedWorker(reg, gate.timeoutMs) : null;
  if (gate.current && !gate.current()) return;
  await relay.json('POST', '/push/subscriptions', {
    body: { ...subscriptionBody(sub), ...declared(reg, worker, gate) },
  });
  // The dead ones count toward the relay's cap of subscriptions per phone.
  for (const dead of gone) {
    await relay
      .json('DELETE', `/push/subscriptions/${dead.subscription_id}`)
      .catch(() => undefined);
  }
}

const SubscriptionList = z.object({ subscriptions: z.array(PushSubscriptionInfo) });

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  await sub?.unsubscribe();
}

export async function sendTestPush(relay: Relay) {
  return PushTestResponse.parse(
    await relay.json('POST', '/push/test', { body: { protocol_version: PROTOCOL_VERSION } }),
  );
}
