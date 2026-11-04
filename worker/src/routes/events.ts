import {
  ApiError,
  FEATURES_QUERY_PARAM,
  FeatureList,
  LIMITS,
  knownFeatures,
} from '@daintreehq/decisions-protocol';
import type { Handler } from '../room/types.js';
import { json } from '../util.js';
import { sweepExpired } from './questions.js';

/**
 * `GET /events?after=&limit=&features=`. The page holds only the events the request's declared features allow
 * (docs/protocol.md section 19): a request without `features`, which is every 0.3.0 client, gets the 0.3.0
 * baseline whatever the device declared before.
 */
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
  const declared = params.get(FEATURES_QUERY_PARAM);
  const tokens = declared ? declared.split(',') : [];
  if (!FeatureList.safeParse(tokens).success)
    throw new ApiError('validation_error', 'bad features declaration');
  return json(200, room.eventsPage(after, knownFeatures(tokens), limit, LIMITS.eventPageBytes));
};
