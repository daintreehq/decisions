import type { DecisionModelAdapter } from './adapters/types.js';
import { DecisionModel, type CalibrationData, type DecisionModelPolicy } from './engine.js';
import { MemoryHistoryStore, type HistoryStore } from './history.js';
import { redactSecrets } from './redact.js';
import type { DecisionExample, ProxyQuestionInput } from './types.js';

export interface EvaluateOptions {
  examples: DecisionExample[];
  adapter: DecisionModelAdapter;
  policy?: DecisionModelPolicy | undefined;
  /** Accuracy a confidence band must reach to be recommended as an auto-answer threshold. Default 0.9. */
  targetAccuracy?: number | undefined;
  /** Minimum answered examples at-or-above a threshold before it can be recommended. Default 30. */
  minSamples?: number | undefined;
  /** Ascending bucket boundaries in (0,1). Default [0.5,0.6,0.7,0.8,0.9]. */
  bucketEdges?: number[] | undefined;
  /** Replay starts predicting only after this many earlier examples were seen. Default 1. */
  minTrainExamples?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface EvaluationItem {
  question_id: string;
  kind: string;
  chosen_at: string;
  actual: string[];
  predicted: string[] | null;
  confidence: number | null;
  correct: boolean | null;
  abstain_reason: string | null;
}

export interface Bucket {
  lo: number;
  hi: number;
  n: number;
  correct: number;
  accuracy: number | null;
}

export interface EvaluationReport {
  total: number;
  /** Examples that have a choice among offered options and could be scored. */
  scored: number;
  unscored: number;
  answered: number;
  abstained: number;
  /** answered / scored */
  coverage: number | null;
  correct: number;
  accuracy: number | null;
  /** Wrong answers among answered: how often the model would have disagreed with the human. */
  disagreement_rate: number | null;
  by_kind: Record<string, { answered: number; correct: number; accuracy: number | null }>;
  buckets: Bucket[];
  abstain_reasons: Record<string, number>;
  target_accuracy: number;
  min_samples: number;
  recommended_threshold: number | null;
  calibration: CalibrationData;
  items: EvaluationItem[];
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

function toInput(ex: DecisionExample): ProxyQuestionInput {
  const options = ex.options ?? [];
  const input: ProxyQuestionInput = {
    question_id: ex.question_id,
    question: ex.question,
    options: options.map((o) => ({ id: o.id, label: o.label })),
    kind: ex.kind ?? (options.length >= 2 ? 'choice' : 'text'),
    // Evaluation measures the model, not the policy gate, so it never uses human-required.
    requirement: 'proxy-ok',
    created_at: ex.created_at,
  };
  if (ex.context_summary) input.context = ex.context_summary;
  if (ex.project_tags) input.project_tags = ex.project_tags;
  return input;
}

/**
 * Chronological replay: for each human decision, predict it from only the decisions made before it, then add
 * it to the history. Never trains on the future, so the numbers are an honest estimate of live behaviour.
 */
export async function evaluateHistory(opts: EvaluateOptions): Promise<EvaluationReport> {
  const target = opts.targetAccuracy ?? 0.9;
  const minSamples = opts.minSamples ?? 30;
  const edges = [...(opts.bucketEdges ?? [0.5, 0.6, 0.7, 0.8, 0.9])].sort((a, b) => a - b);
  const minTrain = opts.minTrainExamples ?? 1;

  const store: HistoryStore = new MemoryHistoryStore({ learningEnabled: true });
  const engine = new DecisionModel({
    history: store,
    adapter: opts.adapter,
    policy: { ...(opts.policy ?? {}), autoAnswerThreshold: null },
  });

  const sorted = [...opts.examples].sort(
    (a, b) => Date.parse(a.chosen_at) - Date.parse(b.chosen_at),
  );
  const items: EvaluationItem[] = [];
  const abstainReasons: Record<string, number> = {};
  let seen = 0;

  for (const ex of sorted) {
    if (opts.signal?.aborted) break;
    const actual = ex.selected_option_ids ?? [];
    const scoreable = actual.length > 0 && (ex.options?.length ?? 0) > 0;
    if (scoreable) {
      const kind = ex.kind ?? ((ex.options?.length ?? 0) >= 2 ? 'choice' : 'text');
      let item: EvaluationItem;
      if (seen < minTrain) {
        item = {
          question_id: ex.question_id,
          kind,
          chosen_at: ex.chosen_at,
          actual,
          predicted: null,
          confidence: null,
          correct: null,
          abstain_reason: 'insufficient-history',
        };
      } else {
        const r = await engine.suggestOnly(toInput(ex), opts.signal);
        if (r.action === 'suggest') {
          const predicted = r.suggestion.selected_option_ids;
          item = {
            question_id: ex.question_id,
            kind,
            chosen_at: ex.chosen_at,
            actual,
            predicted,
            confidence: r.suggestion.confidence,
            correct: sameSet(predicted, actual),
            abstain_reason: null,
          };
        } else {
          item = {
            question_id: ex.question_id,
            kind,
            chosen_at: ex.chosen_at,
            actual,
            predicted: null,
            confidence: null,
            correct: null,
            abstain_reason: r.reason,
          };
        }
      }
      if (item.abstain_reason) {
        const k = item.abstain_reason.split(':')[0]!;
        abstainReasons[k] = (abstainReasons[k] ?? 0) + 1;
      }
      items.push(item);
    }
    // Learn from the decision only after predicting it.
    store.record(ex);
    seen++;
  }

  const answeredItems = items.filter((i) => i.correct !== null);
  const correct = answeredItems.filter((i) => i.correct).length;

  const byKind: EvaluationReport['by_kind'] = {};
  for (const i of answeredItems) {
    const k = (byKind[i.kind] ??= { answered: 0, correct: 0, accuracy: null });
    k.answered++;
    if (i.correct) k.correct++;
  }
  for (const k of Object.values(byKind)) k.accuracy = ratio(k.correct, k.answered);

  const lows = [0, ...edges];
  const highs = [...edges, 1];
  const buckets: Bucket[] = lows.map((lo, idx) => {
    const hi = highs[idx]!;
    const inB = answeredItems.filter(
      (i) =>
        i.confidence! >= lo && (idx === lows.length - 1 ? i.confidence! <= hi : i.confidence! < hi),
    );
    const c = inB.filter((i) => i.correct).length;
    return { lo, hi, n: inB.length, correct: c, accuracy: ratio(c, inB.length) };
  });

  let recommended: number | null = null;
  for (const lo of lows) {
    const atOrAbove = answeredItems.filter((i) => i.confidence! >= lo);
    const c = atOrAbove.filter((i) => i.correct).length;
    if (atOrAbove.length >= minSamples && c / atOrAbove.length >= target) {
      recommended = lo;
      break;
    }
  }

  return {
    total: sorted.length,
    scored: items.length,
    unscored: sorted.length - items.length,
    answered: answeredItems.length,
    abstained: items.length - answeredItems.length,
    coverage: ratio(answeredItems.length, items.length),
    correct,
    accuracy: ratio(correct, answeredItems.length),
    disagreement_rate: ratio(answeredItems.length - correct, answeredItems.length),
    by_kind: byKind,
    buckets,
    abstain_reasons: abstainReasons,
    target_accuracy: target,
    min_samples: minSamples,
    recommended_threshold: recommended,
    calibration: {
      samples: answeredItems.length,
      recommendedThreshold: recommended,
      evaluatedAt: new Date().toISOString(),
    },
    items,
  };
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** Plain-text report for terminals and logs. The JSON form is the report object itself. */
export function formatReport(r: EvaluationReport): string {
  const lines = [
    'Decision model evaluation (chronological replay)',
    `  examples: ${r.total} (${r.scored} scoreable, ${r.unscored} not scoreable)`,
    `  answered: ${r.answered}   abstained: ${r.abstained}   coverage: ${pct(r.coverage)}`,
    `  accuracy on answered: ${pct(r.accuracy)}   disagreement with you: ${pct(r.disagreement_rate)}`,
    '  by kind:',
    ...Object.entries(r.by_kind).map(
      ([k, v]) => `    ${k.padEnd(9)} ${v.correct}/${v.answered} (${pct(v.accuracy)})`,
    ),
    '  by self-reported confidence (not calibrated probabilities):',
    ...r.buckets.map(
      (b) =>
        `    [${b.lo.toFixed(2)}, ${b.hi.toFixed(2)}${b === r.buckets[r.buckets.length - 1] ? ']' : ')'}  n=${String(b.n).padStart(3)}  accuracy ${pct(b.accuracy)}`,
    ),
    '  abstentions:',
    ...(Object.entries(r.abstain_reasons).length
      ? Object.entries(r.abstain_reasons).map(([k, n]) => `    ${k}: ${n}`)
      : ['    none']),
    `  target accuracy ${pct(r.target_accuracy)} with at least ${r.min_samples} samples ->`,
    r.recommended_threshold === null
      ? '  recommended auto-answer threshold: none (stay suggestion-only)'
      : `  recommended auto-answer threshold: ${r.recommended_threshold.toFixed(2)}`,
  ];
  return lines.join('\n');
}

/**
 * WARNING: the output contains your real decisions (redacted for obvious secrets only). Keep it local, review it
 * before sending it to any training service, and never mix in proxy-generated answers.
 */
export const FINE_TUNING_WARNING =
  'Fine-tuning export contains your private decision history. Review it, keep it on your machine unless you ' +
  'deliberately upload it, and note that automatic redaction only catches common credential formats.';

export interface FineTuneOptions {
  format?: 'jsonl-chat';
  systemPrompt?: string;
}

export function exportForFineTuning(history: HistoryStore, opts: FineTuneOptions = {}): string {
  const system =
    opts.systemPrompt ??
    'Predict how the owner would answer this question from an AI coding agent. Reply with a JSON object {"selected_option_ids":[...],"answer_text":string|null}.';
  const lines: string[] = [];
  const sorted = history.all().sort((a, b) => Date.parse(a.chosen_at) - Date.parse(b.chosen_at));
  for (const ex of sorted) {
    if ((ex as { source?: unknown }).source !== 'human') continue;
    if (ex.outcome === 'reversed') continue;
    if ((ex.selected_option_ids?.length ?? 0) === 0 && !ex.human_reasoning) continue;
    const user = [
      `Question: ${redactSecrets(ex.question)}`,
      ex.context_summary ? `Context: ${redactSecrets(ex.context_summary)}` : '',
      ex.options?.length
        ? `Options:\n${ex.options.map((o) => `- ${o.id}: ${redactSecrets(o.label)}`).join('\n')}`
        : '',
      ex.project_tags?.length ? `Project: ${ex.project_tags.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const assistant = JSON.stringify({
      selected_option_ids: ex.selected_option_ids ?? [],
      answer_text: ex.human_reasoning ? redactSecrets(ex.human_reasoning) : null,
    });
    lines.push(
      JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
          { role: 'assistant', content: assistant },
        ],
      }),
    );
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
