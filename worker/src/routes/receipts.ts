import { ApiError } from '@daintree/decisions-protocol';
import type { Room } from '../room/types.js';
import { nowMs, type ApiResponse } from '../util.js';

/**
 * Device-scoped idempotency for commands. Runs `fn` at most once per (device, key): a repeat with an
 * identical body returns the original response; a repeat with a different body is a collision.
 * Must be called inside `room.tx`.
 */
export function withReceipt(
  room: Room,
  deviceId: string,
  key: string,
  digest: string,
  fn: () => ApiResponse,
): ApiResponse {
  const hit = room.q1<{ request_digest: string; status: number; response_json: string }>(
    `SELECT request_digest, status, response_json FROM command_receipts WHERE device_id = ? AND idempotency_key = ?`,
    deviceId,
    key,
  );
  if (hit) {
    if (hit.request_digest !== digest) {
      throw new ApiError('idempotency_collision', 'idempotency key reused with a different body');
    }
    return { status: hit.status, body: hit.response_json };
  }
  const res = fn();
  room.run(
    `INSERT INTO command_receipts (device_id, idempotency_key, request_digest, status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    deviceId,
    key,
    digest,
    res.status,
    res.body,
    nowMs(),
  );
  return res;
}
