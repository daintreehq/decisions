import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MemoryLocalStore,
  SQLITE_SCHEMA_VERSION,
  SqliteLocalStore,
  type LocalStore,
  type OutboxItem,
  type QuestionRow,
} from '../src/index.js';
import { origin, setupBridge } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'decisions-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const row = (id: string, alias: number, over: Partial<QuestionRow> = {}): QuestionRow => ({
  question_id: id,
  alias,
  origin: origin(),
  requirement: 'human-required',
  question_revision: 0,
  remote_event_seq: null,
  origin_created_at: '2026-11-01T00:00:00.000Z',
  expires_at: null,
  local_status: 'queued',
  delivery_status: 'not-sent',
  last_injection_id: null,
  last_attempt_at: null,
  agent_resume_strategy: null,
  error_code: null,
  content_sealed: '{"sealed":1}',
  answers_json: '[]',
  history_only: false,
  delivered_revision: 0,
  attachment_digests: ['a'.repeat(64)],
  ...over,
});
const item = (id: string, qid: string, at = 1): OutboxItem => ({
  id,
  kind: 'create',
  question_id: qid,
  payload: { n: 1 },
  attempts: 0,
  next_attempt_at: at,
  created_at: at,
  last_error: null,
});

let n = 0;
const impls: [string, () => LocalStore][] = [
  ['memory', () => new MemoryLocalStore()],
  ['sqlite', () => new SqliteLocalStore(join(dir, `s${n++}.db`))],
];

describe.each(impls)('LocalStore contract: %s', (_name, make) => {
  it('round-trips a question with its full origin map and JSON fields', async () => {
    const s = make();
    await s.commitNewQuestion(row('q1', 1), item('o1', 'q1'));
    const got = (await s.getQuestion('q1'))!;
    expect(got.origin).toEqual(origin());
    expect(got.origin.ownership_principal).toBe('principal-1');
    expect(got.origin.agent_incarnation).toBe('inc-1');
    expect(got.attachment_digests).toEqual(['a'.repeat(64)]);
    expect(got.history_only).toBe(false);
    await s.updateQuestion('q1', {
      local_status: 'open',
      remote_event_seq: 7,
      origin: { ...origin(), pane_id: 'pane-9', ownership_principal: 'principal-9' },
    });
    const up = (await s.getQuestion('q1'))!;
    expect(up).toMatchObject({ local_status: 'open', remote_event_seq: 7 });
    expect(up.origin.pane_id).toBe('pane-9');
    expect(up.origin.ownership_principal).toBe('principal-9');
    expect(up.origin.worktree_root).toBe('/work/proj-1');
  });
  it('commits question and outbox item atomically; duplicates fail without a stray outbox row', async () => {
    const s = make();
    await s.commitNewQuestion(row('q1', 1), item('o1', 'q1'));
    await expect(s.commitNewQuestion(row('q1', 2), item('o2', 'q1'))).rejects.toThrow();
    expect((await s.outboxFor('q1')).map((o) => o.id)).toEqual(['o1']);
  });
  it('aliases are monotonic', async () => {
    const s = make();
    expect([await s.nextAlias(), await s.nextAlias(), await s.nextAlias()]).toEqual([1, 2, 3]);
  });
  it('outbox: due ordering, failure backoff, delete', async () => {
    const s = make();
    await s.commitNewQuestion(row('q1', 1), item('o1', 'q1', 10));
    await s.commitNewQuestion(row('q2', 2), item('o2', 'q2', 5));
    expect((await s.dueOutbox(100, 10)).map((o) => o.id)).toEqual(['o2', 'o1']);
    await s.recordOutboxFailure('o2', 'network_error', 1000);
    const due = await s.dueOutbox(100, 10);
    expect(due.map((o) => o.id)).toEqual(['o1']);
    const failed = (await s.outboxFor('q2'))[0]!;
    expect(failed).toMatchObject({ attempts: 1, last_error: 'network_error', payload: { n: 1 } });
    await s.deleteOutbox('o1');
    expect(await s.outboxFor('q1')).toEqual([]);
  });
  it('events: duplicate insert is ignored; cursor only advances over contiguous seqs', async () => {
    const s = make();
    const ev = (seq: number) => ({
      seq,
      event_id: `e${seq}`,
      event_type: 'decision.created',
      json: '{}',
      received_at: 1,
      processed_at: null,
    });
    expect(await s.insertEvent(ev(1))).toBe(true);
    expect(await s.insertEvent(ev(1))).toBe(false);
    await s.insertEvent(ev(3));
    expect(await s.advanceCursor()).toBe(1);
    await s.insertEvent(ev(2));
    expect(await s.advanceCursor()).toBe(3);
    await s.forceCursor(2); // never moves backwards
    expect(await s.getCursor()).toBe(3);
    await s.forceCursor(9);
    expect(await s.getCursor()).toBe(9);
    await s.markEventProcessed(1, 5);
    expect((await s.unprocessedEvents(10)).map((e) => e.seq)).toEqual([2, 3]);
  });
  it('intents, pane counts, audit', async () => {
    const s = make();
    await s.commitNewQuestion(row('q1', 1, { local_status: 'open' }), item('o1', 'q1'));
    await s.commitNewQuestion(
      row('q2', 2, { origin: origin({ pane_id: 'p2' }) }),
      item('o2', 'q2'),
    );
    expect(await s.countOpenForPane('host-local', 'pane-1')).toBe(1);
    const base = {
      injection_id: 'i1',
      question_id: 'q1',
      answer_revision: 1,
      host_id: 'h',
      pane_id: 'p',
      terminal_generation: 1,
      ownership_principal: 'principal-1',
      agent_incarnation: 'inc-1',
      created_at: 1,
      updated_at: 1,
    };
    await s.putIntent({ ...base, state: 'intent' });
    await s.putIntent({ ...base, injection_id: 'i2', state: 'acked' });
    expect((await s.openIntents()).map((i) => i.injection_id)).toEqual(['i1']);
    expect(await s.getIntent('i1')).toMatchObject({
      ownership_principal: 'principal-1',
      agent_incarnation: 'inc-1',
    });
    await s.updateIntent('i1', { state: 'uncertain' });
    expect(await s.openIntents()).toEqual([]);
    await s.appendAudit({ at: 'a', event: 'x', question_id: 'q1' });
    await s.appendAudit({ at: 'b', event: 'y' });
    expect((await s.listAudit(10)).map((a) => a.event)).toEqual(['x', 'y']);
  });
});

describe.each(impls)('atomic intent settlement: %s', (_n, make) => {
  const base = {
    injection_id: 'i1',
    question_id: 'q1',
    answer_revision: 1,
    host_id: 'h',
    pane_id: 'p',
    terminal_generation: 1,
    ownership_principal: 'principal-1',
    agent_incarnation: 'inc-1',
    created_at: 1,
    updated_at: 1,
  };
  it('settleIntent updates the intent and the question together; hasUncertainIntent reflects it', async () => {
    const s = make();
    await s.commitNewQuestion(row('q1', 1, { local_status: 'open' }), item('o1', 'q1'));
    await s.putIntent({ ...base, state: 'intent' });
    expect(await s.hasUncertainIntent('q1')).toBe(false);
    await s.settleIntent('i1', { state: 'uncertain', updated_at: 9 }, 'q1', {
      delivery_status: 'delivery-uncertain',
      error_code: 'x',
    });
    expect(await s.hasUncertainIntent('q1')).toBe(true);
    expect((await s.getIntent('i1'))!.state).toBe('uncertain');
    expect(await s.getQuestion('q1')).toMatchObject({
      delivery_status: 'delivery-uncertain',
      error_code: 'x',
    });
    expect(await s.hasUncertainIntent('other')).toBe(false);
  });
  it('concurrent partial updates do not clobber each other', async () => {
    const s = make();
    await s.commitNewQuestion(row('q1', 1), item('o1', 'q1'));
    await Promise.all([
      s.updateQuestion('q1', { local_status: 'open' }),
      s.updateQuestion('q1', { delivery_status: 'desktop-received' }),
      s.updateQuestion('q1', { error_code: 'e' }),
    ]);
    expect(await s.getQuestion('q1')).toMatchObject({
      local_status: 'open',
      delivery_status: 'desktop-received',
      error_code: 'e',
    });
  });
});

describe('SqliteLocalStore specifics', () => {
  it('is fully synchronous (FULL) so an injection intent is on disk before the terminal is touched', async () => {
    const s = new SqliteLocalStore(join(dir, 'sync.db'));
    expect(s.durable).toBe(true);
    const db = (s as unknown as { db: DatabaseSync }).db;
    expect((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2);
    await s.close();
    expect(new MemoryLocalStore().durable).toBe(false);
  });
  it('versions the schema, uses WAL and survives a reopen', async () => {
    const path = join(dir, 'persist.db');
    const a = new SqliteLocalStore(path);
    await a.commitNewQuestion(row('q1', 1), item('o1', 'q1'));
    await a.setMeta('k', 'v');
    await a.close();
    const b = new SqliteLocalStore(path);
    expect((await b.getQuestion('q1'))!.question_id).toBe('q1');
    expect(await b.getMeta('k')).toBe('v');
    await b.close();
    const raw = new DatabaseSync(path);
    expect(
      (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(SQLITE_SCHEMA_VERSION);
    expect(
      (raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
    ).toBe('wal');
    raw.close();
  });
});

/** The schema exactly as version 1 shipped it, with one question and one open intent written by that build. */
function writeVersion1Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE questions (
     question_id TEXT PRIMARY KEY, alias INTEGER NOT NULL UNIQUE, origin_host_id TEXT NOT NULL,
     pane_id TEXT NOT NULL, terminal_generation INTEGER NOT NULL, agent_kind TEXT NOT NULL,
     agent_session_id TEXT, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
     worktree_root TEXT NOT NULL, workflow_gate_id TEXT, requirement TEXT NOT NULL,
     question_revision INTEGER NOT NULL DEFAULT 0, remote_event_seq INTEGER,
     origin_created_at TEXT NOT NULL, expires_at TEXT, local_status TEXT NOT NULL,
     delivery_status TEXT NOT NULL, last_injection_id TEXT, last_attempt_at TEXT,
     agent_resume_strategy TEXT, error_code TEXT, content_json TEXT,
     answers_json TEXT NOT NULL DEFAULT '[]', history_only INTEGER NOT NULL DEFAULT 0,
     delivered_revision INTEGER NOT NULL DEFAULT 0, attachment_digests TEXT NOT NULL DEFAULT '[]'
   );
   CREATE INDEX questions_pane ON questions(origin_host_id, pane_id);
   CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, question_id TEXT NOT NULL,
     payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL, last_error TEXT);
   CREATE INDEX outbox_due ON outbox(next_attempt_at);
   CREATE TABLE inbound_events (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
     event_type TEXT NOT NULL, json TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER);
   CREATE TABLE injection_intents (injection_id TEXT PRIMARY KEY, question_id TEXT NOT NULL,
     answer_revision INTEGER NOT NULL, host_id TEXT NOT NULL, pane_id TEXT NOT NULL,
     terminal_generation INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL);
   CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, json TEXT NOT NULL);
   PRAGMA user_version = 1;`);
  db.prepare(
    `INSERT INTO questions(question_id, alias, origin_host_id, pane_id, terminal_generation, agent_kind,
       agent_session_id, project_id, worktree_id, worktree_root, workflow_gate_id, requirement,
       origin_created_at, local_status, delivery_status, content_json)
     VALUES('legacy-q', 1, 'host-local', 'pane-1', 1, 'claude', 'sess-1', 'proj-1', 'wt-1', '/work/proj-1',
       NULL, 'human-required', '2026-10-01T00:00:00.000Z', 'open', 'not-sent', '{"q":1}')`,
  ).run();
  db.prepare(
    `INSERT INTO injection_intents VALUES('legacy-i', 'legacy-q', 1, 'host-local', 'pane-1', 1, 'intent', 1, 1)`,
  ).run();
  db.close();
}

const userVersion = (path: string): number => {
  const raw = new DatabaseSync(path);
  try {
    return (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    raw.close();
  }
};

describe('SqliteLocalStore migrations', () => {
  it('migrates a version-1 database: rows keep their data and get an empty (never-matching) run identity', async () => {
    const path = join(dir, 'v1.db');
    writeVersion1Database(path);
    const s = new SqliteLocalStore(path);
    const q = (await s.getQuestion('legacy-q'))!;
    expect(q.origin).toMatchObject({
      host_id: 'host-local',
      pane_id: 'pane-1',
      terminal_generation: 1,
      agent_session_id: 'sess-1',
      ownership_principal: '',
      agent_incarnation: '',
    });
    expect(q.legacy_content_json).toBe('{"q":1}');
    expect(q.content_sealed).toBeNull();
    expect(await s.getIntent('legacy-i')).toMatchObject({
      state: 'intent',
      ownership_principal: '',
      agent_incarnation: '',
    });
    // rows written after the migration carry the full identity
    await s.commitNewQuestion(row('q-new', 2), item('o-new', 'q-new'));
    expect((await s.getQuestion('q-new'))!.origin.ownership_principal).toBe('principal-1');
    await s.close();
    expect(userVersion(path)).toBe(SQLITE_SCHEMA_VERSION);
    // reopening an up-to-date database runs nothing again
    const again = new SqliteLocalStore(path);
    expect((await again.getQuestion('legacy-q'))!.origin.ownership_principal).toBe('');
    await again.close();
  });

  it('a migrated question is invisible to every pane identity, including an empty one', async () => {
    const path = join(dir, 'v1-scope.db');
    writeVersion1Database(path);
    const store = new SqliteLocalStore(path);
    const { bridge } = await setupBridge({ store });
    const pane = {
      host_id: 'host-local',
      pane_id: 'pane-1',
      terminal_generation: 1,
      ownership_principal: 'principal-1',
      agent_incarnation: 'inc-1',
      agent_session_id: 'sess-1',
      worktree_id: 'wt-1',
    };
    for (const p of [pane, { ...pane, ownership_principal: '', agent_incarnation: '' }]) {
      await expect(bridge.getDecision('legacy-q', p)).rejects.toMatchObject({ code: 'not_found' });
      await expect(bridge.cancelQuestion('legacy-q', p)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(await bridge.listPending(p)).toEqual([]);
    }
    // the host's own (unscoped) view still sees it
    expect((await bridge.getDecision('legacy-q')).questionId).toBe('legacy-q');
    await store.close();
  });

  it('a failing migration rolls back and leaves the version untouched', async () => {
    const path = join(dir, 'v1-broken.db');
    writeVersion1Database(path);
    const raw = new DatabaseSync(path);
    // a column a later step of the migration adds already exists, so that step fails midway
    raw.exec("ALTER TABLE injection_intents ADD COLUMN agent_incarnation TEXT NOT NULL DEFAULT ''");
    raw.close();
    expect(() => new SqliteLocalStore(path)).toThrow();
    expect(userVersion(path)).toBe(1);
    const after = new DatabaseSync(path);
    const cols = (after.prepare('PRAGMA table_info(questions)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('ownership_principal');
    after.close();
  });
});
