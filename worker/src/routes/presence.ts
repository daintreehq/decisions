import { LIMITS, PresenceBody, type PresenceResponse } from '@daintreehq/decisions-protocol';
import { PRESENCE_META } from '../room/presence.js';
import type { Handler } from '../room/types.js';
import { iso, json, nowMs, type ApiResponse } from '../util.js';

/*
 * `PUT /presence` (owner desktop, docs/protocol.md section 11). `present: true` starts or renews the lease for
 * `presenceLeaseMs` from relay time; `false` ends it. The relay keeps only the lease's end: no history, no event
 * and no push. A renewed lease never extends a hold already counting (`room/presence.ts`).
 */
export const putPresence: Handler = async (room, c) => {
  const auth = c.auth!;
  const body = c.body(PresenceBody);
  return room.tx((): ApiResponse => {
    room.assertActive(auth.deviceId);
    if (!body.present) {
      room.run(`DELETE FROM meta WHERE key = ?`, PRESENCE_META);
      return json(200, { present: false, until: null } satisfies PresenceResponse);
    }
    const until = nowMs() + LIMITS.presenceLeaseMs;
    room.setMeta(PRESENCE_META, String(until));
    return json(200, { present: true, until: iso(until) } satisfies PresenceResponse);
  });
};
