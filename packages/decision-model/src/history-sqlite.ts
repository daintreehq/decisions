import { DatabaseSync } from 'node:sqlite';
import {
  indexText,
  prepare,
  redactExample,
  type CommonState,
  type HistoryStore,
  type RecordResult,
} from './history.js';
import { tokenize } from './text.js';
import type { DecisionExample } from './types.js';

export interface SqliteHistoryOptions {
  learningEnabled?: boolean;
  /** Do not use FTS5 for candidate prefiltering (an existing FTS index is still kept clean). */
  disableFts?: boolean;
  /** Only use FTS5 to prefilter once the store has more than this many examples. Default 500. */
  prefilterThreshold?: number;
}

const SCHEMA_VERSION = 1;

/** Durable history in a local SQLite file (`node:sqlite`). Never synced anywhere. */
export class SqliteHistoryStore implements HistoryStore {
  private readonly db: DatabaseSync;
  private readonly state: CommonState;
  private readonly prefilterThreshold: number;
  /** FTS5 is enabled for candidate prefiltering. */
  private fts = false;
  /** An FTS table exists in this database. It is kept in sync (and purged) whether or not prefiltering is on. */
  private ftsPresent = false;

  constructor(path: string, opts: SqliteHistoryOptions = {}) {
    this.db = new DatabaseSync(path);
    this.prefilterThreshold = opts.prefilterThreshold ?? 500;
    this.migrate(opts.disableFts === true);
    const stored = this.getMeta('learning_enabled');
    this.state = {
      learning: stored === null ? opts.learningEnabled === true : stored === '1',
      optOut: new Set(
        (this.db.prepare('SELECT tag FROM opt_outs').all() as { tag: string }[]).map((r) => r.tag),
      ),
    };
    if (this.ftsPresent && (this.getMeta('fts_dirty') === '1' || this.ftsNeedsBackfill))
      this.reindexFts();
  }

  private ftsNeedsBackfill = false;

  /** True when FTS5 is available and enabled for candidate prefiltering. */
  get ftsEnabled(): boolean {
    return this.fts;
  }

  private migrate(disableFts: boolean): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    const current = row.user_version;
    if (current > SCHEMA_VERSION)
      throw new Error(`history database is newer (v${current}) than this build`);
    if (current < 1) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS opt_outs (tag TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS examples (
          question_id TEXT PRIMARY KEY,
          chosen_at TEXT NOT NULL,
          data TEXT NOT NULL
        );
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
    this.ftsPresent = this.ftsTableExists();
    // FTS5 is optional: some SQLite builds omit it. Absence only disables prefiltering.
    if (!disableFts) {
      try {
        this.db.exec(
          'CREATE VIRTUAL TABLE IF NOT EXISTS examples_fts USING fts5(question_id UNINDEXED, body)',
        );
        // A table created now has not seen the existing rows.
        if (!this.ftsPresent && this.count() > 0) this.ftsNeedsBackfill = true;
        this.fts = true;
        this.ftsPresent = true;
      } catch {
        this.fts = false;
      }
    }
  }

  private getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return r ? r.value : null;
  }
  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
  private bump(): void {
    this.setMeta('version', String(this.version() + 1));
  }
  private ftsTableExists(): boolean {
    return (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='examples_fts'")
        .get() !== undefined
    );
  }

  /** Runs an FTS statement; if it cannot run (module missing, corruption) the index is flagged for a rebuild. */
  private ftsDo(fn: () => void): void {
    if (!this.ftsPresent) return;
    try {
      fn();
    } catch {
      try {
        this.setMeta('fts_dirty', '1');
      } catch {
        /* nothing more we can do */
      }
    }
  }
  private ftsUpsert(ex: DecisionExample): void {
    this.ftsDo(() => {
      this.db.prepare('DELETE FROM examples_fts WHERE question_id = ?').run(ex.question_id);
      this.db
        .prepare('INSERT INTO examples_fts(question_id, body) VALUES(?, ?)')
        .run(ex.question_id, tokenize(indexText(ex)).join(' '));
    });
  }
  private reindexFts(): void {
    this.ftsDo(() => {
      this.db.exec('DELETE FROM examples_fts');
      for (const ex of this.all()) this.ftsUpsert(ex);
      this.db.prepare("DELETE FROM meta WHERE key = 'fts_dirty'").run();
    });
  }

  learningEnabled(): boolean {
    return this.state.learning;
  }
  setLearningEnabled(enabled: boolean): void {
    this.state.learning = enabled;
    this.setMeta('learning_enabled', enabled ? '1' : '0');
    this.bump();
  }
  setProjectOptOut(tag: string, optedOut: boolean): void {
    this.db.exec('BEGIN');
    try {
      if (optedOut) {
        this.state.optOut.add(tag);
        this.db.prepare('INSERT OR IGNORE INTO opt_outs(tag) VALUES(?)').run(tag);
        for (const ex of this.all())
          if (ex.project_tags?.includes(tag)) this.forgetInner(ex.question_id);
      } else {
        this.state.optOut.delete(tag);
        this.db.prepare('DELETE FROM opt_outs WHERE tag = ?').run(tag);
      }
      this.bump();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  isProjectOptedOut(tag: string): boolean {
    return this.state.optOut.has(tag);
  }
  optedOutProjects(): string[] {
    return [...this.state.optOut].sort();
  }

  record(example: DecisionExample): RecordResult {
    const r = prepare(this.state, example, this.get(example.question_id));
    if (!r.ok) return { recorded: false, reason: r.reason };
    if (r.duplicate) return { recorded: true, revision: r.revision, duplicate: true };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO examples(question_id, chosen_at, data) VALUES(?, ?, ?) ON CONFLICT(question_id) DO UPDATE SET chosen_at = excluded.chosen_at, data = excluded.data',
        )
        .run(r.example.question_id, r.example.chosen_at, JSON.stringify(r.example));
      this.ftsUpsert(r.example);
      this.bump();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { recorded: true, revision: r.example.revision ?? 0 };
  }
  get(id: string): DecisionExample | undefined {
    const r = this.db.prepare('SELECT data FROM examples WHERE question_id = ?').get(id) as
      { data: string } | undefined;
    return r ? (JSON.parse(r.data) as DecisionExample) : undefined;
  }
  all(): DecisionExample[] {
    return (
      this.db.prepare('SELECT data FROM examples ORDER BY chosen_at').all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as DecisionExample);
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM examples').get() as { n: number }).n;
  }
  candidates(queryText: string, limit: number): DecisionExample[] {
    if (!this.fts || this.count() <= this.prefilterThreshold) return this.all();
    const tokens = [...new Set(tokenize(queryText))].slice(0, 40);
    if (tokens.length === 0) return this.all();
    const match = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    const ids = (
      this.db
        .prepare(
          'SELECT question_id FROM examples_fts WHERE examples_fts MATCH ? ORDER BY bm25(examples_fts) LIMIT ?',
        )
        .all(match, limit) as { question_id: string }[]
    ).map((r) => r.question_id);
    const out: DecisionExample[] = [];
    for (const id of ids) {
      const ex = this.get(id);
      if (ex) out.push(ex);
    }
    return out;
  }
  private forgetInner(id: string): boolean {
    const res = this.db.prepare('DELETE FROM examples WHERE question_id = ?').run(id);
    this.ftsDo(() => this.db.prepare('DELETE FROM examples_fts WHERE question_id = ?').run(id));
    return Number(res.changes) > 0;
  }
  forget(id: string): boolean {
    this.db.exec('BEGIN');
    try {
      const had = this.forgetInner(id);
      if (had) this.bump();
      this.db.exec('COMMIT');
      return had;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  clear(): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM examples');
      this.ftsDo(() => this.db.exec('DELETE FROM examples_fts'));
      this.bump();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  rebuildIndex(): void {
    this.db.exec('BEGIN');
    try {
      for (const ex of this.all()) {
        const clean = redactExample(ex);
        this.db
          .prepare('UPDATE examples SET data = ? WHERE question_id = ?')
          .run(JSON.stringify(clean), clean.question_id);
      }
      this.reindexFts();
      this.bump();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  version(): number {
    const v = this.getMeta('version');
    return v === null ? 0 : Number(v);
  }
  close(): void {
    this.db.close();
  }
}
