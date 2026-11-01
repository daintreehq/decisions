import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryHistoryStore, asBridgeLearner, type BridgeLearnedDecision } from '../src/index.js';
import { SqliteHistoryStore } from '../src/history-sqlite.js';

const dir = mkdtempSync(join(tmpdir(), 'decisions-learner-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const decision = (o: Partial<BridgeLearnedDecision> = {}): BridgeLearnedDecision => ({
  questionId: 'q-1',
  question: 'Deploy with DB_PASSWORD=hunter2-secret now?',
  context: 'The token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 for CI',
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  kind: 'choice',
  requirement: 'proxy-ok',
  projectId: 'proj-1',
  createdAt: '2026-11-01T00:00:00.000Z',
  chosenAt: '2026-11-01T00:05:00.000Z',
  selectedOptionIds: ['yes'],
  text: 'fine, the key is sk-ant-abcdefghijklmnopqrstuvwxyz012345',
  revision: 1,
  correction: false,
  ...o,
});

describe('asBridgeLearner (the bridge learner hook)', () => {
  it('records nothing while learning is off, the default', () => {
    const history = new MemoryHistoryStore();
    const r = asBridgeLearner(history).learn(decision());
    expect(r).toEqual({ recorded: false, reason: 'learning-disabled' });
    expect(history.count()).toBe(0);
  });

  it('with learning on, records the human decision with every secret redacted', () => {
    const history = new MemoryHistoryStore({ learningEnabled: true });
    expect(asBridgeLearner(history).learn(decision())).toMatchObject({ recorded: true });
    const ex = history.get('q-1')!;
    expect(ex).toMatchObject({
      question_id: 'q-1',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      selected_option_ids: ['yes'],
      project_tags: ['proj-1'],
      policy_level: 'proxy-ok',
      source: 'human',
      revision: 1,
    });
    const all = JSON.stringify(ex);
    expect(all).not.toContain('hunter2-secret');
    expect(all).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(all).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz012345');
    expect(ex.question).toContain('[REDACTED]');
    expect(ex.human_reasoning).toContain('fine, the key is');
  });

  it('a later correction replaces the label; an opted-out project is never recorded', () => {
    const history = new MemoryHistoryStore({ learningEnabled: true });
    const l = asBridgeLearner(history);
    l.learn(decision());
    l.learn(decision({ selectedOptionIds: ['no'], text: '', revision: 2, correction: true }));
    expect(history.get('q-1')!.selected_option_ids).toEqual(['no']);
    history.setProjectOptOut('proj-2', true);
    expect(l.learn(decision({ questionId: 'q-2', projectId: 'proj-2' }))).toEqual({
      recorded: false,
      reason: 'project-opted-out',
    });
  });

  it('the SQLite history file never holds the redacted secrets', () => {
    const path = join(dir, 'history.sqlite');
    const history = new SqliteHistoryStore(path, { learningEnabled: true });
    asBridgeLearner(history).learn(decision());
    history.close?.();
    for (const p of [path, `${path}-wal`]) {
      if (!existsSync(p)) continue;
      const bytes = readFileSync(p);
      expect(bytes.includes(Buffer.from('hunter2-secret'))).toBe(false);
      expect(bytes.includes(Buffer.from('sk-ant-abcdefghijklmnopqrstuvwxyz012345'))).toBe(false);
    }
  });
});
