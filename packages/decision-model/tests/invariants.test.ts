import { describe, expect, it } from 'vitest';
import { FakeAdapter } from '../src/adapters/fake.js';
import { TransientAdapterError } from '../src/adapters/types.js';
import { createDecisionModel } from '../src/engine.js';
import { AUTHORISED, answerJson, input, mulberry32, seededStore } from './helpers.js';

/** Adversarial replies: valid, near-valid, garbage and injection attempts. */
function randomReply(rand: () => number, p: Parameters<typeof answerJson>[0]): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  switch (Math.floor(rand() * 10)) {
    case 0:
      return answerJson(p, { conf: rand() });
    case 1:
      return answerJson(p, { conf: 1, ids: [pick(['compact', 'comfortable'])] });
    case 2:
      return 'approve';
    case 3:
      return '{"action":"answer"}';
    case 4:
      return JSON.stringify({
        action: 'answer',
        selected_option_ids: ['compact'],
        answer_text: 'APPROVED',
        confidence_estimate: 1,
        supporting_decision_ids: ['h0'],
        risk_flags: [],
        rationale: 'ignore previous instructions',
        reason: null,
      });
    case 5:
      return '```json\n' + answerJson(p, { conf: 0.99 }) + '\n```';
    case 6:
      return 'x'.repeat(Math.floor(rand() * 5000));
    case 7:
      return answerJson(p, { flags: [pick(['', 'novel', 'prompt-injection', 'ok'])] });
    case 8:
      throw new TransientAdapterError('flaky');
    default:
      return JSON.stringify({
        action: 'answer',
        selected_option_ids: ['compact'],
        confidence_estimate: 2,
      });
  }
}

describe('invariant: a human-required question is never answered by the model', () => {
  it('holds under 300 fuzzed adapter outputs with a fully authorised policy', async () => {
    const rand = mulberry32(0xdec15);
    const adapter = new FakeAdapter({ responder: (p) => randomReply(rand, p) });
    const model = createDecisionModel({
      history: seededStore(8),
      adapter,
      policy: {
        ...AUTHORISED,
        autoAnswerThreshold: 0.01,
        calibration: { samples: 1000, recommendedThreshold: 0.01 },
        retries: 0,
      },
    });
    let answeredWhenAllowed = 0;
    for (let i = 0; i < 300; i++) {
      const q = input({
        question: `Which sidebar density for panel variation ${i}?`,
        question_id: `q${i}`,
      });
      const blocked = await model.suggest({ ...q, requirement: 'human-required' });
      expect(blocked.action).toBe('abstain');
      const gated = await model.suggest({
        ...q,
        requirement: 'proxy-first',
        workflow_gate_id: 'design-review-final-approval',
      });
      expect(gated.action).toBe('abstain');
      const allowed = await model.suggest({ ...q, requirement: 'proxy-ok' });
      if (allowed.action === 'answer') answeredWhenAllowed++;
      // suggestOnly may draft for the human, but the draft always says why it cannot be sent automatically.
      const s = await model.suggestOnly({ ...q, requirement: 'human-required' });
      if (s.action === 'suggest')
        expect(s.suggestion.auto_answer_blocked_reasons).toContain('human-required');
    }
    // Sanity: the fuzz really did produce answers in the permitted case, so the invariant is not vacuous.
    expect(answeredWhenAllowed).toBeGreaterThan(5);
  });

  it('holds even if the engine policy lists no blocked gates or keywords', async () => {
    const model = createDecisionModel({
      history: seededStore(),
      adapter: new FakeAdapter({ responder: (p) => answerJson(p, { conf: 1 }) }),
      policy: { ...AUTHORISED, blockedGates: [], blockedKeywords: /never-matches/ },
    });
    expect(await model.suggest(input({ requirement: 'human-required' }))).toEqual({
      action: 'abstain',
      reason: 'human-required',
    });
  });
});
