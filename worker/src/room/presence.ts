import { LIMITS } from '@daintreehq/decisions-protocol';
import type { Room } from './types.js';

/*
 * Presence (docs/protocol.md section 11, `presence-v1`): the owner desktop says the person is at the computer with
 * a lease that lapses unless renewed. While one is current, a question's `decision-new` push waits a bounded time
 * from when its round began, so a question answered at the computer never reaches the phone. A lapsed lease needs
 * nothing done: no job, event or alarm of its own.
 */

/** The `meta` key holding when the current lease ends, relay epoch ms. Only the latest lease is kept. */
export const PRESENCE_META = 'presence_until';

/** When the owner desktop's presence lease ends, or null when none is current at `now`. */
export function presenceLeaseUntil(room: Room, now: number): number | null {
  const until = Number(room.getMeta(PRESENCE_META));
  return Number.isFinite(until) && until > now ? until : null;
}

/**
 * When the question's current round began, in relay time: its latest reopen, or its creation. The hold counts
 * from here, so neither a renewed lease, a retry nor a proxy abstaining can move it.
 */
export function roundStartedAt(room: Room, questionId: string, createdAt: number): number {
  const reopened = room.q1<{ created_at: number }>(
    `SELECT created_at FROM actions WHERE question_id = ? AND action = 'reopen' ORDER BY event_seq DESC LIMIT 1`,
    questionId,
  );
  return reopened?.created_at ?? createdAt;
}

/**
 * Until when a question's `decision-new` push is held because the person is at the computer, or null to send it
 * now: the earlier of the lease's end and `presenceHoldMs` after the question's round began. Without a current
 * lease it reads nothing else.
 */
export function presenceHold(
  room: Room,
  q: { question_id: string; created_at: number },
  now: number,
): number | null {
  const lease = presenceLeaseUntil(room, now);
  if (lease === null) return null;
  const deadline = roundStartedAt(room, q.question_id, q.created_at) + LIMITS.presenceHoldMs;
  return deadline > now ? Math.min(deadline, lease) : null;
}
