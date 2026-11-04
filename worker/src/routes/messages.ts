import {
  ApiError,
  LIMITS,
  MessageBody,
  MessageReceiptBody,
  applyMessage,
  canonicalize,
  utf8ByteLength,
  type CryptoEnvelope,
  type MessageDeliveryStatus,
  type MessageRecord,
  type MessageSide,
} from '@daintreehq/decisions-protocol';
import { sha256Hex, verifyObject } from '@daintreehq/decisions-crypto';
import { bindPhoneImages } from '../room/phone-images.js';
import type { Handler } from '../room/types.js';
import { errorResponse, iso, isoOrNull, json, nowMs, type ApiResponse } from '../util.js';
import { deviceFeatures } from './devices.js';
import { expireQuestionNow, retentionMs, sweepExpired, type QuestionRow } from './questions.js';
import { withReceipt } from './receipts.js';

/*
 * Thread messages (docs/protocol.md section 16). The relay stores each message's signed record and ciphertext and
 * routes it; it never sees the text. A message never touches the question's status, revision or answer.
 */

interface MessageRow {
  message_id: string;
  question_id: string;
  message_seq: number;
  side: MessageSide;
  expects_reply: number;
  signer_device_id: string;
  record_json: string;
  envelope_json: string;
  committed_at: number;
  event_seq: number;
}

interface MessageDeliveryRow {
  message_id: string;
  question_id: string;
  target_host_id: string;
  status: MessageDeliveryStatus;
  received_at: number | null;
  terminal_delivered_at: number | null;
  injection_id: string | null;
  error_code: string | null;
}

const receiptOf = (
  m: Pick<MessageRow, 'question_id' | 'message_id' | 'message_seq' | 'event_seq' | 'committed_at'>,
) => ({
  question_id: m.question_id,
  message_id: m.message_id,
  message_seq: m.message_seq,
  event_seq: m.event_seq,
  committed_at: iso(m.committed_at),
});

/** The signed fields without the signature: ECDSA signatures differ between two signings of the same record. */
const unsigned = (r: Record<string, unknown>): string => {
  const { signature: _signature, ...rest } = r;
  return canonicalize(rest);
};

/** `POST /questions/{id}/messages`: a human message from a phone or tablet, or an agent message from the publisher. */
export const postMessage: Handler = async (room, c) => {
  const auth = c.auth!;
  const qid = c.params[0]!;
  const body = c.body(MessageBody);
  const { record, envelope } = body.message;
  const bad = (m: string) => new ApiError('validation_error', m);
  if (record.question_id !== qid) throw bad('question id mismatch');
  if (record.installation_id !== auth.installationId || record.signer_device_id !== auth.deviceId) {
    throw bad('record does not belong to the authenticated device');
  }
  if (envelope.key_epoch > room.currentEpoch()) throw bad('envelope uses an unknown key epoch');
  if ((await sha256Hex(canonicalize(envelope))) !== record.envelope_digest)
    throw bad('envelope digest mismatch');
  const signer = room.getDevice(auth.deviceId)!;
  if (!(await verifyObject(await room.devicePublicKey(signer), record)))
    throw bad('record signature invalid');
  const digest = await c.bodyDigest();
  // Commit overdue expiries first, so the state checked below is never a stale `open`.
  await sweepExpired(room);

  return room.tx((): ApiResponse => {
    // Everything above awaited: re-validate the actor and re-read the question inside the final synchronous section.
    room.assertActive(auth.deviceId);
    const t = nowMs();
    const prior = room.q1<{ request_digest: string; status: number; response_json: string }>(
      `SELECT request_digest, status, response_json FROM command_receipts WHERE device_id = ? AND idempotency_key = ?`,
      auth.deviceId,
      body.idempotency_key,
    );
    if (prior) {
      if (prior.request_digest !== digest)
        throw new ApiError('idempotency_collision', 'idempotency key reused with a different body');
      return { status: prior.status, body: prior.response_json };
    }
    // The same record under its message id is a retry, recognised before the state and quota checks.
    const dup = room.q1<MessageRow>(
      `SELECT * FROM messages WHERE message_id = ?`,
      record.message_id,
    );
    if (dup) {
      const stored = JSON.parse(dup.record_json) as Record<string, unknown>;
      if (dup.question_id !== qid || unsigned(stored) !== unsigned(record)) {
        throw new ApiError(
          'idempotency_collision',
          'message id already used by a different message',
        );
      }
      // The retry's own key now names this message too, so reusing it for another message is a collision.
      const res = json(200, receiptOf(dup));
      room.run(
        `INSERT INTO command_receipts (device_id, idempotency_key, request_digest, status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        auth.deviceId,
        body.idempotency_key,
        digest,
        res.status,
        res.body,
        t,
      );
      return res;
    }
    const q = room.q1<QuestionRow>(`SELECT * FROM questions WHERE question_id = ?`, qid);
    if (!q) throw new ApiError('not_found', 'no such question');
    // A deadline may have passed since the sweep: expire the question now and commit that, never post to it.
    if (q.status === 'open' && q.expires_at != null && q.expires_at <= t) {
      expireQuestionNow(room, q);
      return errorResponse(new ApiError('expired', 'question expired'), c.req.requestId);
    }
    const count =
      room.q1<{ n: number | null }>(
        `SELECT MAX(message_seq) AS n FROM messages WHERE question_id = ?`,
        qid,
      )?.n ?? 0;
    const tr = applyMessage(
      {
        status: q.status,
        revision: q.revision,
        requirement: q.requirement,
        proxyAbstained: Boolean(q.proxy_abstained),
      },
      {
        side: record.side,
        role: auth.role,
        signerIsPublisher: auth.deviceId === q.creator_device_id,
        messageCount: count,
      },
    );
    // A human message is typed into the pane by the publishing desktop, which must understand messages.
    if (
      record.side === 'human' &&
      !deviceFeatures(room, q.creator_device_id).includes('thread-messages-v1')
    ) {
      throw new ApiError('invalid_state', "the question's desktop does not accept messages");
    }

    // The phone images a human message lists bind with it, or it does not commit (section 17).
    bindPhoneImages(room, {
      questionId: qid,
      signerDeviceId: auth.deviceId,
      binding: { kind: 'message', record_id: record.message_id },
      ids: record.attachment_ids,
      publisherDeviceId: q.creator_device_id,
      t,
      retainMs: retentionMs(room),
    });

    const seq = count + 1;
    const ev = room.emit('decision.message.posted', {
      questionId: qid,
      revision: null,
      deviceId: auth.deviceId,
      data: {
        message_seq: seq,
        committed_at: iso(t),
        record,
        envelope,
        target_host_id: q.target_host_id,
      },
    });
    room.run(`UPDATE questions SET last_event_seq = ? WHERE question_id = ?`, ev.seq, qid);
    room.run(
      `INSERT INTO messages (message_id, question_id, message_seq, side, expects_reply, signer_device_id, record_json,
         envelope_json, committed_at, event_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.message_id,
      qid,
      seq,
      record.side,
      record.expects_reply ? 1 : 0,
      auth.deviceId,
      JSON.stringify(record),
      JSON.stringify(envelope),
      t,
      ev.seq,
    );
    if (tr.deliverToHost) {
      room.run(
        `INSERT INTO message_deliveries (message_id, question_id, target_host_id, status) VALUES (?, ?, ?, 'relay-queued')`,
        record.message_id,
        qid,
        q.target_host_id,
      );
    }
    if (record.side === 'agent' && record.expects_reply) {
      // One reply notification per question at a time: the latest asking message replaces an unsent one.
      room.cancelJobs({ questionId: qid, kinds: ['notify_reply'] });
      room.schedule({
        kind: 'notify_reply',
        runAt: t,
        questionId: qid,
        payload: { message_id: record.message_id },
      });
    }

    const res = receiptOf({
      question_id: qid,
      message_id: record.message_id,
      message_seq: seq,
      event_seq: ev.seq,
      committed_at: t,
    });
    room.run(
      `INSERT INTO command_receipts (device_id, idempotency_key, request_digest, status, response_json, created_at) VALUES (?, ?, ?, 201, ?, ?)`,
      auth.deviceId,
      body.idempotency_key,
      digest,
      JSON.stringify(res),
      t,
    );
    return json(201, res);
  });
};

/** `GET /questions/{id}/messages?after=&limit=`: the thread in `message_seq` order, with each human message's delivery. */
export const listMessages: Handler = async (room, c) => {
  const qid = c.params[0]!;
  const params = new URLSearchParams(c.req.query);
  const after = Number(params.get('after') ?? '0');
  const limit = Math.floor(
    Math.min(
      Math.max(Number(params.get('limit') ?? String(LIMITS.messagePageSize)) || 1, 1),
      LIMITS.messagePageSize,
    ),
  );
  if (!Number.isSafeInteger(after) || after < 0)
    throw new ApiError('validation_error', 'bad cursor');
  if (!room.q1(`SELECT 1 FROM questions WHERE question_id = ?`, qid))
    throw new ApiError('not_found', 'no such question');
  const rows = room.q<
    MessageRow & {
      d_status: MessageDeliveryStatus | null;
      d_received_at: number | null;
      d_terminal_delivered_at: number | null;
      d_injection_id: string | null;
      d_error_code: string | null;
    }
  >(
    `SELECT m.*, d.status AS d_status, d.received_at AS d_received_at,
       d.terminal_delivered_at AS d_terminal_delivered_at, d.injection_id AS d_injection_id,
       d.error_code AS d_error_code
     FROM messages m LEFT JOIN message_deliveries d ON d.message_id = m.message_id
     WHERE m.question_id = ? AND m.message_seq > ? ORDER BY m.message_seq LIMIT ?`,
    qid,
    after,
    limit + 1,
  );
  const messages = [];
  let bytes = 0;
  let hasMore = rows.length > limit;
  for (const r of rows.slice(0, limit)) {
    const view = {
      message_seq: r.message_seq,
      committed_at: iso(r.committed_at),
      record: JSON.parse(r.record_json) as MessageRecord,
      envelope: JSON.parse(r.envelope_json) as CryptoEnvelope,
      event_seq: r.event_seq,
      delivery: r.d_status
        ? {
            status: r.d_status,
            received_at: isoOrNull(r.d_received_at),
            terminal_delivered_at: isoOrNull(r.d_terminal_delivered_at),
            injection_id: r.d_injection_id,
            error_code: r.d_error_code,
          }
        : null,
    };
    // Bounded like an events page, so a tunnelled response stays small; a page always holds one message.
    const size = utf8ByteLength(r.record_json) + utf8ByteLength(r.envelope_json);
    if (messages.length > 0 && bytes + size > LIMITS.eventPageBytes) {
      hasMore = true;
      break;
    }
    messages.push(view);
    bytes += size;
  }
  return json(200, {
    question_id: qid,
    messages,
    next_after: messages.length ? messages[messages.length - 1]!.message_seq : after,
    has_more: hasMore,
  });
};

/**
 * `POST /deliveries/messages` (section 16.4): the desktop that published the question reports one human message as
 * received, typed into the pane, or needing attention. A ledger `ack` never marks a message received, and nothing
 * moves a message back from `terminal-delivered`.
 */
export const messageReceipt: Handler = async (room, c) => {
  const b = c.body(MessageReceiptBody);
  const auth = c.auth!;
  const digest = await c.bodyDigest();
  return room.tx(() => {
    room.assertActive(auth.deviceId);
    return withReceipt(room, auth.deviceId, b.idempotency_key, digest, () => {
      const q = room.q1<Pick<QuestionRow, 'creator_device_id'>>(
        `SELECT creator_device_id FROM questions WHERE question_id = ?`,
        b.question_id,
      );
      if (!q) throw new ApiError('not_found', 'no such question');
      if (q.creator_device_id !== auth.deviceId) {
        throw new ApiError(
          'forbidden',
          'only the desktop that published the question reports its message deliveries',
        );
      }
      const d = room.q1<MessageDeliveryRow>(
        `SELECT * FROM message_deliveries WHERE message_id = ? AND question_id = ? AND target_host_id = ?`,
        b.message_id,
        b.question_id,
        b.host_id,
      );
      if (!d) throw new ApiError('not_found', 'no such message delivery');
      const t = nowMs();
      let next: MessageDeliveryRow;
      switch (b.status) {
        case 'received':
          // Receipt is a fact, not a stage to return to: a later status stays, and only the time is filled in.
          if (d.received_at !== null) return json(200, { ok: true });
          next = {
            ...d,
            received_at: t,
            status: d.status === 'relay-queued' ? 'received' : d.status,
          };
          break;
        case 'terminal-delivered':
          if (d.status === 'terminal-delivered') {
            if (d.injection_id === b.injection_id) return json(200, { ok: true });
            throw new ApiError('invalid_state', 'already delivered with a different injection');
          }
          next = {
            ...d,
            status: 'terminal-delivered',
            received_at: d.received_at ?? t,
            terminal_delivered_at: t,
            injection_id: b.injection_id,
            error_code: null,
          };
          break;
        default:
          if (d.status === 'terminal-delivered')
            throw new ApiError('invalid_state', 'already delivered');
          if (d.status === b.status && d.error_code === b.error_code)
            return json(200, { ok: true });
          next = { ...d, status: b.status, error_code: b.error_code };
      }
      room.run(
        `UPDATE message_deliveries SET status = ?, received_at = ?, terminal_delivered_at = ?, injection_id = ?,
           error_code = ? WHERE message_id = ?`,
        next.status,
        next.received_at,
        next.terminal_delivered_at,
        next.injection_id,
        next.error_code,
        d.message_id,
      );
      room.emit('delivery.message', {
        questionId: b.question_id,
        revision: null,
        deviceId: auth.deviceId,
        data: {
          status: next.status,
          received_at: isoOrNull(next.received_at),
          terminal_delivered_at: isoOrNull(next.terminal_delivered_at),
          injection_id: next.injection_id,
          error_code: next.error_code,
          message_id: d.message_id,
          target_host_id: d.target_host_id,
        },
      });
      return json(200, { ok: true });
    });
  });
};
