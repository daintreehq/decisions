import { FakeAdapter } from '../src/adapters/fake.js';
import type { ModelPrompt } from '../src/prompt.js';
import { MemoryHistoryStore, type HistoryStore } from '../src/history.js';
import type { DecisionExample, ProxyQuestionInput } from '../src/types.js';

export const OPTIONS = [
  { id: 'compact', label: 'Compact' },
  { id: 'comfortable', label: 'Comfortable' },
];

export function day(n: number): string {
  return new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
}

export function ex(id: string, o: Partial<DecisionExample> = {}): DecisionExample {
  return {
    question_id: id,
    question: 'Should the sidebar use a compact or comfortable density?',
    options: OPTIONS,
    selected_option_ids: ['compact'],
    created_at: day(0),
    chosen_at: day(1),
    policy_level: 'proxy-ok',
    source: 'human',
    ...o,
  };
}

export function input(o: Partial<ProxyQuestionInput> = {}): ProxyQuestionInput {
  return {
    question_id: 'q-new',
    question: 'Which density should the sidebar use for the new settings panel?',
    options: OPTIONS,
    kind: 'choice',
    requirement: 'proxy-ok',
    created_at: day(100),
    ...o,
  };
}

export function seededStore(n = 5, extra: Partial<DecisionExample> = {}): HistoryStore {
  const s = new MemoryHistoryStore({ learningEnabled: true });
  for (let i = 0; i < n; i++) {
    const r = s.record(
      ex(`h${i}`, {
        question: `Sidebar density for panel number ${i}: compact or comfortable?`,
        chosen_at: day(i + 1),
        ...extra,
      }),
    );
    if (!r.recorded) throw new Error('seed failed: ' + r.reason);
  }
  return s;
}

/** Example ids that were put into the prompt. */
export function idsFromPrompt(p: ModelPrompt): string[] {
  return [...p.user.matchAll(/\[example id=([^\s\]]+)/g)].map((m) => m[1]!);
}

export function answerJson(
  p: ModelPrompt,
  o: Partial<{
    ids: string[];
    conf: number;
    flags: string[];
    text: string | null;
    support: string[];
  }> = {},
): string {
  const support = o.support ?? idsFromPrompt(p).slice(0, 2);
  return JSON.stringify({
    action: 'answer',
    selected_option_ids: o.ids ?? ['compact'],
    answer_text: o.text ?? null,
    confidence_estimate: o.conf ?? 0.9,
    supporting_decision_ids: support,
    risk_flags: o.flags ?? [],
    rationale: 'Past decisions consistently prefer compact.',
    reason: null,
  });
}

export const abstainJson = (reason = 'not sure'): string =>
  JSON.stringify({
    action: 'abstain',
    selected_option_ids: [],
    answer_text: null,
    confidence_estimate: null,
    supporting_decision_ids: [],
    risk_flags: [],
    rationale: null,
    reason,
  });

export const okAdapter = (o: Parameters<typeof answerJson>[1] = {}): FakeAdapter =>
  new FakeAdapter({ responder: (p) => answerJson(p, o) });

export const AUTHORISED = {
  autoAnswerThreshold: 0.8,
  calibration: { samples: 50, recommendedThreshold: 0.7 },
  retryDelayMs: 1,
} as const;

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
