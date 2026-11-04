import {
  ApiError,
  LIMITS,
  PaneSnapshotBody,
  SnapshotRefreshBody,
  canonicalize,
  isThreadClosedStatus,
  type PaneSnapshotResponse,
  type SnapshotRefresh,
} from '@daintreehq/decisions-protocol';
import { newId, sha256Hex, verifyObject } from '@daintreehq/decisions-crypto';
import { deviceHasFeature } from '../room/features.js';
import {
  emitSnapshotHint,
  retireSnapshotIfDue,
  snapshotRow,
  storedRefresh,
  storedSnapshot,
  sweepSnapshotRetention,
} from '../room/snapshots.js';
import type { Handler, Room, RouteCtx } from '../room/types.js';
import { errorResponse, iso, json, nowMs, type ApiResponse } from '../util.js';
import { expireQuestionNow, sweepExpired, type QuestionRow } from './questions.js';
import { priorReceipt, storeReceipt } from './receipts.js';

/*
 * Pane snapshots (docs/protocol.md section 18): the publishing desktop writes the latest one, paired devices read
 * it, and phones ask for a fresh one. The relay stores the signed record and ciphertext and nothing else.
 */

/** The idempotency digest covers the route as well as the body: a refresh body names no question. */
async function commandDigest(c: RouteCtx): Promise<string> {
  return sha256Hex(`${c.req.method} ${c.req.path}\n${await c.bodyDigest()}`);
}

/**
 * Loads the question inside the final synchronous section and refuses a closed one. A deadline that passed since
 * the sweep is expired and committed here, so the caller returns the error response rather than throwing.
 */
function liveQuestion(
  room: Room,
  c: RouteCtx,
  qid: string,
): { q: QuestionRow } | { error: ApiResponse } {
  const q = room.q1<QuestionRow>(`SELECT * FROM questions WHERE question_id = ?`, qid);
  if (!q) throw new ApiError('not_found', 'no such question');
  if (q.status === 'open' && q.expires_at != null && q.expires_at <= nowMs()) {
    expireQuestionNow(room, q);
    return { error: errorResponse(new ApiError('expired', 'question expired'), c.req.requestId) };
  }
  if (q.status === 'expired') throw new ApiError('expired', 'question expired');
  if (isThreadClosedStatus(q.status)) throw new ApiError('invalid_state', 'question was withdrawn');
  return { q };
}

/* ---------------- PUT /questions/{id}/snapshot ---------------- */

/** The snapshot cap is checked before the body schema, whose general envelope cap would answer 400 instead. */
function assertCiphertextFits(text: string): void {
  let ciphertext: unknown;
  try {
    ciphertext = (JSON.parse(text) as { snapshot?: { envelope?: { ciphertext?: unknown } } })
      ?.snapshot?.envelope?.ciphertext;
  } catch {
    return; // the schema reports malformed JSON
  }
  if (typeof ciphertext === 'string' && ciphertext.length > LIMITS.snapshotCiphertextChars)
    throw new ApiError('payload_too_large', 'snapshot ciphertext too large');
}

export const putSnapshot: Handler = async (room, c) => {
  const auth = c.auth!;
  const qid = c.params[0]!;
  assertCiphertextFits(c.req.body);
  const body = c.body(PaneSnapshotBody);
  const { record, envelope } = body.snapshot;
  const bad = (m: string) => new ApiError('validation_error', m);
  if (record.question_id !== qid) throw bad('question id mismatch');
  if (record.installation_id !== auth.installationId || record.signer_device_id !== auth.deviceId) {
    throw bad('record does not belong to the authenticated device');
  }
  const observedAt = Date.parse(record.observed_at);
  if (observedAt > nowMs() + LIMITS.requestSkewMs)
    throw bad('observed_at is too far ahead of relay time');
  if (envelope) {
    if (envelope.key_epoch > room.currentEpoch()) throw bad('envelope uses an unknown key epoch');
    if ((await sha256Hex(canonicalize(envelope))) !== record.envelope_digest)
      throw bad('envelope digest mismatch');
  }
  const signer = room.getDevice(auth.deviceId)!;
  if (!(await verifyObject(await room.devicePublicKey(signer), record)))
    throw bad('record signature invalid');
  const digest = await commandDigest(c);
  await sweepExpired(room);

  return room.tx((): ApiResponse => {
    // Everything above awaited: re-validate the actor and the question inside the final synchronous section.
    room.assertActive(auth.deviceId);
    const retry = priorReceipt(room, auth.deviceId, body.idempotency_key, digest);
    if (retry) return retry;
    const live = liveQuestion(room, c, qid);
    if ('error' in live) return live.error;
    const { q } = live;
    if (q.creator_device_id !== auth.deviceId) {
      throw new ApiError(
        'forbidden',
        'only the desktop that published this question publishes its snapshots',
      );
    }
    if (record.question_revision !== q.revision) {
      throw new ApiError('revision_conflict', 'question changed since the pane was read', {
        details: { latest_revision: q.revision, status: q.status },
      });
    }
    const row = snapshotRow(room, qid);
    if (row?.last_observed_at != null && observedAt <= row.last_observed_at) {
      throw new ApiError('revision_conflict', 'a later snapshot was already accepted', {
        details: { latest_observed_at: iso(row.last_observed_at) },
      });
    }
    room.hit(`snapshot-write:${qid}`, LIMITS.snapshotWritesPerQuestionMinute, 60_000);

    const t = nowMs();
    const shared = record.sharing === 'on';
    room.run(
      `INSERT INTO question_snapshots (question_id, last_observed_at, sharing_off, snapshot_id, record_json,
         envelope_json, received_at, retain_until, refresh_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(question_id) DO UPDATE SET last_observed_at = excluded.last_observed_at,
         sharing_off = excluded.sharing_off, snapshot_id = excluded.snapshot_id,
         record_json = excluded.record_json, envelope_json = excluded.envelope_json,
         received_at = excluded.received_at, retain_until = excluded.retain_until, refresh_json = NULL`,
      qid,
      observedAt,
      shared ? 0 : 1,
      record.snapshot_id,
      JSON.stringify(record),
      envelope ? JSON.stringify(envelope) : null,
      t,
      shared ? t + LIMITS.snapshotRetentionMs : null,
    );
    room.markAlarmDirty();
    // A refresh is fulfilled by this snapshot; its hint has nothing left to ask for.
    room.run(
      `DELETE FROM events WHERE question_id = ? AND event_type = 'decision.snapshot.refresh_requested'`,
      qid,
    );
    const seq = emitSnapshotHint(room, 'decision.snapshot.updated', qid, auth.deviceId, {
      snapshot_id: record.snapshot_id,
      observed_at: record.observed_at,
      sharing: record.sharing,
      target_host_id: q.target_host_id,
    });
    return storeReceipt(
      room,
      auth.deviceId,
      body.idempotency_key,
      digest,
      json(200, { question_id: qid, revision: q.revision, status: q.status, event_seq: seq }),
    );
  });
};

/* ---------------- GET /questions/{id}/snapshot ---------------- */

export const getSnapshot: Handler = async (room, c) => {
  await sweepExpired(room);
  await sweepSnapshotRetention(room);
  const qid = c.params[0]!;
  // The sweeps are bounded and awaited: settle this question's expiry and retention in the final section.
  return room.tx((): ApiResponse => {
    const q = room.q1<QuestionRow>(`SELECT * FROM questions WHERE question_id = ?`, qid);
    if (!q) throw new ApiError('not_found', 'no such question');
    const t = nowMs();
    const closed = isThreadClosedStatus(q.status) || expireQuestionNow(room, q);
    if (!closed) retireSnapshotIfDue(room, qid, t);
    const row = closed ? undefined : snapshotRow(room, qid);
    const snapshot = storedSnapshot(row);
    return json(200, {
      question_id: qid,
      snapshot,
      received_at: snapshot && row?.received_at != null ? iso(row.received_at) : null,
      refresh: storedRefresh(row),
    } satisfies PaneSnapshotResponse);
  });
};

/* ---------------- POST /questions/{id}/snapshot/refresh ---------------- */

export const requestRefresh: Handler = async (room, c) => {
  const auth = c.auth!;
  const qid = c.params[0]!;
  const body = c.body(SnapshotRefreshBody);
  const digest = await commandDigest(c);
  await sweepExpired(room);

  return room.tx((): ApiResponse => {
    room.assertActive(auth.deviceId);
    const retry = priorReceipt(room, auth.deviceId, body.idempotency_key, digest);
    if (retry) return retry;
    const live = liveQuestion(room, c, qid);
    if ('error' in live) return live.error;
    const { q } = live;
    if (!deviceHasFeature(room.getDevice(q.creator_device_id), 'pane-snapshots-v1')) {
      throw new ApiError(
        'invalid_state',
        'the desktop that published this question does not publish pane snapshots',
      );
    }
    const row = snapshotRow(room, qid);
    if (row?.sharing_off) {
      throw new ApiError('invalid_state', 'the desktop does not share pane snapshots');
    }
    room.hit(`snapshot-refresh:${auth.deviceId}`, LIMITS.snapshotRefreshesPerDeviceMinute, 60_000);
    const t = nowMs();
    const outstanding = storedRefresh(row);
    // Coalesce: while a request is outstanding, every phone that asks gets the same one.
    let refresh: SnapshotRefresh;
    if (outstanding && t < Date.parse(outstanding.deadline_at)) {
      refresh = outstanding;
    } else {
      refresh = {
        refresh_id: newId(t),
        requested_by_device_id: auth.deviceId,
        requested_at: iso(t),
        deadline_at: iso(t + LIMITS.snapshotRefreshTimeoutMs),
      };
      room.run(
        `INSERT INTO question_snapshots (question_id, refresh_json) VALUES (?, ?)
         ON CONFLICT(question_id) DO UPDATE SET refresh_json = excluded.refresh_json`,
        qid,
        JSON.stringify(refresh),
      );
      emitSnapshotHint(room, 'decision.snapshot.refresh_requested', qid, auth.deviceId, {
        ...refresh,
        target_host_id: q.target_host_id,
      });
    }
    return storeReceipt(room, auth.deviceId, body.idempotency_key, digest, json(200, refresh));
  });
};
