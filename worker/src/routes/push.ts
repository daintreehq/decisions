import { ApiError, PushSubscribeBody, SettingsBody } from '@daintree/decisions-protocol';
import { newId } from '@daintree/decisions-crypto';
import { sendNotification } from '../jobs/notify.js';
import { isAllowedPushEndpoint } from '../push/webpush.js';
import type { Handler } from '../room/types.js';
import { iso, isoOrNull, json, nowMs } from '../util.js';

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
  const id = await room.tx(() => {
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
        `UPDATE push_subscriptions SET p256dh = ?, auth = ?, enabled = 1, last_error_code = NULL WHERE subscription_id = ?`,
        b.p256dh,
        b.auth,
        existing.subscription_id,
      );
      return existing.subscription_id;
    }
    if (n >= 5) throw new ApiError('forbidden', 'too many push subscriptions for this device');
    const sid = newId();
    room.run(
      `INSERT INTO push_subscriptions (subscription_id, device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      sid,
      auth.deviceId,
      b.endpoint,
      b.p256dh,
      b.auth,
      nowMs(),
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
  }>(
    `SELECT subscription_id, device_id, created_at, last_success_at, last_error_code, enabled FROM push_subscriptions WHERE device_id = ?`,
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
