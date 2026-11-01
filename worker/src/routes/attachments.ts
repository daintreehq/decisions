import {
  ApiError,
  AttachmentCompleteBody,
  AttachmentReserveBody,
  LIMITS,
} from '@daintreehq/decisions-protocol';
import type { Handler } from '../room/types.js';
import { iso, json, nowMs, randomHex } from '../util.js';

export const reserve: Handler = async (room, c) => {
  const auth = c.auth!;
  const b = c.body(AttachmentReserveBody);
  const digest = await c.bodyDigest();
  const t = nowMs();
  const res = await room.tx(() => {
    room.assertActive(auth.deviceId);
    const receipt = room.q1<{ request_digest: string; response_json: string }>(
      `SELECT request_digest, response_json FROM command_receipts WHERE device_id = ? AND idempotency_key = ?`,
      auth.deviceId,
      b.idempotency_key,
    );
    if (receipt) {
      if (receipt.request_digest !== digest)
        throw new ApiError('idempotency_collision', 'idempotency key reused');
      return { status: 200, body: receipt.response_json };
    }
    if (room.q1(`SELECT 1 FROM questions WHERE question_id = ?`, b.question_id)) {
      throw new ApiError(
        'invalid_state',
        'question already exists; attachments must be uploaded first',
      );
    }
    const agg = room.q1<{ n: number; bytes: number | null }>(
      `SELECT COUNT(*) AS n, SUM(ciphertext_bytes) AS bytes FROM attachments WHERE question_id = ? AND state != 'deleted'`,
      b.question_id,
    )!;
    if (agg.n >= LIMITS.attachmentsPerQuestion)
      throw new ApiError('payload_too_large', 'too many attachments for this question');
    if ((agg.bytes ?? 0) + b.ciphertext_bytes > LIMITS.attachmentTotalBytes) {
      throw new ApiError('payload_too_large', 'attachments exceed the per-question limit');
    }
    // Everything not yet bound to a question counts, whatever its state: completing uploads must not reset the budget.
    const unbound = room.q1<{ n: number; bytes: number | null }>(
      `SELECT COUNT(*) AS n, SUM(ciphertext_bytes) AS bytes FROM attachments
       WHERE creator_device_id = ? AND bound = 0 AND state != 'deleted'`,
      auth.deviceId,
    )!;
    if (unbound.n >= 3 * LIMITS.attachmentsPerQuestion)
      throw new ApiError('rate_limited', 'too many unattached uploads', { retryAfterMs: 30_000 });
    if ((unbound.bytes ?? 0) + b.ciphertext_bytes > 3 * LIMITS.attachmentTotalBytes)
      throw new ApiError('payload_too_large', 'too many unattached upload bytes');
    const attachmentId = b.attachment_id;
    if (room.q1(`SELECT 1 FROM attachments WHERE attachment_id = ?`, attachmentId)) {
      throw new ApiError('invalid_state', 'attachment id already in use');
    }
    const expires = t + LIMITS.uploadAuthorizationMs;
    room.run(
      `INSERT INTO attachments (attachment_id, question_id, creator_device_id, object_key, ciphertext_bytes, sha256_ciphertext, state, upload_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
      attachmentId,
      b.question_id,
      auth.deviceId,
      `a/${randomHex(24)}`,
      b.ciphertext_bytes,
      b.sha256_ciphertext,
      expires,
      t,
    );
    // Anything not bound to a question within two hours is garbage.
    room.schedule({ kind: 'gc_orphan', runAt: t + 2 * 3_600_000, attachmentId });
    const out = {
      attachment_id: attachmentId,
      upload_path: `/api/v1/attachments/${attachmentId}/content`,
      expires_at: iso(expires),
    };
    room.run(
      `INSERT INTO command_receipts (device_id, idempotency_key, request_digest, status, response_json, created_at) VALUES (?, ?, ?, 201, ?, ?)`,
      auth.deviceId,
      b.idempotency_key,
      digest,
      JSON.stringify(out),
      t,
    );
    return { status: 201, body: JSON.stringify(out) };
  });
  return res;
};

export const complete: Handler = async (room, c) => {
  c.body(AttachmentCompleteBody);
  const id = c.params[0]!;
  const a = room.q1<{
    object_key: string;
    state: string;
    creator_device_id: string;
    ciphertext_bytes: number;
    question_id: string;
  }>(
    `SELECT object_key, state, creator_device_id, ciphertext_bytes, question_id FROM attachments WHERE attachment_id = ?`,
    id,
  );
  if (!a || a.creator_device_id !== c.auth!.deviceId)
    throw new ApiError('not_found', 'no such attachment');
  if (a.state === 'available') return json(200, { attachment_id: id, state: 'available' });
  if (a.state !== 'uploaded') throw new ApiError('invalid_state', 'upload has not finished');
  const head = await room.env.ATTACHMENTS.head(a.object_key);
  if (!head || head.size !== a.ciphertext_bytes)
    throw new ApiError('validation_error', 'stored object does not match the reservation');
  await room.tx(() => {
    room.assertActive(c.auth!.deviceId);
    room.run(
      `UPDATE attachments SET state = 'available' WHERE attachment_id = ? AND state = 'uploaded'`,
      id,
    );
    room.emit('attachment.available', {
      questionId: a.question_id,
      deviceId: c.auth!.deviceId,
      data: { attachment_id: id },
    });
  });
  return json(200, { attachment_id: id, state: 'available' });
};
