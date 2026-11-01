import { ApiError, LIMITS, PROTOCOL_VERSION } from '@daintree/decisions-protocol';
import type { Handler } from '../room/types.js';
import { json } from '../util.js';
import { sweepExpired } from './questions.js';
import type { DecisionRoom } from '../decision-room.js';

export const listEvents: Handler = async (room, c) => {
  await sweepExpired(room);
  const params = new URLSearchParams(c.req.query);
  const after = Number(params.get('after') ?? '0');
  const limit = Math.min(
    Math.max(Number(params.get('limit') ?? String(LIMITS.eventPageSize)) || 1, 1),
    LIMITS.eventPageSize,
  );
  if (!Number.isSafeInteger(after) || after < 0)
    throw new ApiError('validation_error', 'bad cursor');
  const rows = (room as unknown as DecisionRoom).eventRows(after, limit + 1);
  const highWater = (room as unknown as DecisionRoom).eventHighWater();
  const page = [];
  let bytes = 0;
  let hasMore = rows.length > limit;
  for (const ev of rows.slice(0, limit)) {
    const size = JSON.stringify(ev).length;
    if (page.length > 0 && bytes + size > LIMITS.eventPageBytes) {
      hasMore = true;
      break;
    }
    page.push(ev);
    bytes += size;
  }
  const next = page.length ? page[page.length - 1]!.seq : after;
  return json(200, {
    protocol_version: PROTOCOL_VERSION,
    from_exclusive: after,
    high_water_seq: highWater,
    events: page,
    next_after: next,
    has_more: hasMore,
  });
};
