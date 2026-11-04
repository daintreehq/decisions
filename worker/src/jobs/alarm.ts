import {
  DEFAULTS,
  bytesToBase64Url,
  threadAwaitsHuman,
  type MessageSide,
} from '@daintreehq/decisions-protocol';
import { sha256 } from '@daintreehq/decisions-crypto';
import { nextAllowed } from '../push/quiet-hours.js';
import type { Room } from '../room/types.js';
import { expireQuestionNow, type QuestionRow } from '../routes/questions.js';
import { nowMs } from '../util.js';
import { sendNotification, type PushPayload } from './notify.js';

interface JobRow {
  job_id: string;
  kind: string;
  question_id: string | null;
  attachment_id: string | null;
  payload: string;
  run_at: number;
  attempt_count: number;
}

type Outcome = { deferUntil: number } | void;

const MAX_ATTEMPTS = 8;

export async function processDueJobs(room: Room): Promise<void> {
  const t = nowMs();
  const due = room.q<JobRow>(
    `SELECT * FROM scheduled_jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 50`,
    t,
  );
  for (const job of due) {
    const still = room.q1<{ status: string }>(
      `SELECT status FROM scheduled_jobs WHERE job_id = ?`,
      job.job_id,
    );
    if (still?.status !== 'pending') continue;
    try {
      const out = await runJob(room, job);
      if (out && 'deferUntil' in out) {
        room.run(
          `UPDATE scheduled_jobs SET run_at = ? WHERE job_id = ? AND status = 'pending'`,
          out.deferUntil,
          job.job_id,
        );
      } else {
        room.run(
          `UPDATE scheduled_jobs SET status = 'done' WHERE job_id = ? AND status = 'pending'`,
          job.job_id,
        );
      }
    } catch {
      const attempts = job.attempt_count + 1;
      if (attempts >= MAX_ATTEMPTS) {
        room.run(
          `UPDATE scheduled_jobs SET status = 'failed', attempt_count = ? WHERE job_id = ?`,
          attempts,
          job.job_id,
        );
      } else {
        const backoff = Math.min(
          DEFAULTS.jobBackoffBaseMs * 2 ** attempts,
          DEFAULTS.jobBackoffMaxMs,
        );
        const jitter = Math.floor(Math.random() * backoff * 0.3);
        room.run(
          `UPDATE scheduled_jobs SET attempt_count = ?, run_at = ? WHERE job_id = ? AND status = 'pending'`,
          attempts,
          nowMs() + backoff + jitter,
          job.job_id,
        );
      }
    }
  }
}

async function topicFor(questionId: string): Promise<string> {
  return bytesToBase64Url(await sha256(questionId)).slice(0, 32);
}

const getQuestion = (room: Room, id: string | null) =>
  id ? room.q1<QuestionRow>(`SELECT * FROM questions WHERE question_id = ?`, id) : undefined;

/** An overdue open question is already expired in effect; the expire job just has not run yet. */
const isOverdue = (q: QuestionRow) =>
  q.status === 'open' && q.expires_at != null && q.expires_at <= nowMs();

const isTransient = (status: number | null) => status === null || status === 429 || status >= 500;

/**
 * Push jobs honour quiet hours by deferring (never delaying data sync). Subscriptions that already got this
 * notification are remembered in the job payload so a retry only targets the ones that transiently failed.
 */
async function pushJob(
  room: Room,
  job: JobRow,
  q: QuestionRow,
  type: Exclude<PushPayload['type'], 'test'>,
  urgency: 'normal' | 'high',
): Promise<Outcome> {
  const t = nowMs();
  const when = nextAllowed(t, room.settings().quiet_hours);
  if (when > t) return { deferUntil: when };
  const payload = JSON.parse(job.payload) as Record<string, unknown>;
  const done = new Set<string>(Array.isArray(payload.done) ? (payload.done as string[]) : []);
  const results = await sendNotification(
    room,
    { type, question_id: q.question_id },
    { topic: await topicFor(q.question_id), urgency, skip: done },
  );
  for (const r of results) if (r.ok) done.add(r.subscription_id);
  if (results.some((r) => !r.ok && isTransient(r.status))) {
    room.run(
      `UPDATE scheduled_jobs SET payload = ? WHERE job_id = ?`,
      JSON.stringify({ ...payload, done: [...done] }),
      job.job_id,
    );
    throw new Error('push delivery failed transiently');
  }
}

/**
 * Whether an agent message still waits on the person (`threadAwaitsHuman`): a reply push deferred by quiet hours
 * or a retry is dropped once the person has written or answered since, or the thread closed.
 */
function threadAwaitsPerson(room: Room, questionId: string, status: QuestionRow['status']): boolean {
  const messages = room
    .q<{ side: MessageSide; expects_reply: number; event_seq: number }>(
      `SELECT side, expects_reply, event_seq FROM messages WHERE question_id = ?`,
      questionId,
    )
    .map((m) => ({ side: m.side, expects_reply: Boolean(m.expects_reply), event_seq: m.event_seq }));
  const lastHuman = room.q1<{ s: number | null }>(
    `SELECT MAX(event_seq) AS s FROM actions WHERE question_id = ? AND provenance = 'human'`,
    questionId,
  )?.s;
  return threadAwaitsHuman({ status, messages, lastHumanActionSeq: lastHuman ?? null });
}

/** Marks every not-yet-removed attachment of a question as deleted, synchronously, and returns what to purge. */
function claimAttachmentsForDeletion(
  room: Room,
  questionId: string,
  force: boolean,
): { attachment_id: string; object_key: string }[] {
  const q = getQuestion(room, questionId);
  if (q && !force && (q.status === 'open' || q.status === 'proxy-answered')) return [];
  const rows = room.q<{ attachment_id: string; object_key: string }>(
    `SELECT attachment_id, object_key FROM attachments WHERE question_id = ? AND object_deleted = 0`,
    questionId,
  );
  // The claim happens in the same synchronous section as the check above, so binding or reopening
  // cannot slip in while R2 is being cleaned: they require state 'available'.
  room.run(
    `UPDATE attachments SET state = 'deleted', deleted_at = COALESCE(deleted_at, ?) WHERE question_id = ? AND object_deleted = 0`,
    nowMs(),
    questionId,
  );
  return rows;
}

async function runJob(room: Room, job: JobRow): Promise<Outcome> {
  const payload = JSON.parse(job.payload) as Record<string, unknown>;
  switch (job.kind) {
    case 'notify_new': {
      const q = getQuestion(room, job.question_id);
      if (!q || isOverdue(q)) return;
      const type = payload.type === 'decision-proxy' ? 'decision-proxy' : 'decision-new';
      if (type === 'decision-new' && q.status !== 'open') return;
      if (type === 'decision-proxy' && q.status !== 'proxy-answered') return;
      return pushJob(room, job, q, type, 'high');
    }
    case 'notify_reply': {
      const q = getQuestion(room, job.question_id);
      if (!q || isOverdue(q) || !threadAwaitsPerson(room, q.question_id, q.status)) return;
      return pushJob(room, job, q, 'decision-reply', 'high');
    }
    case 'remind': {
      const q = getQuestion(room, job.question_id);
      const s = room.settings().reminders;
      if (!q || q.status !== 'open' || isOverdue(q) || !s?.enabled) return;
      const n = Number(payload.n ?? 1);
      if (n > s.max) return;
      const out = await pushJob(room, job, q, 'decision-reminder', 'normal');
      if (out) return out;
      if (n < s.max) {
        await room.tx(() => {
          // The question may have been answered, cancelled, or reopened (starting a fresh chain) while we sent.
          const still = room.q1<{ status: string }>(
            `SELECT status FROM scheduled_jobs WHERE job_id = ?`,
            job.job_id,
          );
          const fresh = getQuestion(room, job.question_id);
          if (still?.status !== 'pending' || !fresh || fresh.status !== 'open') return;
          room.schedule({
            kind: 'remind',
            runAt: nowMs() + s.interval_ms,
            questionId: q.question_id,
            payload: { n: n + 1 },
          });
        });
      }
      return;
    }
    case 'proxy_review': {
      const q = getQuestion(room, job.question_id);
      if (!q || q.status !== 'proxy-answered' || !room.settings().proxy_review_reminder) return;
      return pushJob(room, job, q, 'decision-proxy', 'normal');
    }
    case 'expire': {
      const q = getQuestion(room, job.question_id);
      if (!q) return;
      await room.tx(() => {
        const fresh = getQuestion(room, job.question_id);
        if (fresh) expireQuestionNow(room, fresh);
      });
      return;
    }
    case 'delete_attachments': {
      const claimed = claimAttachmentsForDeletion(
        room,
        job.question_id ?? '',
        Boolean(payload.force),
      );
      for (const a of claimed) {
        await room.env.ATTACHMENTS.delete(a.object_key);
        room.run(
          `UPDATE attachments SET object_deleted = 1 WHERE attachment_id = ?`,
          a.attachment_id,
        );
      }
      return;
    }
    case 'gc_orphan': {
      const a = room.q1<{ object_key: string; bound: number; object_deleted: number }>(
        `SELECT object_key, bound, object_deleted FROM attachments WHERE attachment_id = ?`,
        job.attachment_id ?? '',
      );
      if (!a || a.bound || a.object_deleted) return;
      // Claim first (binding requires state 'available'), then remove the object.
      room.run(
        `UPDATE attachments SET state = 'deleted', deleted_at = ? WHERE attachment_id = ? AND bound = 0`,
        nowMs(),
        job.attachment_id ?? '',
      );
      await room.env.ATTACHMENTS.delete(a.object_key);
      room.run(
        `UPDATE attachments SET object_deleted = 1 WHERE attachment_id = ?`,
        job.attachment_id ?? '',
      );
      return;
    }
    case 'purge': {
      const t = nowMs();
      room.run(`DELETE FROM request_nonces WHERE expires_at < ?`, t);
      room.run(`DELETE FROM tickets WHERE expires_at < ?`, t);
      room.run(`DELETE FROM rate_limits WHERE window_start < ?`, t - 86_400_000);
      room.run(`DELETE FROM command_receipts WHERE created_at < ?`, t - 30 * 86_400_000);
      room.run(`DELETE FROM voice_sessions WHERE started_at < ?`, t - 2 * 86_400_000);
      room.run(
        `DELETE FROM scheduled_jobs WHERE status != 'pending' AND run_at < ?`,
        t - 7 * 86_400_000,
      );
      await room.tx(() => room.schedule({ kind: 'purge', runAt: t + 86_400_000 }));
      return;
    }
    default:
      return;
  }
}
