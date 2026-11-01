import { describe, expect, it } from 'vitest';
import { FakeAdapter } from '../src/adapters/fake.js';
import { createDecisionModel } from '../src/engine.js';
import { exportForFineTuning, formatReport, evaluateHistory } from '../src/evaluate.js';
import { MemoryHistoryStore } from '../src/history.js';
import { answerJson, day, ex, seededStore } from './helpers.js';

/** 40 sidebar decisions, all "compact". The fake model is wrong on every 7th panel. */
function timeline() {
  return Array.from({ length: 40 }, (_, i) =>
    ex(`e${i}`, {
      question: `Sidebar density for panel #${i}: compact or comfortable?`,
      chosen_at: day(i + 1),
      created_at: day(i),
    }),
  );
}
function adapter(wrongConf: number, rightConf = 0.85): FakeAdapter {
  return new FakeAdapter({
    responder: (p) => {
      const n = Number(/QUESTION \([^\n]*\n[^\n]*#(\d+)/.exec(p.user)?.[1] ?? '0');
      const wrong = n % 7 === 0;
      return answerJson(p, {
        ids: [wrong ? 'comfortable' : 'compact'],
        conf: wrong ? wrongConf : rightConf,
      });
    },
  });
}

describe('evaluateHistory', () => {
  it('replays chronologically and computes accuracy, coverage, buckets and disagreement', async () => {
    const r = await evaluateHistory({
      examples: timeline().reverse(),
      adapter: adapter(0.95),
      targetAccuracy: 0.9,
      minSamples: 30,
    });
    // The first three decisions have too little history to predict from.
    expect(r.total).toBe(40);
    expect(r.scored).toBe(40);
    expect(r.abstained).toBe(3);
    expect(r.abstain_reasons).toEqual({ 'insufficient-history': 3 });
    expect(r.answered).toBe(37);
    expect(r.coverage).toBeCloseTo(37 / 40);
    // Wrong on panels 7, 14, 21, 28, 35.
    expect(r.correct).toBe(32);
    expect(r.accuracy).toBeCloseTo(32 / 37);
    expect(r.disagreement_rate).toBeCloseTo(5 / 37);
    expect(r.by_kind.choice).toEqual({ answered: 37, correct: 32, accuracy: 32 / 37 });
    const top = r.buckets[r.buckets.length - 1]!;
    const mid = r.buckets.find((b) => b.lo === 0.8)!;
    expect(top).toMatchObject({ lo: 0.9, hi: 1, n: 5, correct: 0, accuracy: 0 });
    expect(mid).toMatchObject({ n: 32, correct: 32, accuracy: 1 });
    expect(r.buckets.reduce((n, b) => n + b.n, 0)).toBe(37);
    // 86.5% overall never reaches the 90% target, and the 0.9+ band has too few samples.
    expect(r.recommended_threshold).toBeNull();
    expect(r.calibration).toMatchObject({ samples: 37, recommendedThreshold: null });
  });

  it('never learns from the future: each prediction sees only earlier decisions', async () => {
    const seenCounts: number[] = [];
    const a = new FakeAdapter({
      responder: (p) => {
        seenCounts.push((p.user.match(/\[example id=/g) ?? []).length);
        return answerJson(p);
      },
    });
    await evaluateHistory({ examples: timeline(), adapter: a });
    // The model is first consulted for the 4th decision, which can only see the 3 before it; the prompt then
    // grows by exactly one example per decision (capped at the default retrieval limit of 8), proving nothing later leaks in.
    expect(seenCounts).toHaveLength(37);
    expect(seenCounts.every((n, i) => n === Math.min(i + 3, 8))).toBe(true);
  });

  it('recommends the smallest threshold that meets the target with enough samples', async () => {
    // Wrong answers are low-confidence, so everything at or above 0.6 is perfect.
    const r = await evaluateHistory({
      examples: timeline(),
      adapter: adapter(0.55),
      targetAccuracy: 0.9,
      minSamples: 30,
    });
    expect(r.recommended_threshold).toBe(0.6);
    const lax = await evaluateHistory({
      examples: timeline(),
      adapter: adapter(0.95),
      targetAccuracy: 0.85,
      minSamples: 30,
    });
    expect(lax.recommended_threshold).toBe(0);
    const strictSamples = await evaluateHistory({
      examples: timeline(),
      adapter: adapter(0.55),
      targetAccuracy: 0.9,
      minSamples: 50,
    });
    expect(strictSamples.recommended_threshold).toBeNull();
  });

  it('engine.evaluate feeds a calibration that can authorise auto-answers', async () => {
    const history = new MemoryHistoryStore({ learningEnabled: true });
    for (const e of timeline()) history.record(e);
    const model = createDecisionModel({
      history,
      adapter: adapter(0.55),
      policy: { autoAnswerThreshold: 0.6 },
    });
    const report = await model.evaluate({ targetAccuracy: 0.9, minSamples: 30 });
    expect(report.recommended_threshold).toBe(0.6);
    expect(model.effectiveThreshold()).toBeNull();
    model.setCalibration(report.calibration);
    expect(model.effectiveThreshold()).toBe(0.6);
  });

  it('does not score free-text decisions and ignores aborted runs', async () => {
    const items = [
      ...timeline().slice(0, 5),
      ex('free', {
        selected_option_ids: [],
        human_reasoning: 'just do it',
        options: [],
        chosen_at: day(50),
      }),
    ];
    const r = await evaluateHistory({ examples: items, adapter: adapter(0.9) });
    expect(r.total).toBe(6);
    expect(r.scored).toBe(5);
    expect(r.unscored).toBe(1);
    const ac = new AbortController();
    ac.abort();
    expect(
      (await evaluateHistory({ examples: timeline(), adapter: adapter(0.9), signal: ac.signal }))
        .items,
    ).toHaveLength(0);
  });

  it('formats a readable text report', async () => {
    const r = await evaluateHistory({ examples: timeline(), adapter: adapter(0.95) });
    const text = formatReport(r);
    expect(text).toContain('answered: 37');
    expect(text).toContain('accuracy on answered: 86.5%');
    expect(text).toContain('recommended auto-answer threshold: none');
    expect(JSON.parse(JSON.stringify(r)).answered).toBe(37);
  });
});

describe('exportForFineTuning', () => {
  it('exports only redacted human labels as chat JSONL', () => {
    const h = seededStore(3);
    h.record(
      ex('rev', {
        question: 'Sidebar secret sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 panel',
        outcome: 'reversed',
        chosen_at: day(10),
      }),
    );
    h.record(
      ex('txt', {
        question: 'Sidebar text only question',
        selected_option_ids: [],
        options: [],
        human_reasoning: 'Use API_KEY=abc then proceed',
        chosen_at: day(11),
      }),
    );
    const out = exportForFineTuning(h);
    const lines = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    expect(out).not.toContain('sk-ant');
    expect(out).not.toContain('abc then');
    expect(JSON.stringify(lines)).not.toContain('"rev"');
    for (const l of lines) {
      expect(l.messages.map((m: { role: string }) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
      ]);
      expect(() => JSON.parse(l.messages[2].content)).not.toThrow();
    }
    expect(exportForFineTuning(new MemoryHistoryStore({ learningEnabled: true }))).toBe('');
  });
});
