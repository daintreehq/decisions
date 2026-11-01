import {
  ApiError,
  DeliveryFailedBody,
  DeliveryReceivedBody,
  DeliveryTerminalBody,
} from '@daintreehq/decisions-protocol';
import { applyAck } from '../room/ack.js';
import type { Handler } from '../room/types.js';
import { json, nowMs } from '../util.js';
import { withReceipt } from './receipts.js';

export const received: Handler = async (room, c) => {
  const b = c.body(DeliveryReceivedBody);
  await room.tx(() => {
    room.assertActive(c.auth!.deviceId);
    applyAck(room, c.auth!.deviceId, b.seq);
  });
  return json(200, { ok: true });
};

export const terminal: Handler = async (room, c) => {
  const b = c.body(DeliveryTerminalBody);
  const auth = c.auth!;
  const digest = await c.bodyDigest();
  return room.tx(() => {
    room.assertActive(auth.deviceId);
    return withReceipt(room, auth.deviceId, b.idempotency_key, digest, () => {
      const d = room.q1<{ status: string; injection_id: string | null }>(
        `SELECT status, injection_id FROM deliveries WHERE question_id = ? AND answer_revision = ? AND target_host_id = ?`,
        b.question_id,
        b.answer_revision,
        b.host_id,
      );
      if (!d) throw new ApiError('not_found', 'no such delivery');
      if (d.status === 'terminal-delivered') {
        if (d.injection_id === b.injection_id) return json(200, { ok: true });
        throw new ApiError('invalid_state', 'already delivered with a different injection');
      }
      room.run(
        `UPDATE deliveries SET status = 'terminal-delivered', terminal_delivered_at = ?, injection_id = ?, error_code = NULL
         WHERE question_id = ? AND answer_revision = ? AND target_host_id = ?`,
        nowMs(),
        b.injection_id,
        b.question_id,
        b.answer_revision,
        b.host_id,
      );
      room.emit('delivery.terminal_delivered', {
        questionId: b.question_id,
        revision: b.answer_revision,
        deviceId: auth.deviceId,
        data: {
          answer_revision: b.answer_revision,
          target_host_id: b.host_id,
          injection_id: b.injection_id,
        },
      });
      return json(200, { ok: true });
    });
  });
};

export const failed: Handler = async (room, c) => {
  const b = c.body(DeliveryFailedBody);
  const auth = c.auth!;
  const digest = await c.bodyDigest();
  return room.tx(() => {
    room.assertActive(auth.deviceId);
    return withReceipt(room, auth.deviceId, b.idempotency_key, digest, () => {
      const d = room.q1<{ status: string }>(
        `SELECT status FROM deliveries WHERE question_id = ? AND answer_revision = ? AND target_host_id = ?`,
        b.question_id,
        b.answer_revision,
        b.host_id,
      );
      if (!d) throw new ApiError('not_found', 'no such delivery');
      if (d.status === 'terminal-delivered')
        throw new ApiError('invalid_state', 'already delivered');
      room.run(
        `UPDATE deliveries SET status = ?, error_code = ? WHERE question_id = ? AND answer_revision = ? AND target_host_id = ?`,
        b.status,
        b.error_code,
        b.question_id,
        b.answer_revision,
        b.host_id,
      );
      room.emit('delivery.needs_attention', {
        questionId: b.question_id,
        revision: b.answer_revision,
        deviceId: auth.deviceId,
        data: {
          answer_revision: b.answer_revision,
          target_host_id: b.host_id,
          status: b.status,
          error_code: b.error_code,
        },
      });
      return json(200, { ok: true });
    });
  });
};
