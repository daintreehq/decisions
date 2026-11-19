import { PushPayload } from '@daintreehq/decisions-protocol';
import type { Room } from '../room/types.js';
import { nowMs } from '../util.js';
import { DEFAULT_PUSH_TTL_SECONDS, sendWebPush, type VapidKeys } from '../push/webpush.js';

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
 * The subscriptions a push of `type` may go to: enabled ones of paired phones and tablets. An `agent-stopped` push
 * also needs an endpoint that declared it can show one (docs/protocol.md section 11): a service worker that does
 * not know the type would show it as a new question.
 */
function eligible(type: PushPayload['type']): string {
  return `s.enabled = 1 AND d.revoked_at IS NULL AND d.role IN ('phone','tablet')${
    type === 'agent-stopped' ? ' AND s.agent_stopped_capable = 1' : ''
  }`;
}

const SUB_FROM = `SELECT s.subscription_id, s.device_id, s.endpoint, s.p256dh, s.auth
     FROM push_subscriptions s JOIN devices d ON d.device_id = s.device_id`;

/**
 * The TTL a push sent at `now` carries: `max` seconds, cut to the whole seconds left before `until` for a push that
 * is no use after it (docs/protocol.md section 11). Null when not a second is left: such a push is not sent.
 */
export function pushTtlSeconds(
  now: number,
  until: number | null | undefined,
  max = DEFAULT_PUSH_TTL_SECONDS,
): number | null {
  if (until == null) return max;
  const left = Math.floor((until - now) / 1000);
  return left >= 1 ? Math.min(max, left) : null;
}

/** How many subscriptions a push of `type` would go to now. */
export function eligibleSubscriptionCount(room: Room, type: PushPayload['type']): number {
  return room.q1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM push_subscriptions s JOIN devices d ON d.device_id = s.device_id WHERE ${eligible(type)}`,
  )!.n;
}

/**
 * Sends a generic push to every eligible subscription (`eligible`). The payload is an attention signal only (a
 * type, and a question id for a question's push): no project, no question text, no answer, no message. It is
 * checked against the protocol's strict `PushPayload` before anything is sent, so no other field can slip in.
 * `usefulUntil` (relay epoch ms) ends the push's lifetime: each send's TTL runs out by then (`pushTtlSeconds`).
 * `wanted` is asked before each send; once it says no, the rest of the list gets nothing.
 */
export async function sendNotification(
  room: Room,
  payload: PushPayload,
  opts: {
    deviceId?: string;
    topic?: string;
    urgency?: 'normal' | 'high';
    ttlSeconds?: number;
    usefulUntil?: number | null;
    wanted?: () => boolean;
    skip?: ReadonlySet<string>;
  } = {},
): Promise<NotifyResult[]> {
  const body = PushPayload.parse(payload);
  const vapid = room.vapid();
  if (!vapid) return [];
  const keys: VapidKeys = { privateJwk: vapid.privateJwk, publicKey: vapid.publicKey };
  const where = eligible(body.type);
  const subs = room.q<SubRow>(
    `${SUB_FROM}
     WHERE ${where}
       ${opts.deviceId ? 'AND s.device_id = ?' : ''}
     LIMIT 100`,
    ...(opts.deviceId ? [opts.deviceId] : []),
  );
  const results: NotifyResult[] = [];
  for (const listed of subs) {
    if (opts.skip?.has(listed.subscription_id)) continue;
    // Each send awaits, and meanwhile an endpoint further down the list may have been subscribed again (new keys,
    // or a declaration withdrawn by an older app, under a new id if it was removed first), disabled or revoked:
    // read the device's row for it again just before sending.
    const sub = room.q1<SubRow>(
      `${SUB_FROM} WHERE s.device_id = ? AND s.endpoint = ? AND ${where}`,
      listed.device_id,
      listed.endpoint,
    );
    if (!sub || opts.skip?.has(sub.subscription_id)) continue;
    // Every send awaits, so the time left is worked out again for each one. Once it has run out, or the push is no
    // longer wanted, no endpoint further down the list gets it either, and none is counted as failed.
    const ttlSeconds = pushTtlSeconds(nowMs(), opts.usefulUntil, opts.ttlSeconds);
    if (ttlSeconds === null || opts.wanted?.() === false) break;
    let status: number | null = null;
    try {
      status = await sendWebPush(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        body,
        keys,
        room.env.PUSH_SUBJECT || room.getMeta('origin') || 'https://localhost',
        {
          urgency: opts.urgency ?? 'normal',
          ttlSeconds,
          ...(opts.topic ? { topic: opts.topic } : {}),
        },
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
