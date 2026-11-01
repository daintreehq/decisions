/**
 * Regression tests for the security review of this package. Each describe block names the finding it pins; every
 * test here was confirmed to FAIL against the code as it was before the corresponding fix.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../src/adapters/fake.js';
import { CommandAdapter } from '../src/adapters/command.js';
import { createDecisionModel } from '../src/engine.js';
import { evaluateHistory } from '../src/evaluate.js';
import { extractJson } from '../src/guards.js';
import { MemoryHistoryStore, type HistoryStore } from '../src/history.js';
import { SqliteHistoryStore } from '../src/history-sqlite.js';
import { buildPrompt } from '../src/prompt.js';
import { redactSecrets } from '../src/redact.js';
import { retrieve } from '../src/retrieval.js';
import { asBridgeEngine, toModelInput } from '../src/bridge.js';
import type { ProxyOutcome } from '../src/types.js';
import {
  AUTHORISED,
  answerJson,
  calibration,
  day,
  ex,
  idsFromPrompt,
  input,
  okAdapter,
  seededStore,
} from './helpers.js';

const tmp: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});
afterAll(() => {
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dm-fix-'));
  tmp.push(d);
  return d;
}
const pts = (n: number, conf: number, correct: boolean): [number, boolean][] =>
  Array.from({ length: n }, () => [conf, correct]);

describe('#1 calibration must qualify the exact effective threshold', () => {
  // 30 correct at 0.80 and 5 wrong at 0.95: the 0.85 target is met overall (recommended 0), but only by the
  // low band. Choosing 0.9 would authorise nothing but the five wrong predictions.
  const cal = calibration([...pts(30, 0.8, true), ...pts(5, 0.95, false)], 0.85, 0);
  const mk = (t: number | null) =>
    createDecisionModel({
      history: seededStore(),
      adapter: okAdapter({ conf: 0.99 }),
      policy: { autoAnswerThreshold: t, calibration: cal, retryDelayMs: 1 },
    });

  it('rejects an operator threshold whose own band lacks samples or accuracy', async () => {
    const m = mk(0.9);
    expect(m.effectiveThreshold()).toBeNull();
    expect(await m.suggest(input())).toMatchObject({
      action: 'abstain',
      reason: 'suggestion-only',
    });
  });
  it('accepts a threshold that the evidence actually supports', () => {
    expect(mk(0.8).effectiveThreshold()).toBe(0.8); // 30/35 = 85.7% >= 85% over 35 samples
    expect(mk(0.8).effectiveThreshold()).not.toBeNull();
  });
  it('a hand-written calibration without evidence never authorises anything', () => {
    const m = createDecisionModel({
      history: seededStore(),
      adapter: okAdapter(),
      policy: {
        autoAnswerThreshold: 0.5,
        calibration: { samples: 500, recommendedThreshold: 0.1 } as never,
      },
    });
    expect(m.effectiveThreshold()).toBeNull();
  });
  it('requires a sane target accuracy', () => {
    const lax = calibration(pts(100, 0.9, true), 0.2);
    const m = createDecisionModel({
      history: seededStore(),
      adapter: okAdapter(),
      policy: { autoAnswerThreshold: 0.5, calibration: lax },
    });
    expect(m.effectiveThreshold()).toBeNull();
  });
});

describe('#2 a history change invalidates an inference already running', () => {
  it('discards the result when history is cleared mid-flight', async () => {
    const history = seededStore();
    const adapter = new FakeAdapter({ delayMs: 40, responder: (p) => answerJson(p) });
    const m = createDecisionModel({ history, adapter, policy: { ...AUTHORISED } });
    const p = m.suggest(input());
    setTimeout(() => history.clear(), 10);
    expect(await p).toEqual({ action: 'abstain', reason: 'stale-history' });
  });
  it('discards the result when a contradicting correction lands mid-flight', async () => {
    const history = seededStore();
    const adapter = new FakeAdapter({ delayMs: 40, responder: (p) => answerJson(p) });
    const m = createDecisionModel({ history, adapter, policy: { ...AUTHORISED } });
    const p = m.suggestOnly(input());
    setTimeout(
      () =>
        history.record(
          ex('h0', { selected_option_ids: ['comfortable'], chosen_at: day(60), revision: 2 }),
        ),
      10,
    );
    expect(await p).toEqual({ action: 'abstain', reason: 'stale-history' });
  });
  it('is unaffected when nothing changed', async () => {
    const adapter = new FakeAdapter({ delayMs: 20, responder: (p) => answerJson(p) });
    const m = createDecisionModel({ history: seededStore(), adapter, policy: { ...AUTHORISED } });
    expect((await m.suggest(input())).action).toBe('answer');
  });
});

describe('#3 guard regexes are stateless', () => {
  it('a global blockedKeywords regex blocks every time, not every other time', async () => {
    const adapter = okAdapter();
    const m = createDecisionModel({
      history: seededStore(),
      adapter,
      policy: { ...AUTHORISED, blockedKeywords: /security/gi },
    });
    const q = input({ question: 'Sidebar security banner density?' });
    for (let i = 0; i < 4; i++) {
      expect(
        await m.suggest({ ...q, question_id: `q${i}`, question: q.question + ' '.repeat(i) }),
      ).toMatchObject({ action: 'abstain', reason: 'blocked-topic:security' });
    }
    expect(adapter.calls).toHaveLength(0);
  });
  it('global and sticky gate regexes block every time', async () => {
    const m = createDecisionModel({
      history: seededStore(),
      adapter: okAdapter(),
      policy: { ...AUTHORISED, blockedGates: [/final-gate/g, /other/y] },
    });
    for (let i = 0; i < 4; i++) {
      expect(await m.suggest(input({ workflow_gate_id: 'final-gate' }))).toMatchObject({
        reason: 'blocked-gate',
      });
      expect(await m.suggest(input({ workflow_gate_id: 'other' }))).toMatchObject({
        reason: 'blocked-gate',
      });
    }
  });
});

describe('#4 credential assignments with no prefix are redacted', () => {
  it.each([
    'PRIVATE_KEY=abc123',
    'ACCESS_KEY=abc123',
    'PASSPHRASE=hunter2',
    'private_key: abc123',
    'export ACCESS_KEY="abc 123"',
    'SECRET=x',
    'AUTH_TOKEN=abc',
    'CLIENT_SECRET=abc',
  ])('line-start %s', (line) => {
    const out = redactSecrets(`before\n${line}\nafter`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/abc|hunter2/);
    expect(out).toContain('before');
    expect(out).toContain('after');
  });
  it.each([
    'PRIVATE_KEY=abc123',
    'ACCESS_KEY=abc123',
    'PASSPHRASE=hunter2',
    'DB_PASSWORD=hunter2',
    'private_key: abc123',
    'client_secret=abc',
  ])('inline %s', (assign) => {
    const out = redactSecrets(`please run with ${assign} set in the shell`);
    expect(out).not.toMatch(/abc|hunter2/);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('please run with');
  });
  it('keeps harmless assignments', () => {
    expect(redactSecrets('NODE_ENV=production\nmonkey=banana\nAUTHOR=Jane')).toBe(
      'NODE_ENV=production\nmonkey=banana\nAUTHOR=Jane',
    );
  });
});

describe('#5 replay validates provenance before scoring or training', () => {
  it('ignores proxy-sourced examples entirely', async () => {
    const humans = [0, 1, 2].map((i) =>
      ex(`h${i}`, {
        question: `Sidebar density for panel #${i}?`,
        chosen_at: day(i + 1),
        created_at: day(i),
      }),
    );
    const proxies = Array.from({ length: 30 }, (_, i) => ({
      ...ex(`p${i}`, {
        question: `Sidebar density for panel #${100 + i}?`,
        chosen_at: day(10 + i),
        created_at: day(9 + i),
      }),
      source: 'proxy' as never,
    }));
    const adapter = new FakeAdapter({ responder: (p) => answerJson(p) });
    const r = await evaluateHistory({ examples: [...humans, ...proxies], adapter, minSamples: 1 });
    expect(r.total).toBe(3);
    expect(r.rejected_non_human).toBe(30);
    expect(r.calibration.points).toHaveLength(0);
    expect(r.answered).toBe(0);
  });
});

describe('#6 replay uses creation and answer times, so no label is used before it existed', () => {
  const h = (n: number): string => new Date(Date.UTC(2026, 0, 10) + n * 3_600_000).toISOString();
  const q = (id: string, created: number, chosen: number) =>
    ex(id, {
      question: `Sidebar density for panel ${id}: compact or comfortable?`,
      created_at: h(created),
      chosen_at: h(chosen),
    });

  it('does not let a question see answers committed after it was asked', async () => {
    // A is asked at 09:00 and answered at 12:00. B, C and D are answered between 10:00 and 11:00, i.e. after A was
    // asked, so none of them can inform A. E is asked at 13:00 and may see all four.
    const examples = [q('A', 9, 12), q('B', 1, 10), q('C', 2, 10.5), q('D', 3, 11), q('E', 13, 14)];
    const seen: number[] = [];
    const adapter = new FakeAdapter({
      responder: (p) => {
        seen.push(idsFromPrompt(p).length);
        return answerJson(p);
      },
    });
    const r = await evaluateHistory({ examples, adapter });
    const item = (id: string) => r.items.find((i) => i.question_id === id)!;
    expect(item('A').abstain_reason).toBe('insufficient-history');
    expect(item('E').predicted).not.toBeNull();
    expect(seen).toEqual([4]);
  });
  it('never exposes an example to its own prediction', async () => {
    const seen: string[][] = [];
    const adapter = new FakeAdapter({
      responder: (p) => (seen.push(idsFromPrompt(p)), answerJson(p)),
    });
    const examples = ['a', 'b', 'c', 'd'].map((id, i) => q(id, i * 2, i * 2 + 1));
    await evaluateHistory({ examples, adapter });
    for (const ids of seen) expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each<[string, () => HistoryStore]>([
  ['memory', () => new MemoryHistoryStore({ learningEnabled: true })],
  [
    'sqlite',
    () => {
      const s = new SqliteHistoryStore(':memory:', { learningEnabled: true });
      closers.push(() => s.close());
      return s;
    },
  ],
])(
  '#7 human corrections are ordered by revision, and duplicates are idempotent (%s)',
  (_n, make) => {
    it('a replayed original never overwrites an override with an equal timestamp', () => {
      const s = make();
      const t = day(5);
      s.record(ex('q', { selected_option_ids: ['compact'], chosen_at: t, revision: 1 }));
      s.record(
        ex('q', {
          selected_option_ids: ['comfortable'],
          human_reasoning: 'override',
          chosen_at: t,
          revision: 2,
        }),
      );
      expect(
        s.record(ex('q', { selected_option_ids: ['compact'], chosen_at: t, revision: 1 })),
      ).toEqual({ recorded: false, reason: 'stale-revision' });
      expect(s.get('q')).toMatchObject({ selected_option_ids: ['comfortable'], revision: 2 });
    });
    it('duplicate ingestion changes nothing', () => {
      const s = make();
      const o = ex('q', { selected_option_ids: ['comfortable'], chosen_at: day(5), revision: 2 });
      s.record(ex('q', { selected_option_ids: ['compact'], chosen_at: day(4), revision: 1 }));
      s.record(o);
      const v = s.version();
      expect(s.record(o)).toMatchObject({ recorded: true, duplicate: true, revision: 2 });
      expect(s.version()).toBe(v);
      expect(s.get('q')!.label_history).toHaveLength(1);
    });
    it('a higher revision wins even when its clock is earlier (skew)', () => {
      const s = make();
      s.record(ex('q', { selected_option_ids: ['compact'], chosen_at: day(9), revision: 1 }));
      expect(
        s.record(ex('q', { selected_option_ids: ['comfortable'], chosen_at: day(3), revision: 2 })),
      ).toEqual({ recorded: true, revision: 2 });
      expect(s.get('q')).toMatchObject({ selected_option_ids: ['comfortable'], revision: 2 });
    });
    it('equal revision with a different label cannot overwrite', () => {
      const s = make();
      s.record(ex('q', { selected_option_ids: ['compact'], chosen_at: day(5), revision: 1 }));
      expect(
        s.record(ex('q', { selected_option_ids: ['comfortable'], chosen_at: day(6), revision: 1 })),
      ).toEqual({ recorded: false, reason: 'stale-revision' });
    });
    it('legacy callers (no revision) are ordered by time and equal-time conflicts are rejected', () => {
      const s = make();
      s.record(ex('q', { selected_option_ids: ['compact'], chosen_at: day(5) }));
      expect(
        s.record(ex('q', { selected_option_ids: ['comfortable'], chosen_at: day(5) })),
      ).toEqual({ recorded: false, reason: 'stale-revision' });
      expect(
        s.record(ex('q', { selected_option_ids: ['comfortable'], chosen_at: day(6) })),
      ).toMatchObject({ recorded: true, revision: 1 });
      expect(
        s.record(ex('q', { selected_option_ids: ['comfortable'], chosen_at: day(6) })),
      ).toMatchObject({ recorded: true, duplicate: true });
    });
  },
);

describe('#9 the whole reply must be the decision object', () => {
  const valid = JSON.stringify({ action: 'answer', selected_option_ids: ['compact'] });
  it('rejects prose around the object and trailing text', () => {
    expect(() => extractJson(`I cannot answer; this is only an example: ${valid}`)).toThrow();
    expect(() => extractJson(`${valid} (just kidding)`)).toThrow();
    expect(() => extractJson(`${valid}\n${valid}`)).toThrow();
  });
  it('still accepts a single fenced block', () => {
    expect(extractJson('```json\n' + valid + '\n```')).toEqual(JSON.parse(valid));
  });
  it('the engine abstains on an illustrative answer embedded in prose', async () => {
    const m = createDecisionModel({
      history: seededStore(),
      adapter: new FakeAdapter({
        responder: (p) => `I cannot answer. Example only: ${answerJson(p)}`,
      }),
      policy: { ...AUTHORISED },
    });
    expect(await m.suggest(input())).toEqual({ action: 'abstain', reason: 'invalid-model-output' });
  });
});

describe('#10 minExamples is enforced on the examples actually in the prompt', () => {
  it('abstains when truncation leaves fewer than the minimum', async () => {
    const history = seededStore(3);
    const budget = { maxExamplesChars: 330 };
    const probe = buildPrompt(input(), retrieve(history, input()), budget);
    expect(probe.includedExampleIds.length).toBeLessThan(3); // guard: the setup really truncates
    expect(probe.includedExampleIds.length).toBeGreaterThan(0);
    const adapter = okAdapter();
    const m = createDecisionModel({
      history,
      adapter,
      policy: { ...AUTHORISED, minExamples: 3, prompt: budget },
    });
    expect(await m.suggest(input())).toEqual({ action: 'abstain', reason: 'insufficient-history' });
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('#11 dissent is found even when the display cap is full', () => {
  /** 12 agreeing decisions that fill the cap, plus one older, less lexically close dissenter that ranks 13th. */
  function crowded(): MemoryHistoryStore {
    const s = new MemoryHistoryStore({ learningEnabled: true });
    for (let i = 0; i < 12; i++) {
      s.record(
        ex(`agree${i}`, {
          question: `Sidebar density for the new settings panel variant ${i}`,
          chosen_at: day(100 + i),
        }),
      );
    }
    s.record(
      ex('dissent', {
        question: 'Sidebar density settings alpha beta gamma delta epsilon zeta eta theta',
        selected_option_ids: ['comfortable'],
        chosen_at: day(1),
      }),
    );
    return s;
  }
  it('limit 12 still surfaces a qualifying dissenter', () => {
    const r = retrieve(crowded(), input(), { now: new Date(day(130)), limit: 12 });
    expect(r.referenceIds).toContain('dissent');
    expect(r.examples).toHaveLength(12);
    expect(r.contradictory).toBe(true);
    expect(r.examples.find((e) => e.example.question_id === 'dissent')!.contradiction).toBe(true);
  });
  it('the engine abstains on that contradiction', async () => {
    const m = createDecisionModel({
      history: crowded(),
      adapter: okAdapter(),
      policy: { ...AUTHORISED, retrieval: { limit: 12 } },
    });
    expect(await m.suggest(input())).toEqual({
      action: 'abstain',
      reason: 'contradictory-history',
    });
  });
});

describe('#12 FTS rows are purged even when the FTS prefilter is disabled', () => {
  function seed(): { file: string; ftsRows: () => number } {
    const file = join(tmpDir(), 'h.sqlite');
    const a = new SqliteHistoryStore(file, { learningEnabled: true });
    expect(a.ftsEnabled).toBe(true);
    a.record(ex('gone', { question: 'Zebrafish onboarding flow', project_tags: ['p'] }));
    a.record(ex('keep', { question: 'Sidebar density' }));
    a.close();
    return {
      file,
      ftsRows: () => {
        const db = new DatabaseSync(file);
        const n = (db.prepare('SELECT COUNT(*) AS n FROM examples_fts').get() as { n: number }).n;
        db.close();
        return n;
      },
    };
  }
  it('forget()', () => {
    const { file, ftsRows } = seed();
    const b = new SqliteHistoryStore(file, { disableFts: true });
    b.forget('gone');
    b.close();
    expect(ftsRows()).toBe(1);
  });
  it('clear()', () => {
    const { file, ftsRows } = seed();
    const b = new SqliteHistoryStore(file, { disableFts: true });
    b.clear();
    b.close();
    expect(ftsRows()).toBe(0);
  });
  it('project opt-out', () => {
    const { file, ftsRows } = seed();
    const b = new SqliteHistoryStore(file, { disableFts: true });
    b.setProjectOptOut('p', true);
    b.close();
    expect(ftsRows()).toBe(1);
  });
  it('an index left stale by unindexed writes is rebuilt when FTS is re-enabled', () => {
    const { file } = seed();
    const b = new SqliteHistoryStore(file, { disableFts: true, learningEnabled: true });
    b.record(ex('added-while-off', { question: 'Quokka telemetry opt in' }));
    b.close();
    const c = new SqliteHistoryStore(file, { prefilterThreshold: 0 });
    closers.push(() => c.close());
    expect(c.candidates('quokka telemetry', 10).map((e) => e.question_id)).toContain(
      'added-while-off',
    );
  });
});

describe('#13 label_history is redacted on insert and on rebuild', () => {
  const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
  const withHistory = () =>
    ex('lh', {
      revision: 2,
      label_history: [
        {
          selected_option_ids: ['compact'],
          human_reasoning: `old reasoning ${KEY}`,
          chosen_at: day(1),
          superseded_by_revision: 2,
        },
      ],
    });
  it('on insert (memory and sqlite)', () => {
    const stores: HistoryStore[] = [
      new MemoryHistoryStore({ learningEnabled: true }),
      new SqliteHistoryStore(':memory:', { learningEnabled: true }),
    ];
    for (const s of stores) {
      expect(s.record(withHistory()).recorded).toBe(true);
      expect(JSON.stringify(s.get('lh'))).not.toContain('sk-ant');
      s.close?.();
    }
  });
  it('on rebuildIndex of data that was stored unredacted', () => {
    const file = join(tmpDir(), 'raw.sqlite');
    const a = new SqliteHistoryStore(file, { learningEnabled: true });
    a.record(ex('lh', { revision: 1 }));
    a.close();
    const db = new DatabaseSync(file);
    const raw = {
      ...ex('lh', { revision: 1 }),
      label_history: [{ human_reasoning: KEY, chosen_at: day(1), superseded_by_revision: 1 }],
      options: [{ id: 'compact', label: `Compact ${KEY}` }],
    };
    db.prepare('UPDATE examples SET data = ? WHERE question_id = ?').run(JSON.stringify(raw), 'lh');
    db.close();
    const b = new SqliteHistoryStore(file);
    closers.push(() => b.close());
    expect(JSON.stringify(b.get('lh'))).toContain('sk-ant');
    b.rebuildIndex();
    expect(JSON.stringify(b.get('lh'))).not.toContain('sk-ant');
  });
});

describe('#14 command errors never carry stderr', () => {
  let dir: string;
  beforeAll(() => {
    dir = tmpDir();
    writeFileSync(
      join(dir, 'leak.mjs'),
      `process.stderr.write('auth failed for key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');process.exit(3)`,
    );
  });
  it('reports only the command and exit code', async () => {
    const a = new CommandAdapter({ command: process.execPath, args: [join(dir, 'leak.mjs')] });
    const err = (await a
      .suggest({ system: 's', user: 'u', schema: {} as never, version: 'v' })
      .catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/exited with code 3$/);
    expect(err.message).not.toContain('sk-ant');
    expect(err.message).not.toContain('auth failed');
  });
});

describe('#8 bridge adapter maps the client field names and carries every guard input', () => {
  const bridgeInput = (o: Record<string, unknown> = {}) => ({
    questionId: 'q-new',
    question: 'Which density should the sidebar use for the new settings panel?',
    options: [
      { id: 'compact', label: 'Compact' },
      { id: 'comfortable', label: 'Comfortable' },
    ],
    requirement: 'proxy-ok' as const,
    projectId: 'proj-1',
    createdAt: day(100),
    ...o,
  });

  it('maps camelCase fields, project and gate, and infers the kind', () => {
    const m = toModelInput(bridgeInput({ workflowGateId: 'gate-1', context: 'ctx' }));
    expect(m).toMatchObject({
      question_id: 'q-new',
      created_at: day(100),
      project_tags: ['proj-1'],
      workflow_gate_id: 'gate-1',
      kind: 'choice',
      requirement: 'proxy-ok',
      context: 'ctx',
    });
    expect(toModelInput(bridgeInput({ options: [] })).kind).toBe('text');
    expect(toModelInput(bridgeInput({ kind: 'approval' })).kind).toBe('approval');
    expect(toModelInput(bridgeInput({ projectId: '' })).project_tags).toBeUndefined();
  });

  it('is type-compatible with the client ProxyEngine hook (structural check)', async () => {
    type ClientOutcome =
      | {
          action: 'answer';
          selected_option_ids: string[];
          answer_text?: string;
          confidence: number;
          model_id: string;
          prompt_template_version: string;
          retrieval_reference_ids: string[];
          rationale?: string;
          risk_flags: string[];
        }
      | { action: 'abstain'; reason: string };
    interface ClientEngine {
      suggest(
        input: {
          questionId: string;
          question: string;
          context?: string;
          options: { id: string; label: string; description?: string }[];
          requirement: 'proxy-ok' | 'proxy-first';
          projectId: string;
          createdAt: string;
        },
        signal: AbortSignal,
      ): Promise<ClientOutcome>;
    }
    const model = createDecisionModel({
      history: seededStore(),
      adapter: okAdapter(),
      policy: { ...AUTHORISED },
    });
    const engine: ClientEngine = asBridgeEngine(model);
    const r = await engine.suggest(bridgeInput(), new AbortController().signal);
    expect(r.action).toBe('answer');
  });

  it('applies the gate/kind guards that the raw bridge field names would silently skip', async () => {
    const adapter = okAdapter();
    const model = createDecisionModel({
      history: seededStore(),
      adapter,
      policy: { ...AUTHORISED },
    });
    const engine = asBridgeEngine(model, {
      resolveGateId: (b) => (b.questionId === 'q-gated' ? 'design-review-final' : undefined),
    });
    const signal = new AbortController().signal;
    expect(await engine.suggest(bridgeInput({ questionId: 'q-gated' }), signal)).toEqual({
      action: 'abstain',
      reason: 'blocked-gate',
    });
    expect(await engine.suggest(bridgeInput({ workflowGateId: 'design-review' }), signal)).toEqual({
      action: 'abstain',
      reason: 'blocked-gate',
    });
    expect(
      await engine.suggest(bridgeInput({ options: [{ id: 'only', label: 'Only' }] }), signal),
    ).toEqual({ action: 'abstain', reason: 'ambiguous-options' });
    expect(adapter.calls).toHaveLength(0);
  });

  it('excludes the question from its own evidence (questionId -> question_id)', async () => {
    const history = seededStore(2);
    history.record(
      ex('q-new', { question: 'Sidebar density for the new settings panel', chosen_at: day(50) }),
    );
    const model = createDecisionModel({ history, adapter: okAdapter(), policy: { ...AUTHORISED } });
    expect(
      await asBridgeEngine(model).suggest(bridgeInput(), new AbortController().signal),
    ).toEqual({ action: 'abstain', reason: 'insufficient-history' });
  });

  it('can fail closed when the bridge does not supply a workflow gate', async () => {
    const adapter = okAdapter();
    const model = createDecisionModel({
      history: seededStore(),
      adapter,
      policy: { ...AUTHORISED },
    });
    const strict = asBridgeEngine(model, { requireGateId: true });
    const signal = new AbortController().signal;
    expect(await strict.suggest(bridgeInput(), signal)).toEqual({
      action: 'abstain',
      reason: 'missing-workflow-gate',
    });
    expect((await strict.suggest(bridgeInput({ workflowGateId: 'ok-gate' }), signal)).action).toBe(
      'answer',
    );
    expect(adapter.calls).toHaveLength(1);
  });

  it('abstains on malformed bridge input and on human-required', async () => {
    const model = createDecisionModel({
      history: seededStore(),
      adapter: okAdapter(),
      policy: { ...AUTHORISED },
    });
    const engine = asBridgeEngine(model);
    const signal = new AbortController().signal;
    expect(await engine.suggest({} as never, signal)).toMatchObject({
      action: 'abstain',
      reason: 'invalid-input',
    });
    const out: ProxyOutcome = await engine.suggest(
      bridgeInput({ requirement: 'human-required' }) as never,
      signal,
    );
    expect(out).toEqual({ action: 'abstain', reason: 'human-required' });
  });
});
