import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { LocalStore } from './store.js';
import type {
  AuditEntry,
  InboundEvent,
  InjectionIntent,
  OutboxItem,
  QuestionOrigin,
  QuestionRow,
} from './types.js';

type Row = Record<string, unknown>;

/**
 * One schema step. `up` runs inside the same transaction that bumps `PRAGMA user_version`, so a step either
 * applies completely or not at all. Use SQL for schema changes and a function when rows have to be rewritten
 * in code (for example re-encoding a column). Steps are append-only: never edit one that has shipped.
 */
interface Migration {
  name: string;
  up: string | ((db: DatabaseSync) => void);
}

const MIGRATIONS: Migration[] = [
  {
    name: 'initial schema',
    up: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE questions (
     question_id TEXT PRIMARY KEY,
     alias INTEGER NOT NULL UNIQUE,
     origin_host_id TEXT NOT NULL,
     pane_id TEXT NOT NULL,
     terminal_generation INTEGER NOT NULL,
     agent_kind TEXT NOT NULL,
     agent_session_id TEXT,
     project_id TEXT NOT NULL,
     worktree_id TEXT NOT NULL,
     worktree_root TEXT NOT NULL,
     workflow_gate_id TEXT,
     requirement TEXT NOT NULL,
     question_revision INTEGER NOT NULL DEFAULT 0,
     remote_event_seq INTEGER,
     origin_created_at TEXT NOT NULL,
     expires_at TEXT,
     local_status TEXT NOT NULL,
     delivery_status TEXT NOT NULL,
     last_injection_id TEXT,
     last_attempt_at TEXT,
     agent_resume_strategy TEXT,
     error_code TEXT,
     content_json TEXT,
     answers_json TEXT NOT NULL DEFAULT '[]',
     history_only INTEGER NOT NULL DEFAULT 0,
     delivered_revision INTEGER NOT NULL DEFAULT 0,
     attachment_digests TEXT NOT NULL DEFAULT '[]'
   );
   CREATE INDEX questions_pane ON questions(origin_host_id, pane_id);
   CREATE TABLE outbox (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     question_id TEXT NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     last_error TEXT
   );
   CREATE INDEX outbox_due ON outbox(next_attempt_at);
   CREATE TABLE inbound_events (
     seq INTEGER PRIMARY KEY,
     event_id TEXT NOT NULL UNIQUE,
     event_type TEXT NOT NULL,
     json TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     processed_at INTEGER
   );
   CREATE TABLE injection_intents (
     injection_id TEXT PRIMARY KEY,
     question_id TEXT NOT NULL,
     answer_revision INTEGER NOT NULL,
     host_id TEXT NOT NULL,
     pane_id TEXT NOT NULL,
     terminal_generation INTEGER NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     json TEXT NOT NULL
   );`,
  },
  {
    // Rows from before the run identity existed get '' for both fields. The bridge refuses to register an
    // origin with an empty principal or incarnation and never matches '' against a pane, so a migrated
    // question can only be delivered through a sink that cannot tell runs apart (the standalone CLI) and is
    // never visible to an agent pane: an unknown run is treated as a different run.
    name: 'pane run identity: ownership principal and agent incarnation',
    up: `ALTER TABLE questions ADD COLUMN ownership_principal TEXT NOT NULL DEFAULT '';
   ALTER TABLE questions ADD COLUMN agent_incarnation TEXT NOT NULL DEFAULT '';
   ALTER TABLE injection_intents ADD COLUMN ownership_principal TEXT NOT NULL DEFAULT '';
   ALTER TABLE injection_intents ADD COLUMN agent_incarnation TEXT NOT NULL DEFAULT '';`,
  },
  {
    // Question content moves to a sealed column. The old `content_json` column stays, read back as
    // `legacy_content_json`, because sealing needs the identity's epoch key, which the store never holds: the
    // bridge (or `sealStoredContent`) seals every legacy row, clears the column, and compacts the file.
    name: 'sealed question content',
    up: `ALTER TABLE questions ADD COLUMN content_sealed TEXT;`,
  },
];

/** The schema version a fully migrated database reports in `PRAGMA user_version`. */
export const SQLITE_SCHEMA_VERSION = MIGRATIONS.length;

const Q_COLS = [
  'question_id',
  'alias',
  'origin_host_id',
  'pane_id',
  'terminal_generation',
  'ownership_principal',
  'agent_incarnation',
  'agent_kind',
  'agent_session_id',
  'project_id',
  'worktree_id',
  'worktree_root',
  'workflow_gate_id',
  'requirement',
  'question_revision',
  'remote_event_seq',
  'origin_created_at',
  'expires_at',
  'local_status',
  'delivery_status',
  'last_injection_id',
  'last_attempt_at',
  'agent_resume_strategy',
  'error_code',
  'content_json',
  'content_sealed',
  'answers_json',
  'history_only',
  'delivered_revision',
  'attachment_digests',
] as const;

function toRow(q: QuestionRow): Row {
  return {
    question_id: q.question_id,
    alias: q.alias,
    origin_host_id: q.origin.host_id,
    pane_id: q.origin.pane_id,
    terminal_generation: q.origin.terminal_generation,
    ownership_principal: q.origin.ownership_principal,
    agent_incarnation: q.origin.agent_incarnation,
    agent_kind: q.origin.agent_kind,
    agent_session_id: q.origin.agent_session_id,
    project_id: q.origin.project_id,
    worktree_id: q.origin.worktree_id,
    worktree_root: q.origin.worktree_root,
    workflow_gate_id: q.origin.workflow_gate_id,
    requirement: q.requirement,
    question_revision: q.question_revision,
    remote_event_seq: q.remote_event_seq,
    origin_created_at: q.origin_created_at,
    expires_at: q.expires_at,
    local_status: q.local_status,
    delivery_status: q.delivery_status,
    last_injection_id: q.last_injection_id,
    last_attempt_at: q.last_attempt_at,
    agent_resume_strategy: q.agent_resume_strategy,
    error_code: q.error_code,
    content_json: q.legacy_content_json ?? null,
    content_sealed: q.content_sealed,
    answers_json: q.answers_json,
    history_only: q.history_only ? 1 : 0,
    delivered_revision: q.delivered_revision,
    attachment_digests: JSON.stringify(q.attachment_digests),
  };
}

function fromRow(r: Row): QuestionRow {
  const origin: QuestionOrigin = {
    host_id: r.origin_host_id as string,
    pane_id: r.pane_id as string,
    terminal_generation: Number(r.terminal_generation),
    ownership_principal: r.ownership_principal as string,
    agent_incarnation: r.agent_incarnation as string,
    agent_kind: r.agent_kind as string,
    agent_session_id: (r.agent_session_id as string | null) ?? null,
    project_id: r.project_id as string,
    worktree_id: r.worktree_id as string,
    worktree_root: r.worktree_root as string,
    workflow_gate_id: (r.workflow_gate_id as string | null) ?? null,
  };
  return {
    question_id: r.question_id as string,
    alias: Number(r.alias),
    origin,
    requirement: r.requirement as QuestionRow['requirement'],
    question_revision: Number(r.question_revision),
    remote_event_seq: r.remote_event_seq == null ? null : Number(r.remote_event_seq),
    origin_created_at: r.origin_created_at as string,
    expires_at: (r.expires_at as string | null) ?? null,
    local_status: r.local_status as QuestionRow['local_status'],
    delivery_status: r.delivery_status as QuestionRow['delivery_status'],
    last_injection_id: (r.last_injection_id as string | null) ?? null,
    last_attempt_at: (r.last_attempt_at as string | null) ?? null,
    agent_resume_strategy: (r.agent_resume_strategy as string | null) ?? null,
    error_code: (r.error_code as string | null) ?? null,
    content_sealed: (r.content_sealed as string | null) ?? null,
    ...(r.content_json != null ? { legacy_content_json: r.content_json as string } : {}),
    answers_json: r.answers_json as string,
    history_only: Number(r.history_only) === 1,
    delivered_revision: Number(r.delivered_revision),
    attachment_digests: JSON.parse(r.attachment_digests as string) as string[],
  };
}

export class SqliteLocalStore implements LocalStore {
  readonly durable = true;
  private db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // secure_delete zeroes the space a deleted or rewritten row leaves behind, so content that was ever in a
    // row does not linger in free space; `compact()` also rewrites the file and empties the WAL.
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;',
    );
    this.migrate();
  }

  private migrate(): void {
    const v = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    for (let i = v; i < MIGRATIONS.length; i++) {
      const step = MIGRATIONS[i]!;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (typeof step.up === 'string') this.db.exec(step.up);
        else step.up(this.db);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  private st(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async getMeta(key: string) {
    const r = this.st('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return r ? (r.value as string) : null;
  }
  async setMeta(key: string, value: string) {
    this.st(
      'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, value);
  }
  async nextAlias() {
    return this.tx(() => {
      const r = this.st('SELECT value FROM meta WHERE key = ?').get('alias') as Row | undefined;
      const n = (r ? Number(r.value) : 0) + 1;
      this.st(
        'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run('alias', String(n));
      return n;
    });
  }

  private insertQuestionSql(row: QuestionRow): void {
    const r = toRow(row);
    this.st(
      `INSERT INTO questions(${Q_COLS.join(',')}) VALUES(${Q_COLS.map(() => '?').join(',')})`,
    ).run(...(Q_COLS.map((c) => r[c]) as never[]));
  }
  private putOutboxSql(i: OutboxItem): void {
    this.st(
      `INSERT INTO outbox(id,kind,question_id,payload,attempts,next_attempt_at,created_at,last_error)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, next_attempt_at=excluded.next_attempt_at`,
    ).run(
      i.id,
      i.kind,
      i.question_id,
      JSON.stringify(i.payload),
      i.attempts,
      i.next_attempt_at,
      i.created_at,
      i.last_error,
    );
  }

  async commitNewQuestion(row: QuestionRow, outbox: OutboxItem) {
    this.tx(() => {
      this.insertQuestionSql(row);
      this.putOutboxSql(outbox);
    });
  }
  async getQuestion(id: string) {
    const r = this.st('SELECT * FROM questions WHERE question_id = ?').get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }
  private getQuestionSync(id: string): QuestionRow | null {
    const r = this.st('SELECT * FROM questions WHERE question_id = ?').get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }
  private updateQuestionSync(id: string, patch: Partial<QuestionRow>): QuestionRow | null {
    const cur = this.getQuestionSync(id);
    if (!cur) return null;
    const next: QuestionRow = {
      ...cur,
      ...patch,
      origin: { ...cur.origin, ...(patch.origin ?? {}) },
    };
    const r = toRow(next);
    const cols = Q_COLS.filter((c) => c !== 'question_id');
    this.st(
      `UPDATE questions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE question_id = ?`,
    ).run(...(cols.map((c) => r[c]) as never[]), id);
    return next;
  }
  // Fully synchronous bodies: no await between the read and the write, so concurrent callers cannot interleave.
  async updateQuestion(id: string, patch: Partial<QuestionRow>) {
    return this.updateQuestionSync(id, patch);
  }
  async listQuestions(filter: { status?: QuestionRow['local_status'][]; paneId?: string } = {}) {
    const rows = this.st('SELECT * FROM questions ORDER BY alias ASC').all() as Row[];
    return rows
      .map(fromRow)
      .filter((q) => !filter.status || filter.status.includes(q.local_status))
      .filter((q) => !filter.paneId || q.origin.pane_id === filter.paneId);
  }
  async countOpenForPane(hostId: string, paneId: string) {
    const r = this.st(
      `SELECT COUNT(*) AS n FROM questions WHERE origin_host_id=? AND pane_id=? AND local_status IN ('queued','open')`,
    ).get(hostId, paneId) as Row;
    return Number(r.n);
  }

  async putOutbox(item: OutboxItem) {
    this.putOutboxSql(item);
  }
  async dueOutbox(now: number, limit: number) {
    const rows = this.st(
      'SELECT * FROM outbox WHERE next_attempt_at <= ? ORDER BY created_at ASC LIMIT ?',
    ).all(now, limit) as Row[];
    return rows.map((r): OutboxItem => ({
      id: r.id as string,
      kind: r.kind as OutboxItem['kind'],
      question_id: r.question_id as string,
      payload: JSON.parse(r.payload as string) as unknown,
      attempts: Number(r.attempts),
      next_attempt_at: Number(r.next_attempt_at),
      created_at: Number(r.created_at),
      last_error: (r.last_error as string | null) ?? null,
    }));
  }
  async recordOutboxFailure(id: string, error: string, nextAttemptAt: number) {
    this.st(
      'UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?',
    ).run(error, nextAttemptAt, id);
  }
  async deleteOutbox(id: string) {
    this.st('DELETE FROM outbox WHERE id = ?').run(id);
  }
  async outboxFor(questionId: string) {
    const rows = this.st('SELECT * FROM outbox WHERE question_id = ?').all(questionId) as Row[];
    return rows.map((r): OutboxItem => ({
      id: r.id as string,
      kind: r.kind as OutboxItem['kind'],
      question_id: r.question_id as string,
      payload: JSON.parse(r.payload as string) as unknown,
      attempts: Number(r.attempts),
      next_attempt_at: Number(r.next_attempt_at),
      created_at: Number(r.created_at),
      last_error: (r.last_error as string | null) ?? null,
    }));
  }

  async insertEvent(ev: InboundEvent) {
    const r = this.st(
      'INSERT OR IGNORE INTO inbound_events(seq,event_id,event_type,json,received_at,processed_at) VALUES(?,?,?,?,?,?)',
    ).run(ev.seq, ev.event_id, ev.event_type, ev.json, ev.received_at, ev.processed_at);
    return Number(r.changes) === 1;
  }
  async markEventProcessed(seq: number, at: number) {
    this.st('UPDATE inbound_events SET processed_at = ? WHERE seq = ?').run(at, seq);
  }
  async unprocessedEvents(limit: number) {
    const rows = this.st(
      'SELECT * FROM inbound_events WHERE processed_at IS NULL ORDER BY seq ASC LIMIT ?',
    ).all(limit) as Row[];
    return rows.map((r): InboundEvent => ({
      seq: Number(r.seq),
      event_id: r.event_id as string,
      event_type: r.event_type as string,
      json: r.json as string,
      received_at: Number(r.received_at),
      processed_at: r.processed_at == null ? null : Number(r.processed_at),
    }));
  }
  async getCursor() {
    return Number((await this.getMeta('cursor')) ?? '0');
  }
  async advanceCursor() {
    let c = await this.getCursor();
    const has = this.st('SELECT 1 AS x FROM inbound_events WHERE seq = ?');
    while (has.get(c + 1)) c++;
    await this.setMeta('cursor', String(c));
    return c;
  }
  async forceCursor(seq: number) {
    if (seq > (await this.getCursor())) await this.setMeta('cursor', String(seq));
  }

  private putIntentSql(i: InjectionIntent): void {
    this.st(
      `INSERT OR REPLACE INTO injection_intents(injection_id,question_id,answer_revision,host_id,pane_id,terminal_generation,ownership_principal,agent_incarnation,state,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      i.injection_id,
      i.question_id,
      i.answer_revision,
      i.host_id,
      i.pane_id,
      i.terminal_generation,
      i.ownership_principal,
      i.agent_incarnation,
      i.state,
      i.created_at,
      i.updated_at,
    );
  }
  async putIntent(i: InjectionIntent) {
    this.putIntentSql(i);
  }
  private intentFrom(r: Row): InjectionIntent {
    return {
      injection_id: r.injection_id as string,
      question_id: r.question_id as string,
      answer_revision: Number(r.answer_revision),
      host_id: r.host_id as string,
      pane_id: r.pane_id as string,
      terminal_generation: Number(r.terminal_generation),
      ownership_principal: r.ownership_principal as string,
      agent_incarnation: r.agent_incarnation as string,
      state: r.state as InjectionIntent['state'],
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    };
  }
  async getIntent(id: string) {
    const r = this.st('SELECT * FROM injection_intents WHERE injection_id = ?').get(id) as
      Row | undefined;
    return r ? this.intentFrom(r) : null;
  }
  async updateIntent(id: string, patch: Partial<InjectionIntent>) {
    const cur = await this.getIntent(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await this.putIntent(next);
    return next;
  }
  async openIntents() {
    const rows = this.st(
      `SELECT * FROM injection_intents WHERE state IN ('intent','typed')`,
    ).all() as Row[];
    return rows.map((r) => this.intentFrom(r));
  }

  async hasUncertainIntent(questionId: string) {
    const r = this.st(
      `SELECT 1 AS x FROM injection_intents WHERE question_id = ? AND state = 'uncertain' LIMIT 1`,
    ).get(questionId);
    return r !== undefined;
  }
  async settleIntent(
    intentId: string,
    intentPatch: Partial<InjectionIntent>,
    questionId: string,
    questionPatch: Partial<QuestionRow>,
  ) {
    this.tx(() => {
      const row = this.st('SELECT * FROM injection_intents WHERE injection_id = ?').get(
        intentId,
      ) as Row | undefined;
      if (row) this.putIntentSql({ ...this.intentFrom(row), ...intentPatch });
      this.updateQuestionSync(questionId, questionPatch);
    });
  }
  async appendAudit(e: AuditEntry) {
    this.st('INSERT INTO audit(at,json) VALUES(?,?)').run(e.at, JSON.stringify(e));
  }
  async listAudit(limit: number) {
    const rows = this.st('SELECT json FROM audit ORDER BY id DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => JSON.parse(r.json as string) as AuditEntry).reverse();
  }

  async compact() {
    this.db.exec('VACUUM');
    // Until the WAL is checkpointed the old pages are still in the main file. Another connection reading the
    // database blocks a full checkpoint without raising an error, so report that as a failure (retried later).
    const r = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Row | undefined;
    if (r && Number(r.busy) !== 0) throw new Error('database busy: WAL checkpoint incomplete');
  }

  async close() {
    this.db.close();
  }
}
