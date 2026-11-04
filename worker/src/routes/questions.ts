import {
  ActionBody,
  ApiError,
  CreateQuestionBody,
  DEFAULTS,
  LIMITS,
  applyAction,
  canonicalize,
  provenanceForAction,
  type ActionKind,
  type ActionRecord,
  type CryptoEnvelope,
  type QuestionRecord,
  type QuestionStatus,
  type Requirement,
} from '@daintreehq/decisions-protocol';
import { sha256Hex, verifyObject } from '@daintreehq/decisions-crypto';
import type { Handler, Room } from '../room/types.js';
import { errorResponse, iso, isoOrNull, json, nowMs, type ApiResponse } from '../util.js';
import { nextAllowed } from '../push/quiet-hours.js';

/** How long `proxy-ok` / `proxy-first` questions wait for the decision model before the human is notified. */
export const PROXY_GRACE_MS = 90_000;

export interface QuestionRow {
  question_id: string;
  creator_device_id: string;
  target_host_id: string;
  origin_ref: string;
  requirement: Requirement;
  status: QuestionStatus;
  revision: number;
  proxy_abstained: number;
  key_epoch: number;
  record_json: string;
  envelope_json: string;
  envelope_digest: string;
  created_at: number;
  expires_at: number | null;
  resolved_at: number | null;
  last_event_seq: number;
}

const BUMPS: ReadonlySet<ActionKind> = new Set([
  'answer',
  'override',
  'proxy-answer',
  'confirm-proxy',
  'reopen',
]);

export function summary(r: QuestionRow) {
  return {
    question_id: r.question_id,
    status: r.status,
    revision: r.revision,
    requirement: r.requirement,
    target_host_id: r.target_host_id,
    created_at: iso(r.created_at),
    expires_at: isoOrNull(r.expires_at),
    resolved_at: isoOrNull(r.resolved_at),
    last_event_seq: r.last_event_seq,
    proxy_abstained: Boolean(r.proxy_abstained),
  };
}

function checkEnvelopeBinding(
  env: CryptoEnvelope,
  expect: {
    installation: string;
    questionId: string;
    recordType: string;
    revision: number;
    sender: string;
    purpose: string;
  },
  currentEpoch: number,
): void {
  const a = env.aad;
  if (
    a.installation_id !== expect.installation ||
    a.question_id !== expect.questionId ||
    a.record_type !== expect.recordType ||
    a.revision !== expect.revision ||
    a.sender_device_id !== expect.sender ||
    env.purpose !== expect.purpose
  ) {
    throw new ApiError('validation_error', 'envelope binding does not match the signed record');
  }
  if (env.key_epoch > currentEpoch)
    throw new ApiError('validation_error', 'envelope uses an unknown key epoch');
}

/** Sync. Expires one due question. Returns true if it changed state. Must run inside `room.tx`. */
export function expireQuestionNow(room: Room, q: QuestionRow): boolean {
  const t = nowMs();
  if (q.status !== 'open' || q.expires_at == null || q.expires_at > t) return false;
  room.run(
    `UPDATE questions SET status = 'expired', resolved_at = ? WHERE question_id = ?`,
    t,
    q.question_id,
  );
  const ev = room.emit('decision.expired', {
    questionId: q.question_id,
    revision: q.revision,
    data: { expired_at: iso(t), target_host_id: q.target_host_id },
  });
  room.run(`UPDATE questions SET last_event_seq = ? WHERE question_id = ?`, ev.seq, q.question_id);
  room.cancelJobs({ questionId: q.question_id });
  room.schedule({
    kind: 'delete_attachments',
    runAt: t + retentionMs(room),
    questionId: q.question_id,
  });
  return true;
}

export function retentionMs(room: Room): number {
  const days = room.settings().attachment_retention_days;
  return days ? days * 86_400_000 : DEFAULTS.attachmentRetentionMs;
}

/** Lazily expire every due question so reads and writes never observe a stale `open`. */
export async function sweepExpired(room: Room): Promise<void> {
  // Drain every overdue question in bounded batches; nothing may observe a stale `open`.
  for (let i = 0; i < 40; i++) {
    const due = room.q<QuestionRow>(
      `SELECT * FROM questions WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 50`,
      nowMs(),
    );
    if (due.length === 0) return;
    await room.tx(() => {
      for (const q of due) expireQuestionNow(room, q);
    });
  }
}

/** Open-question quotas (installation and per pane). Must run inside the creating or reopening transaction. */
function assertQuota(room: Room, originRef: string): void {
  const open = room.q1<{ total: number; pane: number | null }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN origin_ref = ? THEN 1 ELSE 0 END) AS pane
     FROM questions WHERE status IN ('open','proxy-answered')`,
    originRef,
  )!;
  if (open.total >= LIMITS.openQuestionsPerInstallation)
    throw new ApiError('rate_limited', 'too many open questions', { retryAfterMs: 60_000 });
  if ((open.pane ?? 0) >= LIMITS.openQuestionsPerPane)
    throw new ApiError('rate_limited', 'too many open questions for this pane', {
      retryAfterMs: 60_000,
    });
}

function scheduleReminders(room: Room, questionId: string, from: number, n = 1): void {
  const s = room.settings().reminders;
  if (!s?.enabled || n > s.max) return;
  room.schedule({
    kind: 'remind',
    runAt: from + (n === 1 ? s.first_ms : s.interval_ms),
    questionId,
    payload: { n },
  });
}

/* ---------------- create ---------------- */

export const createQuestion: Handler = async (room, c) => {
  const auth = c.auth!;
  const body = c.body(CreateQuestionBody);
  const { record, envelope } = body.question;
  const t = nowMs();
  const bad = (m: string) => new ApiError('validation_error', m);

  if (
    record.installation_id !== auth.installationId ||
    record.signer_device_id !== auth.deviceId ||
    record.originating_device_id !== auth.deviceId
  ) {
    throw bad('record does not belong to the authenticated device');
  }
  if (record.key_epoch !== envelope.key_epoch) throw bad('key epoch mismatch');
  checkEnvelopeBinding(
    envelope,
    {
      installation: auth.installationId,
      questionId: record.question_id,
      recordType: 'question',
      revision: 0,
      sender: auth.deviceId,
      purpose: 'question-content',
    },
    room.currentEpoch(),
  );
  if ((await sha256Hex(canonicalize(envelope))) !== record.envelope_digest)
    throw bad('envelope digest mismatch');
  const signer = room.getDevice(auth.deviceId)!;
  if (!(await verifyObject(await room.devicePublicKey(signer), record)))
    throw bad('record signature invalid');
  const expiresAt = record.expires_at ? Date.parse(record.expires_at) : null;
  if (expiresAt !== null && (expiresAt <= t || expiresAt > t + LIMITS.maxQuestionExpiryMs)) {
    throw bad('expires_at must be in the future and within a year (use null for no expiry)');
  }
  if (new Set(record.attachment_ids).size !== record.attachment_ids.length)
    throw bad('duplicate attachment id');
  const digest = await c.bodyDigest();
  // Overdue questions must not count against the quotas below.
  await sweepExpired(room);

  return room.tx((): ApiResponse => {
    room.assertActive(auth.deviceId);
    const receipt = room.q1<{ request_digest: string; status: number; response_json: string }>(
      `SELECT request_digest, status, response_json FROM command_receipts WHERE device_id = ? AND idempotency_key = ?`,
      auth.deviceId,
      body.idempotency_key,
    );
    if (receipt) {
      if (receipt.request_digest !== digest)
        throw new ApiError('idempotency_collision', 'idempotency key reused with a different body');
      return { status: receipt.status, body: receipt.response_json };
    }
    const existing = room.q1<QuestionRow>(
      `SELECT * FROM questions WHERE question_id = ?`,
      record.question_id,
    );
    if (existing) {
      // The record signature covers every field (requirement, host, expiry, attachments, envelope digest),
      // so an identical signature means identical content; anything else is a collision, never a silent change.
      const storedSig = (JSON.parse(existing.record_json) as { signature?: string }).signature;
      if (storedSig !== record.signature || existing.creator_device_id !== auth.deviceId) {
        throw new ApiError(
          'idempotency_collision',
          'question id already exists with different content',
        );
      }
      return json(200, {
        question_id: existing.question_id,
        revision: existing.revision,
        status: existing.status,
        event_seq: existing.last_event_seq,
        created_at: iso(existing.created_at),
      });
    }
    assertQuota(room, record.origin_ref);

    let bytes = 0;
    for (const id of record.attachment_ids) {
      const a = room.q1<{
        state: string;
        creator_device_id: string;
        question_id: string;
        bound: number;
        ciphertext_bytes: number;
      }>(
        `SELECT state, creator_device_id, question_id, bound, ciphertext_bytes FROM attachments WHERE attachment_id = ?`,
        id,
      );
      if (
        !a ||
        a.state !== 'available' ||
        a.creator_device_id !== auth.deviceId ||
        a.question_id !== record.question_id ||
        a.bound
      ) {
        throw bad(`attachment ${id} is not available for this question`);
      }
      bytes += a.ciphertext_bytes;
    }
    if (bytes > LIMITS.attachmentTotalBytes) throw bad('attachments exceed the per-question limit');
    for (const id of record.attachment_ids)
      room.run(`UPDATE attachments SET bound = 1 WHERE attachment_id = ?`, id);

    const createdAt = t;
    room.run(
      `INSERT INTO questions (question_id, creator_device_id, target_host_id, origin_ref, requirement, key_epoch,
         record_json, envelope_json, envelope_digest, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.question_id,
      auth.deviceId,
      record.target_host_id,
      record.origin_ref,
      record.requirement,
      record.key_epoch,
      JSON.stringify(record),
      JSON.stringify(envelope),
      record.envelope_digest,
      createdAt,
      expiresAt,
    );
    const ev = room.emit('decision.created', {
      questionId: record.question_id,
      revision: 0,
      deviceId: auth.deviceId,
      data: {
        record,
        envelope,
        requirement: record.requirement,
        target_host_id: record.target_host_id,
        expires_at: record.expires_at,
      },
    });
    room.run(
      `UPDATE questions SET last_event_seq = ? WHERE question_id = ?`,
      ev.seq,
      record.question_id,
    );

    const grace = record.requirement === 'human-required' ? 0 : PROXY_GRACE_MS;
    room.schedule({ kind: 'notify_new', runAt: t + grace, questionId: record.question_id });
    scheduleReminders(room, record.question_id, t);
    if (expiresAt !== null)
      room.schedule({ kind: 'expire', runAt: expiresAt, questionId: record.question_id });

    const res = {
      question_id: record.question_id,
      revision: 0,
      status: 'open',
      event_seq: ev.seq,
      created_at: iso(createdAt),
    };
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

/* ---------------- actions ---------------- */

function actionHandler(kind: ActionKind): Handler {
  return async (room, c) => {
    const auth = c.auth!;
    const qid = c.params[0]!;
    const body = c.body(ActionBody);
    const { record, envelope } = body.action;
    const bad = (m: string) => new ApiError('validation_error', m);
    if (record.action !== kind) throw bad(`record.action must be ${kind}`);
    if (record.question_id !== qid) throw bad('question id mismatch');
    if (
      record.installation_id !== auth.installationId ||
      record.signer_device_id !== auth.deviceId
    ) {
      throw bad('record does not belong to the authenticated device');
    }
    // Phone images (docs/protocol.md section 17) need upload binding this relay does not implement yet, and it
    // does not advertise `phone-images-v1`: an answer naming images could never have them.
    if (record.attachment_ids?.length) throw bad('this relay does not accept phone images yet');
    const afterRevision = BUMPS.has(kind) ? record.expected_revision + 1 : record.expected_revision;
    if (envelope) {
      checkEnvelopeBinding(
        envelope,
        {
          installation: auth.installationId,
          questionId: qid,
          recordType: kind,
          revision: afterRevision,
          sender: auth.deviceId,
          purpose: 'answer-content',
        },
        room.currentEpoch(),
      );
      if ((await sha256Hex(canonicalize(envelope))) !== record.envelope_digest)
        throw bad('envelope digest mismatch');
    }
    const signer = room.getDevice(auth.deviceId)!;
    if (!(await verifyObject(await room.devicePublicKey(signer), record)))
      throw bad('record signature invalid');
    const digest = await c.bodyDigest();

    // Apply (and commit) overdue expiries first, then decide inside one synchronous transaction.
    await sweepExpired(room);

    return room.tx((): ApiResponse => {
      // Everything above awaited: re-validate the actor now, inside the final synchronous section.
      room.assertActive(auth.deviceId);
      const t = nowMs();
      const receipt = room.q1<{ request_digest: string; status: number; response_json: string }>(
        `SELECT request_digest, status, response_json FROM command_receipts WHERE device_id = ? AND idempotency_key = ?`,
        auth.deviceId,
        body.idempotency_key,
      );
      if (receipt) {
        if (receipt.request_digest !== digest)
          throw new ApiError(
            'idempotency_collision',
            'idempotency key reused with a different body',
          );
        return { status: receipt.status, body: receipt.response_json };
      }
      const q = room.q1<QuestionRow>(`SELECT * FROM questions WHERE question_id = ?`, qid);
      if (!q) throw new ApiError('not_found', 'no such question');
      const dup = room.q1<{ revision: number; event_seq: number }>(
        `SELECT revision, event_seq FROM actions WHERE action_id = ?`,
        record.action_id,
      );
      if (dup) {
        // An action id is only a retry if it is the very same signed command; anything else is a collision.
        const stored = room.q1<{
          question_id: string;
          actor_device_id: string;
          record_json: string;
        }>(
          `SELECT question_id, actor_device_id, record_json FROM actions WHERE action_id = ?`,
          record.action_id,
        )!;
        const storedSig = (JSON.parse(stored.record_json) as { signature?: string }).signature;
        if (
          stored.question_id !== qid ||
          stored.actor_device_id !== auth.deviceId ||
          storedSig !== record.signature
        ) {
          throw new ApiError(
            'idempotency_collision',
            'action id already used by a different command',
          );
        }
        return json(200, {
          question_id: qid,
          revision: q.revision,
          status: q.status,
          event_seq: dup.event_seq,
        });
      }

      // A deadline may have passed since the sweep: expire this question now and commit that, never answer it.
      if (q.status === 'open' && q.expires_at != null && q.expires_at <= t) {
        expireQuestionNow(room, q);
        return errorResponse(new ApiError('expired', 'question expired'), c.req.requestId);
      }

      const tr = applyAction(
        {
          status: q.status,
          revision: q.revision,
          requirement: q.requirement,
          proxyAbstained: Boolean(q.proxy_abstained),
        },
        kind,
        auth.role,
        record.expected_revision,
      );

      if (tr.noop) {
        return json(200, {
          question_id: qid,
          revision: q.revision,
          status: q.status,
          event_seq: q.last_event_seq,
        });
      }

      let newExpires = q.expires_at;
      if (kind === 'confirm-proxy') {
        const latestProxy = room.q1<{ action_id: string }>(
          `SELECT action_id FROM actions WHERE question_id = ? AND action = 'proxy-answer' ORDER BY event_seq DESC LIMIT 1`,
          qid,
        );
        if (!latestProxy || record.confirms_action_id !== latestProxy.action_id) {
          throw bad('confirms_action_id must reference the latest proxy answer');
        }
      }
      if (kind === 'reopen') {
        assertQuota(room, q.origin_ref);
        newExpires = record.expires_at ? Date.parse(record.expires_at) : null;
        if (
          newExpires !== null &&
          (newExpires <= t || newExpires > t + LIMITS.maxQuestionExpiryMs)
        ) {
          throw bad('expires_at must be in the future (or null)');
        }
      }
      const provenance = provenanceForAction(kind);
      const terminal = tr.status === 'human-answered' || tr.status === 'cancelled';
      room.run(
        `UPDATE questions SET status = ?, revision = ?, proxy_abstained = ?, resolved_at = ?, expires_at = ? WHERE question_id = ?`,
        tr.status,
        tr.revision,
        tr.proxyAbstained ? 1 : 0,
        terminal ? t : null,
        newExpires,
        qid,
      );
      const ev = room.emit(tr.eventType, {
        questionId: qid,
        revision: tr.revision,
        deviceId: auth.deviceId,
        data: {
          action: kind,
          record,
          envelope,
          provenance: provenance === 'none' ? null : provenance,
          status: tr.status,
          revision: tr.revision,
          target_host_id: q.target_host_id,
          deliverable: tr.deliverable,
        },
      });
      room.run(`UPDATE questions SET last_event_seq = ? WHERE question_id = ?`, ev.seq, qid);
      room.run(
        `INSERT INTO actions (action_id, question_id, action, revision, provenance, actor_device_id, record_json, envelope_json, created_at, event_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.action_id,
        qid,
        kind,
        tr.revision,
        provenance === 'none' ? null : provenance,
        auth.deviceId,
        JSON.stringify(record),
        envelope ? JSON.stringify(envelope) : null,
        t,
        ev.seq,
      );
      if (tr.deliverable) {
        room.run(
          `INSERT INTO deliveries (question_id, answer_revision, target_host_id, event_seq, status) VALUES (?, ?, ?, ?, 'relay-queued')`,
          qid,
          tr.revision,
          q.target_host_id,
          ev.seq,
        );
      }
      scheduleAfterAction(room, kind, q, tr.status, newExpires, t);

      const res = { question_id: qid, revision: tr.revision, status: tr.status, event_seq: ev.seq };
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
}

function scheduleAfterAction(
  room: Room,
  kind: ActionKind,
  q: QuestionRow,
  status: QuestionStatus,
  expiresAt: number | null,
  t: number,
): void {
  const id = q.question_id;
  switch (kind) {
    case 'answer':
    case 'cancel':
      room.cancelJobs({ questionId: id });
      room.schedule({ kind: 'delete_attachments', runAt: t + retentionMs(room), questionId: id });
      break;
    case 'override':
    case 'confirm-proxy':
      room.cancelJobs({
        questionId: id,
        kinds: ['proxy_review', 'remind', 'notify_new', 'expire'],
      });
      if (status === 'human-answered')
        room.schedule({ kind: 'delete_attachments', runAt: t + retentionMs(room), questionId: id });
      break;
    case 'proxy-answer':
      room.cancelJobs({ questionId: id, kinds: ['remind', 'notify_new', 'expire'] });
      if (room.settings().proxy_review_reminder) {
        room.schedule({
          kind: 'proxy_review',
          runAt: t + DEFAULTS.proxyReviewReminderMs,
          questionId: id,
        });
      }
      // The human is told right away that a proxy answered on their behalf (not content, just attention).
      room.schedule({
        kind: 'notify_new',
        runAt: t,
        questionId: id,
        payload: { type: 'decision-proxy' },
      });
      break;
    case 'proxy-abstain':
      room.cancelJobs({ questionId: id, kinds: ['notify_new'] });
      room.schedule({ kind: 'notify_new', runAt: t, questionId: id });
      break;
    case 'reopen':
      room.cancelJobs({ questionId: id, kinds: ['delete_attachments'] });
      room.schedule({ kind: 'notify_new', runAt: t, questionId: id });
      scheduleReminders(room, id, t);
      if (expiresAt !== null) room.schedule({ kind: 'expire', runAt: expiresAt, questionId: id });
      break;
  }
}

export const answer = actionHandler('answer');
export const override = actionHandler('override');
export const proxyAnswer = actionHandler('proxy-answer');
export const proxyAbstain = actionHandler('proxy-abstain');
export const confirmProxy = actionHandler('confirm-proxy');
export const cancel = actionHandler('cancel');
export const reopen = actionHandler('reopen');

/* ---------------- reads ---------------- */

export const listQuestions: Handler = async (room, c) => {
  await sweepExpired(room);
  const params = new URLSearchParams(c.req.query);
  const limit = Math.min(Math.max(Number(params.get('limit') ?? '30') || 30, 1), 50);
  const statuses = (params.get('status') ?? '')
    .split(',')
    .filter((s) =>
      ['open', 'proxy-answered', 'human-answered', 'cancelled', 'expired'].includes(s),
    );
  const cursor = params.get('cursor');
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (statuses.length) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    binds.push(...statuses);
  }
  if (cursor) {
    const m = /^(\d+):([A-Za-z0-9_-]+)$/.exec(cursor);
    if (!m) throw new ApiError('validation_error', 'bad cursor');
    where.push(`(created_at < ? OR (created_at = ? AND question_id < ?))`);
    binds.push(Number(m[1]), Number(m[1]), m[2]!);
  }
  const rows = room.q<QuestionRow>(
    `SELECT * FROM questions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, question_id DESC LIMIT ?`,
    ...binds,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return json(200, {
    questions: page.map(summary),
    next_cursor: rows.length > limit && last ? `${last.created_at}:${last.question_id}` : null,
  });
};

export const getQuestion: Handler = async (room, c) => {
  await sweepExpired(room);
  const id = c.params[0]!;
  const q = room.q1<QuestionRow>(`SELECT * FROM questions WHERE question_id = ?`, id);
  if (!q) throw new ApiError('not_found', 'no such question');
  const actions = room.q<{
    action_id: string;
    action: string;
    revision: number;
    provenance: string | null;
    actor_device_id: string;
    record_json: string;
    envelope_json: string | null;
    created_at: number;
    event_seq: number;
  }>(`SELECT * FROM actions WHERE question_id = ? ORDER BY event_seq`, id);
  const attachments = room.q<{ attachment_id: string; state: string; ciphertext_bytes: number }>(
    `SELECT attachment_id, state, ciphertext_bytes FROM attachments WHERE question_id = ? ORDER BY created_at`,
    id,
  );
  const deliveries = room.q<{
    answer_revision: number;
    target_host_id: string;
    status: string;
    received_at: number | null;
    terminal_delivered_at: number | null;
    injection_id: string | null;
    error_code: string | null;
  }>(`SELECT * FROM deliveries WHERE question_id = ? ORDER BY answer_revision`, id);
  return json(200, {
    ...summary(q),
    question: {
      record: JSON.parse(q.record_json) as QuestionRecord,
      envelope: JSON.parse(q.envelope_json) as CryptoEnvelope,
    },
    actions: actions.map((a) => ({
      action_id: a.action_id,
      action: a.action,
      revision: a.revision,
      provenance: a.provenance,
      actor_device_id: a.actor_device_id,
      created_at: iso(a.created_at),
      event_seq: a.event_seq,
      record: JSON.parse(a.record_json) as ActionRecord,
      envelope: a.envelope_json ? (JSON.parse(a.envelope_json) as CryptoEnvelope) : null,
    })),
    attachments: attachments.map((a) => ({
      ...a,
      state: a.state === 'uploading' ? 'reserved' : a.state,
    })),
    deliveries: deliveries.map((d) => ({
      answer_revision: d.answer_revision,
      target_host_id: d.target_host_id,
      status: d.status,
      received_at: isoOrNull(d.received_at),
      terminal_delivered_at: isoOrNull(d.terminal_delivered_at),
      injection_id: d.injection_id,
      error_code: d.error_code,
    })),
  });
};

export const deleteQuestion: Handler = async (room, c) => {
  const id = c.params[0]!;
  await room.tx(() => {
    const q = room.q1<QuestionRow>(`SELECT * FROM questions WHERE question_id = ?`, id);
    if (!q) throw new ApiError('not_found', 'no such question');
    room.cancelJobs({ questionId: id });
    room.run(`DELETE FROM actions WHERE question_id = ?`, id);
    room.run(`DELETE FROM deliveries WHERE question_id = ?`, id);
    room.run(`DELETE FROM events WHERE question_id = ?`, id);
    room.run(`DELETE FROM questions WHERE question_id = ?`, id);
    room.schedule({
      kind: 'delete_attachments',
      runAt: nowMs(),
      questionId: id,
      payload: { force: true },
    });
    room.emit('decision.deleted', {
      questionId: id,
      deviceId: c.auth!.deviceId,
      data: { question_id: id },
    });
  });
  return json(200, { ok: true });
};
