import { createHash } from 'node:crypto';
import { canonicalize } from '@daintree/decisions-protocol';
import {
  AdapterTimeoutError,
  TransientAdapterError,
  abortError,
  type DecisionModelAdapter,
} from './adapters/types.js';
import { evaluateHistory, type EvaluateOptions, type EvaluationReport } from './evaluate.js';
import {
  BLOCKING_RISK_FLAG,
  DEFAULT_BLOCKED_GATES,
  DEFAULT_BLOCKED_KEYWORDS,
  injectionHit,
  keywordHit,
  matchesGate,
  optionProblem,
  validateModelReply,
  type ValidatedDecision,
} from './guards.js';
import type { HistoryStore } from './history.js';
import {
  PROMPT_TEMPLATE_VERSION,
  buildPrompt,
  type ModelPrompt,
  type PromptOptions,
} from './prompt.js';
import { retrieve, type RetrievalOptions } from './retrieval.js';
import type {
  ProxyEngine,
  ProxyOutcome,
  ProxyQuestionInput,
  ProxySuggestion,
  SuggestOutcome,
} from './types.js';

/** One scored historical prediction: the model's self-reported confidence and whether it matched the human. */
export interface CalibrationPoint {
  confidence: number;
  correct: boolean;
}

/**
 * Evidence from a chronological replay (`evaluateHistory(...).calibration`). Authorisation is computed from the
 * individual points for the exact threshold in use, never from a summary, so a threshold is only trusted when the
 * band at-or-above it has enough samples and meets the target accuracy by itself.
 */
export interface CalibrationData {
  /** Number of evaluated (answered) historical examples; informational. */
  samples: number;
  /** Smallest confidence band that met the target during evaluation, or null; informational. */
  recommendedThreshold: number | null;
  /** Accuracy the replay was held to. */
  targetAccuracy: number;
  points: CalibrationPoint[];
  evaluatedAt?: string;
}

export interface DecisionModelPolicy {
  /** Minimum relevant past decisions before the model may say anything. Default 3. */
  minExamples?: number;
  blockedGates?: (string | RegExp)[];
  blockedKeywords?: RegExp;
  /**
   * Operator-chosen confidence needed for an automatic proxy answer. `null` (default) means suggestion-only:
   * the engine never answers on its own. It is honoured only while `calibration` authorises it.
   */
  autoAnswerThreshold?: number | null;
  calibration?: CalibrationData | null;
  minCalibrationSamples?: number;
  /** Calibration held to a lower accuracy target than this cannot authorise auto-answers. Default 0.8. */
  minTargetAccuracy?: number;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  maxConcurrent?: number;
  maxQueue?: number;
  cacheSize?: number;
  retrieval?: RetrievalOptions;
  prompt?: PromptOptions;
}

export interface CreateDecisionModelOptions {
  history: HistoryStore;
  adapter: DecisionModelAdapter;
  policy?: DecisionModelPolicy;
}

class BusyError extends Error {
  constructor() {
    super('decision model is busy');
  }
}

class Limiter {
  private active = 0;
  private readonly queue: { start: () => void; reject: (e: Error) => void }[] = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  run<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = (): void => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.queue.shift()?.start();
          });
      };
      if (this.active < this.max) return go();
      if (this.queue.length >= this.maxQueue) return reject(new BusyError());
      const item = {
        start: () => {
          signal.removeEventListener('abort', onAbort);
          go();
        },
        reject,
      };
      const onAbort = (): void => {
        const i = this.queue.indexOf(item);
        if (i >= 0) this.queue.splice(i, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(item);
    });
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(abortError())), { once: true });
  });

/** Rejects with `AdapterTimeoutError` at the deadline even if the adapter ignores its signal. */
function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent: AbortSignal,
): Promise<T> {
  const ac = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const onParent = (): void => {
      ac.abort();
      reject(abortError());
    };
    if (parent.aborted) return reject(abortError());
    parent.addEventListener('abort', onParent, { once: true });
    const timer = setTimeout(
      () => {
        ac.abort();
        reject(new AdapterTimeoutError());
      },
      Math.max(1, ms),
    );
    fn(ac.signal)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        parent.removeEventListener('abort', onParent);
      });
  });
}

interface Inflight {
  promise: Promise<string>;
  ac: AbortController;
  refs: number;
  done: boolean;
}

type Analysis =
  | { type: 'abstain'; reason: string }
  | { type: 'decision'; decision: ValidatedDecision; blocks: string[]; referenceIds: string[] };

const TERMINAL_REASONS = {
  aborted: 'aborted',
  timeout: 'timeout',
  busy: 'busy',
  modelError: 'model-error',
} as const;

export class DecisionModel implements ProxyEngine {
  private readonly history: HistoryStore;
  private readonly adapter: DecisionModelAdapter;
  private policy: DecisionModelPolicy;
  private readonly limiter: Limiter;
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, Inflight>();

  constructor(opts: CreateDecisionModelOptions) {
    this.history = opts.history;
    this.adapter = opts.adapter;
    this.policy = opts.policy ?? {};
    this.limiter = new Limiter(this.policy.maxConcurrent ?? 2, this.policy.maxQueue ?? 16);
  }

  /**
   * Confidence needed for an automatic answer, or null while the engine is suggestion-only. The operator's threshold
   * is honoured only if the calibration evidence for exactly that threshold qualifies: at least
   * `minCalibrationSamples` replayed predictions at or above it, with accuracy meeting the calibration's target
   * (itself no lower than `minTargetAccuracy`).
   */
  effectiveThreshold(): number | null {
    const p = this.policy;
    const t = p.autoAnswerThreshold ?? null;
    const c = p.calibration;
    if (t === null || !c || !(t >= 0 && t <= 1)) return null;
    if (!Array.isArray(c.points) || typeof c.targetAccuracy !== 'number') return null;
    if (!(c.targetAccuracy >= (p.minTargetAccuracy ?? 0.8) && c.targetAccuracy <= 1)) return null;
    const min = p.minCalibrationSamples ?? 30;
    const band = c.points.filter(
      (x) =>
        x &&
        typeof x.confidence === 'number' &&
        Number.isFinite(x.confidence) &&
        typeof x.correct === 'boolean' &&
        x.confidence >= t,
    );
    if (band.length < min) return null;
    const accuracy = band.filter((x) => x.correct).length / band.length;
    return accuracy >= c.targetAccuracy ? t : null;
  }

  setCalibration(calibration: CalibrationData | null): void {
    this.policy = { ...this.policy, calibration };
  }
  setAutoAnswerThreshold(threshold: number | null): void {
    this.policy = { ...this.policy, autoAnswerThreshold: threshold };
  }
  clearCache(): void {
    this.cache.clear();
  }

  async suggest(input: ProxyQuestionInput, signal?: AbortSignal): Promise<ProxyOutcome> {
    try {
      const a = await this.analyse(input, signal, false);
      if (a.type === 'abstain') return { action: 'abstain', reason: a.reason };
      const suggestion = this.toSuggestion(a);
      // Defence in depth: independent of everything above, a human-required question is never answered.
      if (input.requirement === 'human-required' && a.blocks.length === 0)
        a.blocks.push('human-required');
      if (a.blocks.length > 0) {
        suggestion.auto_answer_blocked_reasons = [...a.blocks];
        return { action: 'abstain', reason: a.blocks[0]!, suggestion };
      }
      const out: Extract<ProxyOutcome, { action: 'answer' }> = {
        action: 'answer',
        selected_option_ids: suggestion.selected_option_ids,
        confidence: suggestion.confidence,
        model_id: suggestion.model_id,
        prompt_template_version: suggestion.prompt_template_version,
        retrieval_reference_ids: suggestion.retrieval_reference_ids,
        risk_flags: suggestion.risk_flags,
      };
      if (suggestion.answer_text) out.answer_text = suggestion.answer_text;
      if (suggestion.rationale) out.rationale = suggestion.rationale;
      return out;
    } catch {
      return { action: 'abstain', reason: 'engine-error' };
    }
  }

  /**
   * A suggestion for the human to see. Works for `human-required` questions and blocked topics too, because it
   * can never be sent as an answer: `auto_answer_blocked_reasons` says why.
   */
  async suggestOnly(input: ProxyQuestionInput, signal?: AbortSignal): Promise<SuggestOutcome> {
    try {
      const a = await this.analyse(input, signal, true);
      if (a.type === 'abstain') return { action: 'abstain', reason: a.reason };
      const suggestion = this.toSuggestion(a);
      suggestion.auto_answer_blocked_reasons = [...a.blocks];
      return { action: 'suggest', suggestion };
    } catch {
      return { action: 'abstain', reason: 'engine-error' };
    }
  }

  /** Time-separated replay of the human's own history; see `evaluateHistory`. */
  evaluate(opts: Partial<EvaluateOptions> = {}): Promise<EvaluationReport> {
    return evaluateHistory({
      examples: opts.examples ?? this.history.all(),
      adapter: this.adapter,
      policy: { ...this.policy, ...(opts.policy ?? {}) },
      targetAccuracy: opts.targetAccuracy,
      minSamples: opts.minSamples,
      bucketEdges: opts.bucketEdges,
      minTrainExamples: opts.minTrainExamples,
      signal: opts.signal,
    });
  }

  private toSuggestion(a: Extract<Analysis, { type: 'decision' }>): ProxySuggestion {
    const d = a.decision;
    const s: ProxySuggestion = {
      selected_option_ids: d.selected_option_ids,
      confidence: d.confidence,
      model_id: this.adapter.modelId ?? this.adapter.id,
      prompt_template_version: PROMPT_TEMPLATE_VERSION,
      retrieval_reference_ids: a.referenceIds,
      risk_flags: d.risk_flags,
      auto_answer_blocked_reasons: [],
    };
    if (d.answer_text) s.answer_text = d.answer_text;
    if (d.rationale) s.rationale = d.rationale;
    return s;
  }

  private async analyse(
    input: ProxyQuestionInput,
    signal: AbortSignal | undefined,
    draft: boolean,
  ): Promise<Analysis> {
    const p = this.policy;
    if (signal?.aborted) return { type: 'abstain', reason: TERMINAL_REASONS.aborted };

    // 1. Blocks that forbid automatic answering. suggest() stops here; suggestOnly() may still draft.
    const blocks: string[] = [];
    if (input.requirement === 'human-required') blocks.push('human-required');
    if (matchesGate(input.workflow_gate_id, p.blockedGates ?? DEFAULT_BLOCKED_GATES))
      blocks.push('blocked-gate');
    const kw = keywordHit(input, p.blockedKeywords ?? DEFAULT_BLOCKED_KEYWORDS);
    if (kw) blocks.push(`blocked-topic:${kw}`);
    if (!draft && blocks.length > 0) return { type: 'abstain', reason: blocks[0]! };

    // 2. Blocks that forbid even drafting.
    if (injectionHit(input)) return { type: 'abstain', reason: 'prompt-injection-suspected' };
    const op = optionProblem(input);
    if (op) return { type: 'abstain', reason: op };

    // 3. Evidence. Capture the history version now: anything learned or forgotten while the model runs
    // invalidates the evidence this answer would rest on.
    const historyVersion = this.history.version();
    const retrieval = retrieve(this.history, input, p.retrieval);
    if (retrieval.examples.length < (p.minExamples ?? 3))
      return { type: 'abstain', reason: 'insufficient-history' };
    if (retrieval.contradictory) return { type: 'abstain', reason: 'contradictory-history' };

    // 4. One inference per question content (cached; concurrent callers share one call).
    const built = buildPrompt(input, retrieval, p.prompt);
    // Truncation to fit the prompt budget must not slip below the minimum evidence.
    if (built.includedExampleIds.length < (p.minExamples ?? 3)) {
      return { type: 'abstain', reason: 'insufficient-history' };
    }
    const key = sha256(
      canonicalize({
        q: sha256(
          canonicalize({
            question: input.question,
            context: input.context ?? null,
            options: input.options,
            kind: input.kind,
            requirement: input.requirement,
            gate: input.workflow_gate_id ?? null,
            tags: input.project_tags ?? [],
            attachments: input.attachments ?? [],
          }),
        ),
        prompt: PROMPT_TEMPLATE_VERSION,
        adapter: this.adapter.id,
        history: this.history.version(),
        examples: built.includedExampleIds,
      }),
    );

    let reply: string;
    try {
      reply = await this.infer(key, built.prompt, signal);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError')
        return { type: 'abstain', reason: TERMINAL_REASONS.aborted };
      if (e instanceof BusyError) return { type: 'abstain', reason: TERMINAL_REASONS.busy };
      if (e instanceof AdapterTimeoutError)
        return { type: 'abstain', reason: TERMINAL_REASONS.timeout };
      return { type: 'abstain', reason: TERMINAL_REASONS.modelError };
    }

    if (this.history.version() !== historyVersion)
      return { type: 'abstain', reason: 'stale-history' };

    // 5. Strict validation: any violation is an abstention.
    const v = validateModelReply(reply, input, built.includedExampleIds);
    if (!v.ok) return { type: 'abstain', reason: v.reason };
    const d = v.decision;
    if (d.abstain)
      return { type: 'abstain', reason: `model-abstained: ${d.reason ?? 'no reason given'}` };
    if (d.risk_flags.some((f) => /inject/.test(f)))
      return { type: 'abstain', reason: 'prompt-injection-flagged' };

    for (const f of d.risk_flags) if (BLOCKING_RISK_FLAG.test(f)) blocks.push(`risk-flag:${f}`);
    const threshold = this.effectiveThreshold();
    if (threshold === null) blocks.push('suggestion-only');
    else if (d.confidence < threshold) blocks.push('below-threshold');

    return { type: 'decision', decision: d, blocks, referenceIds: built.includedExampleIds };
  }

  private async infer(
    key: string,
    prompt: ModelPrompt,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached); // refresh LRU position
      return cached;
    }
    let entry = this.inflight.get(key);
    if (!entry) {
      const ac = new AbortController();
      const e: Inflight = {
        ac,
        refs: 0,
        done: false,
        promise: undefined as unknown as Promise<string>,
      };
      e.promise = this.limiter
        .run(() => this.callWithRetry(prompt, ac.signal), ac.signal)
        .then((text) => {
          this.remember(key, text);
          return text;
        })
        .finally(() => {
          e.done = true;
          this.inflight.delete(key);
        });
      e.promise.catch(() => undefined); // avoid unhandled rejection if every caller detached
      this.inflight.set(key, e);
      entry = e;
    }
    entry.refs++;
    const held = entry;
    try {
      return await new Promise<string>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const onAbort = (): void => reject(abortError());
        signal?.addEventListener('abort', onAbort, { once: true });
        held.promise
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener('abort', onAbort));
      });
    } finally {
      held.refs--;
      // Cancel the shared call only when nobody is waiting for it any more.
      if (held.refs === 0 && !held.done && signal?.aborted) held.ac.abort();
    }
  }

  private remember(key: string, text: string): void {
    const max = this.policy.cacheSize ?? 200;
    this.cache.set(key, text);
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
  }

  private async callWithRetry(prompt: ModelPrompt, signal: AbortSignal): Promise<string> {
    const p = this.policy;
    const retries = p.retries ?? 1;
    const deadline = Date.now() + (p.timeoutMs ?? 60_000);
    for (let attempt = 0; ; attempt++) {
      try {
        return await withDeadline(
          (s) => this.adapter.suggest(prompt, s),
          deadline - Date.now(),
          signal,
        );
      } catch (e) {
        const retryable = e instanceof TransientAdapterError && attempt < retries;
        if (!retryable) throw e;
        await sleep((p.retryDelayMs ?? 250) * 2 ** attempt, signal);
        if (Date.now() >= deadline) throw new AdapterTimeoutError();
      }
    }
  }
}

export function createDecisionModel(opts: CreateDecisionModelOptions): DecisionModel {
  return new DecisionModel(opts);
}
