import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryHistoryStore, SqliteHistoryStore, type HistoryStore } from '../src/history.js';
import { day, ex } from './helpers.js';

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'dm-hist-'));
  dirs.push(d);
  return join(d, 'history.sqlite');
}

const factories: [string, (learning: boolean) => HistoryStore][] = [
  ['memory', (l) => new MemoryHistoryStore({ learningEnabled: l })],
  [
    'sqlite+fts5',
    (l) => {
      const s = new SqliteHistoryStore(':memory:', { learningEnabled: l, prefilterThreshold: 0 });
      closers.push(() => s.close());
      return s;
    },
  ],
  [
    'sqlite (fts disabled)',
    (l) => {
      const s = new SqliteHistoryStore(':memory:', {
        learningEnabled: l,
        disableFts: true,
        prefilterThreshold: 0,
      });
      closers.push(() => s.close());
      return s;
    },
  ],
];

describe.each(factories)('history rules (%s)', (_name, make) => {
  it('records nothing until learning is explicitly enabled', () => {
    const s = make(false);
    expect(s.learningEnabled()).toBe(false);
    expect(s.record(ex('a'))).toEqual({ recorded: false, reason: 'learning-disabled' });
    expect(s.count()).toBe(0);
    s.setLearningEnabled(true);
    expect(s.record(ex('a')).recorded).toBe(true);
    expect(s.count()).toBe(1);
  });

  it('rejects anything that is not a human label', () => {
    const s = make(true);
    expect(s.record({ ...ex('p'), source: 'proxy' as never })).toEqual({
      recorded: false,
      reason: 'not-human',
    });
    expect(s.record({ ...ex('p'), source: undefined as never })).toEqual({
      recorded: false,
      reason: 'not-human',
    });
    expect(s.count()).toBe(0);
  });

  it('rejects invalid and unlabelled examples', () => {
    const s = make(true);
    expect(s.record({ ...ex('x'), question: '' }).recorded).toBe(false);
    expect(s.record({ ...ex('y'), selected_option_ids: [], human_reasoning: undefined })).toEqual({
      recorded: false,
      reason: 'no-label',
    });
    expect(
      s.record({ ...ex('z'), selected_option_ids: [], human_reasoning: 'free text answer' })
        .recorded,
    ).toBe(true);
  });

  it('a later human correction supersedes the label and keeps provenance', () => {
    const s = make(true);
    s.record(ex('q1', { selected_option_ids: ['compact'], chosen_at: day(1) }));
    const r = s.record(
      ex('q1', {
        selected_option_ids: ['comfortable'],
        human_reasoning: 'changed my mind',
        chosen_at: day(5),
      }),
    );
    expect(r).toEqual({ recorded: true, revision: 1 });
    const got = s.get('q1')!;
    expect(got.selected_option_ids).toEqual(['comfortable']);
    expect(got.revision).toBe(1);
    expect(got.label_history).toEqual([
      { selected_option_ids: ['compact'], chosen_at: day(1), superseded_by_revision: 1 },
    ]);
    expect(s.count()).toBe(1);
    // A stale record arriving late never overrides the later correction.
    expect(s.record(ex('q1', { selected_option_ids: ['compact'], chosen_at: day(2) }))).toEqual({
      recorded: false,
      reason: 'older-than-existing',
    });
    expect(s.get('q1')!.selected_option_ids).toEqual(['comfortable']);
  });

  it('redacts secrets before storing', () => {
    const s = make(true);
    s.record(
      ex('s', {
        question: 'Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 for the sidebar?',
        human_reasoning: 'DB_PASSWORD=hunter2',
      }),
    );
    const got = s.get('s')!;
    expect(JSON.stringify(got)).not.toContain('sk-ant');
    expect(JSON.stringify(got)).not.toContain('hunter2');
  });

  it('forget / clear / version', () => {
    const s = make(true);
    const v0 = s.version();
    s.record(ex('a'));
    s.record(ex('b'));
    expect(s.version()).toBeGreaterThan(v0);
    expect(s.forget('a')).toBe(true);
    expect(s.forget('a')).toBe(false);
    expect(s.get('a')).toBeUndefined();
    expect(s.count()).toBe(1);
    s.clear();
    expect(s.count()).toBe(0);
    expect(s.all()).toEqual([]);
  });

  it('per-project opt-out blocks new records and removes existing ones', () => {
    const s = make(true);
    s.record(ex('a', { project_tags: ['secret-project'] }));
    s.record(ex('b', { project_tags: ['other'] }));
    s.setProjectOptOut('secret-project', true);
    expect(s.isProjectOptedOut('secret-project')).toBe(true);
    expect(s.get('a')).toBeUndefined();
    expect(s.get('b')).toBeDefined();
    expect(s.record(ex('c', { project_tags: ['secret-project'] }))).toEqual({
      recorded: false,
      reason: 'project-opted-out',
    });
    expect(s.optedOutProjects()).toEqual(['secret-project']);
    s.setProjectOptOut('secret-project', false);
    expect(s.record(ex('c', { project_tags: ['secret-project'] })).recorded).toBe(true);
  });

  it('rebuildIndex keeps data and candidates working', () => {
    const s = make(true);
    for (let i = 0; i < 5; i++)
      s.record(ex(`r${i}`, { question: `Sidebar width option ${i}`, chosen_at: day(i) }));
    s.rebuildIndex();
    expect(s.count()).toBe(5);
    expect(s.candidates('sidebar width', 3).length).toBeGreaterThan(0);
  });
});

describe('SqliteHistoryStore persistence and indexing', () => {
  it('persists examples, learning flag and opt-outs across reopen; migrations are versioned', () => {
    const file = tmpFile();
    const a = new SqliteHistoryStore(file);
    expect(a.learningEnabled()).toBe(false);
    a.setLearningEnabled(true);
    a.record(ex('keep'));
    a.setProjectOptOut('p', true);
    a.close();
    const b = new SqliteHistoryStore(file);
    closers.push(() => b.close());
    expect(b.learningEnabled()).toBe(true);
    expect(b.get('keep')?.question_id).toBe('keep');
    expect(b.isProjectOptedOut('p')).toBe(true);
    expect(b.version()).toBeGreaterThan(0);
  });

  it('FTS5 prefilter returns relevant candidates; the no-FTS path returns everything', () => {
    const fts = new SqliteHistoryStore(':memory:', {
      learningEnabled: true,
      prefilterThreshold: 0,
    });
    const plain = new SqliteHistoryStore(':memory:', {
      learningEnabled: true,
      disableFts: true,
      prefilterThreshold: 0,
    });
    closers.push(
      () => fts.close(),
      () => plain.close(),
    );
    for (const s of [fts, plain]) {
      s.record(
        ex('t1', {
          question: 'Terminal font size preference',
          options: [
            { id: 'a', label: 'Small' },
            { id: 'b', label: 'Large' },
          ],
          selected_option_ids: ['a'],
        }),
      );
      for (let i = 0; i < 6; i++)
        s.record(ex(`s${i}`, { question: `Sidebar density number ${i}`, chosen_at: day(i) }));
    }
    expect(plain.ftsEnabled).toBe(false);
    expect(plain.candidates('terminal font', 10)).toHaveLength(7);
    if (fts.ftsEnabled) {
      const ids = fts.candidates('terminal font', 10).map((e) => e.question_id);
      expect(ids).toContain('t1');
      expect(ids.length).toBeLessThan(7);
    } else {
      expect(fts.candidates('terminal font', 10)).toHaveLength(7);
    }
  });

  it('refuses a database from a newer schema', () => {
    const file = tmpFile();
    const a = new SqliteHistoryStore(file);
    a.close();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return import('node:sqlite').then(({ DatabaseSync }) => {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA user_version = 99');
      db.close();
      expect(() => new SqliteHistoryStore(file)).toThrow(/newer/);
    });
  });
});
