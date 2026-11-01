import type { Room } from './types.js';
import { nowMs } from '../util.js';

/** Shared by the `ack` WS frame and POST /deliveries/received. Must run inside `tx`. */
export function applyAck(room: Room, deviceId: string, seq: number): void {
  const dev = room.getDevice(deviceId);
  if (!dev || seq <= dev.last_ack_seq) return;
  room.run(`UPDATE devices SET last_ack_seq = ? WHERE device_id = ?`, seq, deviceId);
  const rows = room.q<{ question_id: string; answer_revision: number; target_host_id: string }>(
    `SELECT question_id, answer_revision, target_host_id FROM deliveries
     WHERE status = 'relay-queued' AND event_seq <= ?`,
    seq,
  );
  for (const d of rows) {
    room.run(
      `UPDATE deliveries SET status = 'desktop-received', received_at = ? WHERE question_id = ? AND answer_revision = ? AND target_host_id = ?`,
      nowMs(),
      d.question_id,
      d.answer_revision,
      d.target_host_id,
    );
    room.emit('delivery.received', {
      questionId: d.question_id,
      revision: d.answer_revision,
      deviceId,
      data: { up_to_seq: seq, device_id: deviceId },
    });
  }
}
