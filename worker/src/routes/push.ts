import {
  AgentStoppedPushBody,
  ApiError,
  LIMITS,
  PushSubscribeBody,
  SettingsBody,
  knownFeatures,
  type AgentStoppedPushResponse,
  type ProtocolFeature,
} from '@daintreehq/decisions-protocol';
import { newId } from '@daintreehq/decisions-crypto';
import { eligibleSubscriptionCount, sendNotification } from '../jobs/notify.js';
import { isQuiet } from '../push/quiet-hours.js';
import { isAllowedPushEndpoint } from '../push/webpush.js';
import type { Handler } from '../room/types.js';
import { iso, isoOrNull, json, nowMs } from '../util.js';

const AGENT_STOPPED: ProtocolFeature = 'agent-stopped-push-v1';

/** What an endpoint declared it can show, as the relay applies it (`PushSubscriptionInfo.features`). */
const subscriptionFeatures = (agentStoppedCapable: number | boolean): ProtocolFeature[] =>
  agentStoppedCapable ? [AGENT_STOPPED] : [];

export const pushConfig: Handler = async (room) => {
  const v = room.vapid();
  if (!v) throw new ApiError('not_configured', 'push is not configured');
  return json(200, { vapid_public_key: v.publicKey });
};

export const extraPushHosts = (allow?: string): string[] =>
  (allow ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const subscribe: Handler = async (room, c) => {
  const b = c.body(PushSubscribeBody);
  const auth = c.auth!;
  if (!isAllowedPushEndpoint(b.endpoint, extraPushHosts(room.env.PUSH_ENDPOINT_ALLOW))) {
    throw new ApiError('validation_error', 'push endpoint is not a recognised push service');
  }
  // Every subscription replaces the endpoint's declaration: one from an app that declares nothing clears it.
  const capable = knownFeatures(b.features).has(AGENT_STOPPED) ? 1 : 0;
  /** Adds or refreshes this device's row for the endpoint, inside the caller's transaction. */
  const register = (): string => {
    const n = room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM push_subscriptions WHERE device_id = ?`,
      auth.deviceId,
    )!.n;
    const existing = room.q1<{ subscription_id: string }>(
      `SELECT subscription_id FROM push_subscriptions WHERE device_id = ? AND endpoint = ?`,
      auth.deviceId,
      b.endpoint,
    );
    if (existing) {
      room.run(
        `UPDATE push_subscriptions SET p256dh = ?, auth = ?, enabled = 1, last_error_code = NULL,
           agent_stopped_capable = ? WHERE subscription_id = ?`,
        b.p256dh,
        b.auth,
        capable,
        existing.subscription_id,
      );
      return existing.subscription_id;
    }
    if (n >= 5) throw new ApiError('forbidden', 'too many push subscriptions for this device');
    const sid = newId();
    room.run(
      `INSERT INTO push_subscriptions (subscription_id, device_id, endpoint, p256dh, auth, created_at, agent_stopped_capable)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sid,
      auth.deviceId,
      b.endpoint,
      b.p256dh,
      b.auth,
      nowMs(),
      capable,
    );
    return sid;
  };
  const id = await room.tx(() => {
    const sid = register();
    // The declaration is the endpoint's service worker's, not one device row's: a row this browser left under an
    // earlier pairing that was never revoked follows it too.
    room.run(
      `UPDATE push_subscriptions SET agent_stopped_capable = ? WHERE endpoint = ?`,
      capable,
      b.endpoint,
    );
    return sid;
  });
  return json(201, {
    subscription_id: id,
    device_id: auth.deviceId,
    created_at: iso(nowMs()),
    last_success_at: null,
    last_error_code: null,
    enabled: true,
    features: subscriptionFeatures(capable),
  });
};

export const unsubscribe: Handler = async (room, c) => {
  const id = c.params[0]!;
  const n = room.run(
    `DELETE FROM push_subscriptions WHERE subscription_id = ? AND device_id = ?`,
    id,
    c.auth!.deviceId,
  );
  if (n === 0) throw new ApiError('not_found', 'no such subscription');
  return json(200, { ok: true });
};

export const listSubscriptions: Handler = async (room, c) => {
  const rows = room.q<{
    subscription_id: string;
    device_id: string;
    created_at: number;
    last_success_at: number | null;
    last_error_code: string | null;
    enabled: number;
    agent_stopped_capable: number;
  }>(
    `SELECT subscription_id, device_id, created_at, last_success_at, last_error_code, enabled, agent_stopped_capable
     FROM push_subscriptions WHERE device_id = ?`,
    c.auth!.deviceId,
  );
  return json(200, {
    subscriptions: rows.map((r) => ({
      subscription_id: r.subscription_id,
      device_id: r.device_id,
      created_at: iso(r.created_at),
      last_success_at: isoOrNull(r.last_success_at),
      last_error_code: r.last_error_code,
      enabled: Boolean(r.enabled),
      features: subscriptionFeatures(r.agent_stopped_capable),
    })),
  });
};

export const test: Handler = async (room, c) => {
  room.hit(`pushtest:${c.auth!.deviceId}`, 6, 60_000);
  const results = await sendNotification(
    room,
    { type: 'test' },
    { deviceId: c.auth!.deviceId, topic: 'test' },
  );
  return json(200, {
    attempted: results.length,
    delivered: results.filter((r) => r.ok).length,
    results,
  });
};

/** The `rate_limits` key of the relay-wide `agent-stopped` window. */
export const AGENT_STOPPED_RATE_KEY = 'push:agent-stopped';

/**
 * `POST /push/agent-stopped` (owner desktop, `agent-stopped-push-v1`, docs/protocol.md section 11). The desktop
 * asks only while the person is away, so the presence hold does not apply. Quiet hours drop the request, never
 * defer it, and the relay accepts at most one per `agentStoppedPushWindowMs`, whoever asks. Neither a dropped
 * request nor one with nowhere to go uses the window; an accepted one does, whether or not a push service took it.
 * Every outcome is final (`AgentStoppedPushResponse`): the desktop never retries.
 */
export const agentStopped: Handler = async (room, c) => {
  c.body(AgentStoppedPushBody);
  const done = (outcome: AgentStoppedPushResponse['outcome']) =>
    json(200, { outcome } satisfies AgentStoppedPushResponse);
  if (isQuiet(nowMs(), room.settings().quiet_hours)) return done('quiet-hours');
  if (!room.vapid()) throw new ApiError('not_configured', 'push is not configured');
  if (eligibleSubscriptionCount(room, 'agent-stopped') === 0) return done('no-subscription');
  // Nothing above awaits, so a second request cannot pass this check before the first one has taken the window.
  try {
    room.hit(AGENT_STOPPED_RATE_KEY, 1, LIMITS.agentStoppedPushWindowMs);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'rate_limited') return done('rate-limited');
    throw e;
  }
  const results = await sendNotification(
    room,
    { type: 'agent-stopped' },
    {
      // One topic per endpoint: a newer push replaces one the push service still holds, so a phone that was
      // offline gets one, never a backlog. High urgency, since a phone in Doze holds a normal one past its TTL.
      topic: 'agent-stopped',
      urgency: 'high',
      ttlSeconds: LIMITS.agentStoppedPushTtlSeconds,
    },
  );
  if (results.length === 0) return done('no-subscription');
  return done(results.some((r) => r.ok) ? 'sent' : 'failed');
};

export const getSettings: Handler = async (room) => json(200, { settings: room.settings() });

export const putSettings: Handler = async (room, c) => {
  const b = c.body(SettingsBody);
  const { protocol_version: _v, ...patch } = b;
  const merged = { ...room.settings(), ...patch };
  if (merged.quiet_hours) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: merged.quiet_hours.time_zone });
    } catch {
      throw new ApiError('validation_error', 'unknown time zone');
    }
  }
  await room.tx(() => room.setMeta('settings', JSON.stringify(merged)));
  return json(200, { settings: merged });
};
