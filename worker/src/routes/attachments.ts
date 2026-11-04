import {
  ApiError,
  AttachmentCompleteBody,
  AttachmentReserveBody,
  LIMITS,
  PhoneImageReserveBody,
  bytesToHex,
} from '@daintreehq/decisions-protocol';
import { sha256Hex } from '@daintreehq/decisions-crypto';
import { assertPublisherTakesImages, assertUploaderRole } from '../room/phone-images.js';
import type { Handler } from '../room/types.js';
import { errorResponse, iso, json, nowMs, randomHex, type ApiResponse } from '../util.js';
import { expireQuestionNow, sweepExpired, type QuestionRow } from './questions.js';

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
  const auth = c.auth!;
  const a = room.q1<{
    object_key: string;
    state: string;
    kind: string;
    creator_device_id: string;
    ciphertext_bytes: number;
    sha256_ciphertext: string;
    question_id: string;
  }>(
    `SELECT object_key, state, kind, creator_device_id, ciphertext_bytes, sha256_ciphertext, question_id
     FROM attachments WHERE attachment_id = ?`,
    id,
  );
  if (a) assertUploaderRole(a.kind, auth.role);
  if (!a || a.creator_device_id !== auth.deviceId)
    throw new ApiError('not_found', 'no such attachment');
  if (a.state === 'available') return json(200, { attachment_id: id, state: 'available' });
  if (a.state !== 'uploaded') throw new ApiError('invalid_state', 'upload has not finished');
  const head = await room.env.ATTACHMENTS.head(a.object_key);
  if (!head || head.size !== a.ciphertext_bytes)
    throw new ApiError('validation_error', 'stored object does not match the reservation');
  if (a.kind === 'phone') {
    // R2 checked the digest while streaming; the stored checksum proves the object is still that upload.
    const sha = head.checksums.sha256;
    if (!sha || bytesToHex(new Uint8Array(sha)) !== a.sha256_ciphertext)
      throw new ApiError('validation_error', 'stored object does not match the reservation');
    await room.tx(() => {
      room.assertActive(auth.deviceId);
      const changed = room.run(
        `UPDATE attachments SET state = 'available' WHERE attachment_id = ? AND state = 'uploaded'`,
        id,
      );
      // Garbage collection or a delete may have claimed it while R2 answered.
      const now = room.q1<{ state: string }>(
        `SELECT state FROM attachments WHERE attachment_id = ?`,
        id,
      );
      if (!changed && now?.state !== 'available')
        throw new ApiError('invalid_state', 'upload is no longer valid');
      // No `attachment.available` event: a phone image stays unpublished until a committed record lists it.
    });
    return json(200, { attachment_id: id, state: 'available' });
  }
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

/**
 * `POST /questions/{id}/images/reservations` (phone, tablet; docs/protocol.md section 17). Reserves one phone
 * image for one answer or message on an existing question that takes messages. The upload and completion then
 * reuse the question-image routes; the image binds when the record that lists it commits.
 */
export const reservePhoneImage: Handler = async (room, c) => {
  const auth = c.auth!;
  const qid = c.params[0]!;
  const b = c.body(PhoneImageReserveBody);
  // The body names no question, so the receipt's fingerprint does: one key and body on another question collide.
  const digest = await sha256Hex(`${qid}\n${await c.bodyDigest()}`);
  // Commit overdue expiries first, so the state checked below is never a stale `open`.
  await sweepExpired(room);

  return room.tx((): ApiResponse => {
    room.assertActive(auth.deviceId);
    const t = nowMs();
    const prior = room.q1<{ request_digest: string; status: number; response_json: string }>(
      `SELECT request_digest, status, response_json FROM command_receipts WHERE device_id = ? AND idempotency_key = ?`,
      auth.deviceId,
      b.idempotency_key,
    );
    if (prior) {
      if (prior.request_digest !== digest)
        throw new ApiError('idempotency_collision', 'idempotency key reused with a different body');
      return { status: prior.status, body: prior.response_json };
    }
    const q = room.q1<QuestionRow>(`SELECT * FROM questions WHERE question_id = ?`, qid);
    if (!q) throw new ApiError('not_found', 'no such question');
    if (q.status === 'open' && q.expires_at != null && q.expires_at <= t) {
      expireQuestionNow(room, q);
      return errorResponse(new ApiError('expired', 'question expired'), c.req.requestId);
    }
    if (q.status === 'expired') throw new ApiError('expired', 'question expired');
    if (q.status === 'cancelled')
      throw new ApiError('invalid_state', 'a cancelled question takes no images');
    assertPublisherTakesImages(room, q.creator_device_id);

    // Lifetime budgets: every phone image ever reserved on the question counts, so cleanup never refills them.
    const life = room.q1<{ n: number; bytes: number | null }>(
      `SELECT COUNT(*) AS n, SUM(ciphertext_bytes) AS bytes FROM attachments WHERE question_id = ? AND kind = 'phone'`,
      qid,
    )!;
    if (life.n >= LIMITS.phoneImagesPerQuestion)
      throw new ApiError('payload_too_large', 'too many images for this question');
    if ((life.bytes ?? 0) + b.ciphertext_bytes > LIMITS.phoneImageTotalBytes)
      throw new ApiError('payload_too_large', 'images exceed the per-question limit');
    const forRecord = room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attachments WHERE kind = 'phone' AND state != 'deleted' AND question_id = ?
         AND creator_device_id = ? AND binding_kind = ? AND binding_record_id = ?`,
      qid,
      auth.deviceId,
      b.binding.kind,
      b.binding.record_id,
    )!;
    if (forRecord.n >= LIMITS.phoneImagesPerContent)
      throw new ApiError('payload_too_large', `too many images for this ${b.binding.kind}`);
    // Completed uploads still count until a record binds them.
    const unbound = room.q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attachments
       WHERE creator_device_id = ? AND kind = 'phone' AND bound = 0 AND state != 'deleted'`,
      auth.deviceId,
    )!;
    if (unbound.n >= LIMITS.phoneImageUnboundPerDevice)
      throw new ApiError('rate_limited', 'too many unattached images', { retryAfterMs: 30_000 });
    if (room.q1(`SELECT 1 FROM attachments WHERE attachment_id = ?`, b.attachment_id))
      throw new ApiError('invalid_state', 'attachment id already in use');

    const expires = t + LIMITS.uploadAuthorizationMs;
    room.run(
      `INSERT INTO attachments (attachment_id, question_id, creator_device_id, object_key, ciphertext_bytes,
         sha256_ciphertext, state, upload_expires_at, created_at, kind, binding_kind, binding_record_id)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, 'phone', ?, ?)`,
      b.attachment_id,
      qid,
      auth.deviceId,
      `a/${randomHex(24)}`,
      b.ciphertext_bytes,
      b.sha256_ciphertext,
      expires,
      t,
      b.binding.kind,
      b.binding.record_id,
    );
    // An image no committed record lists is deleted this long after its reservation, however far it got.
    room.schedule({
      kind: 'gc_orphan',
      runAt: t + LIMITS.phoneImageOrphanMs,
      attachmentId: b.attachment_id,
    });
    const res = json(201, {
      attachment_id: b.attachment_id,
      upload_path: `/api/v1/attachments/${b.attachment_id}/content`,
      expires_at: iso(expires),
    });
    room.run(
      `INSERT INTO command_receipts (device_id, idempotency_key, request_digest, status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      auth.deviceId,
      b.idempotency_key,
      digest,
      res.status,
      res.body,
      t,
    );
    return res;
  });
};
