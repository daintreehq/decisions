import { PushPayload } from '@daintreehq/decisions-protocol';
import type { Room } from '../room/types.js';
import { nowMs } from '../util.js';
import { sendWebPush, type VapidKeys } from '../push/webpush.js';

export interface NotifyResult {
  subscription_id: string;
  status: number | null;
  ok: boolean;
}

export type { PushPayload };

interface SubRow {
  subscription_id: string;
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Sends a generic push to every enabled subscription of paired human devices. The payload is an
 * attention signal only (type and question id): no project, no question text, no answer, no message. It is
 * checked against the protocol's strict `PushPayload` before anything is sent, so no other field can slip in.
 */
export async function sendNotification(
  room: Room,
  payload: PushPayload,
  opts: {
    deviceId?: string;
    topic?: string;
    urgency?: 'normal' | 'high';
    skip?: ReadonlySet<string>;
  } = {},
): Promise<NotifyResult[]> {
  const body = PushPayload.parse(payload);
  const vapid = room.vapid();
  if (!vapid) return [];
  const keys: VapidKeys = { privateJwk: vapid.privateJwk, publicKey: vapid.publicKey };
  const subs = room.q<SubRow>(
    `SELECT s.subscription_id, s.device_id, s.endpoint, s.p256dh, s.auth
     FROM push_subscriptions s JOIN devices d ON d.device_id = s.device_id
     WHERE s.enabled = 1 AND d.revoked_at IS NULL AND d.role IN ('phone','tablet')
       ${opts.deviceId ? 'AND s.device_id = ?' : ''}
     LIMIT 100`,
    ...(opts.deviceId ? [opts.deviceId] : []),
  );
  const results: NotifyResult[] = [];
  for (const sub of subs) {
    if (opts.skip?.has(sub.subscription_id)) continue;
    let status: number | null = null;
    try {
      status = await sendWebPush(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        body,
        keys,
        room.env.PUSH_SUBJECT || room.getMeta('origin') || 'https://localhost',
        { urgency: opts.urgency ?? 'normal', ...(opts.topic ? { topic: opts.topic } : {}) },
      );
    } catch {
      status = null;
    }
    const ok = status !== null && status >= 200 && status < 300;
    if (ok) {
      room.run(
        `UPDATE push_subscriptions SET last_success_at = ?, last_error_code = NULL WHERE subscription_id = ?`,
        nowMs(),
        sub.subscription_id,
      );
    } else if (status === 404 || status === 410) {
      room.run(
        `UPDATE push_subscriptions SET enabled = 0, last_error_code = 'gone' WHERE subscription_id = ?`,
        sub.subscription_id,
      );
    } else {
      room.run(
        `UPDATE push_subscriptions SET last_error_code = ? WHERE subscription_id = ?`,
        status === null ? 'network' : `http_${status}`,
        sub.subscription_id,
      );
    }
    results.push({ subscription_id: sub.subscription_id, status, ok });
  }
  return results;
}
