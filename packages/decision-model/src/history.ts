import { z } from 'zod';
import { LIMITS } from '@daintreehq/decisions-protocol';
import { redactSecrets } from './redact.js';
import { tokenize } from './text.js';
import type { DecisionExample } from './types.js';

export type RecordResult =
  | {
      recorded: true;
      revision: number;
      /** The same label was already stored: nothing changed (idempotent re-ingestion). */
      duplicate?: true;
    }
  | {
      recorded: false;
      reason:
        | 'learning-disabled'
        | 'not-human'
        | 'project-opted-out'
        | 'invalid'
        | 'no-label'
        | 'older-than-existing'
        | 'stale-revision';
    };

export interface HistoryStore {
  /** Nothing is recorded unless the user has explicitly opted in. Defaults to false. */
  learningEnabled(): boolean;
  setLearningEnabled(enabled: boolean): void;
  setProjectOptOut(projectTag: string, optedOut: boolean): void;
  isProjectOptedOut(projectTag: string): boolean;
  optedOutProjects(): string[];
  /**
   * Record a human decision. Ordering of corrections: when the caller supplies `revision` (the question's ledger
   * revision after the human action) the higher revision wins, an equal revision is a duplicate (idempotent) or a
   * conflict (rejected), and wall-clock time is ignored, so clock skew cannot reorder corrections. Callers without
   * a revision fall back to `chosen_at`, where an equal timestamp can only be a duplicate.
   */
  record(example: DecisionExample): RecordResult;
  get(questionId: string): DecisionExample | undefined;
  all(): DecisionExample[];
  count(): number;
  /** Candidate examples for a query. Stores may prefilter (FTS5) but never return more than `limit` once prefiltering. */
  candidates(queryText: string, limit: number): DecisionExample[];
  forget(questionId: string): boolean;
  clear(): void;
  rebuildIndex(): void;
  /** Monotonic counter that changes on every mutation; used for cache invalidation. */
  version(): number;
  close?(): void;
}

const OptionZ = z.object({
  id: z.string().min(1).max(LIMITS.optionIdChars),
  label: z.string().max(LIMITS.optionLabelChars),
});
const LabelHistoryZ = z.object({
  selected_option_ids: z.array(z.string()).optional(),
  human_reasoning: z.string().optional(),
  chosen_at: z.string(),
  superseded_by_revision: z.number().int(),
});
export const DecisionExampleSchema = z.object({
  question_id: z.string().min(1).max(100),
  question: z.string().min(1).max(LIMITS.questionChars),
  context_summary: z.string().max(LIMITS.contextBytes).optional(),
  options: z.array(OptionZ).max(LIMITS.maxOptions).optional(),
  selected_option_ids: z
    .array(z.string().max(LIMITS.optionIdChars))
    .max(LIMITS.maxOptions)
    .optional(),
  human_reasoning: z.string().max(LIMITS.answerTextBytes).optional(),
  project_tags: z.array(z.string().max(100)).max(20).optional(),
  kind: z.enum(['choice', 'approval', 'text', 'mixed']).optional(),
  created_at: z.string().min(1),
  chosen_at: z.string().min(1),
  outcome: z.enum(['accepted', 'reversed', 'unknown']).optional(),
  policy_level: z.enum(['human-required', 'proxy-ok', 'proxy-first']),
  source: z.string(),
  revision: z.number().int().min(0).optional(),
  label_history: z.array(LabelHistoryZ).optional(),
  superseded_by_revision: z.number().int().optional(),
});

/** Redacts every free-text field of an example, including options and earlier labels in `label_history`. */
export function redactExample(ex: DecisionExample): DecisionExample {
  const out: DecisionExample = { ...ex, question: redactSecrets(ex.question) };
  if (ex.context_summary !== undefined) out.context_summary = redactSecrets(ex.context_summary);
  if (ex.human_reasoning !== undefined) out.human_reasoning = redactSecrets(ex.human_reasoning);
  if (ex.options) out.options = ex.options.map((o) => ({ ...o, label: redactSecrets(o.label) }));
  if (ex.label_history) {
    out.label_history = ex.label_history.map((l) => {
      const h = { ...l };
      if (l.human_reasoning !== undefined) h.human_reasoning = redactSecrets(l.human_reasoning);
      return h;
    });
  }
  return out;
}

function sanitize(ex: z.infer<typeof DecisionExampleSchema>): DecisionExample {
  const out: DecisionExample = {
    question_id: ex.question_id,
    question: ex.question,
    created_at: ex.created_at,
    chosen_at: ex.chosen_at,
    policy_level: ex.policy_level,
    source: 'human',
  };
  if (ex.context_summary !== undefined) out.context_summary = ex.context_summary;
  if (ex.options) out.options = ex.options.map((o) => ({ id: o.id, label: o.label }));
  if (ex.selected_option_ids) out.selected_option_ids = [...ex.selected_option_ids];
  if (ex.human_reasoning !== undefined) out.human_reasoning = ex.human_reasoning;
  if (ex.project_tags) out.project_tags = [...ex.project_tags];
  if (ex.kind) out.kind = ex.kind;
  if (ex.outcome) out.outcome = ex.outcome;
  if (ex.revision !== undefined) out.revision = ex.revision;
  if (ex.label_history) out.label_history = ex.label_history.map((l) => ({ ...l }));
  if (ex.superseded_by_revision !== undefined)
    out.superseded_by_revision = ex.superseded_by_revision;
  return redactExample(out);
}

/** Text that is tokenised for lexical matching. Mirrors what retrieval scores. */
export function indexText(ex: DecisionExample): string {
  return [
    ex.question,
    ex.context_summary ?? '',
    ...(ex.options ?? []).map((o) => o.label),
    ex.human_reasoning ?? '',
  ].join('\n');
}

/**
 * State and rules shared by the memory store here and the SQLite store in `history-sqlite.ts`.
 * `CommonState`, `prepare` and `redactExample` are internal: the package root does not export them.
 */
export interface CommonState {
  learning: boolean;
  optOut: Set<string>;
}

type Rejection = Extract<RecordResult, { recorded: false }>['reason'];
type Prepared =
  | { ok: true; example: DecisionExample; duplicate?: false }
  | { ok: true; duplicate: true; revision: number }
  | { ok: false; reason: Rejection };

const sameLabel = (a: DecisionExample, b: DecisionExample): boolean =>
  [...(a.selected_option_ids ?? [])].sort().join('\u0000') ===
    [...(b.selected_option_ids ?? [])].sort().join('\u0000') &&
  (a.human_reasoning ?? '') === (b.human_reasoning ?? '');

/**
 * Shared record rules. Returns the prepared example (already redacted and merged with any earlier label),
 * a duplicate marker, or a rejection. `existing` is the stored example with the same question id, if any.
 */
export function prepare(
  state: CommonState,
  input: DecisionExample,
  existing: DecisionExample | undefined,
): Prepared {
  if (!state.learning) return { ok: false, reason: 'learning-disabled' };
  if ((input as { source?: unknown }).source !== 'human') return { ok: false, reason: 'not-human' };
  const parsed = DecisionExampleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const ex = sanitize(parsed.data);
  if ((ex.project_tags ?? []).some((t) => state.optOut.has(t))) {
    return { ok: false, reason: 'project-opted-out' };
  }
  if (
    (ex.selected_option_ids?.length ?? 0) === 0 &&
    !(ex.human_reasoning && ex.human_reasoning.trim())
  ) {
    return { ok: false, reason: 'no-label' };
  }
  if (!existing) return { ok: true, example: { ...ex, revision: ex.revision ?? 0 } };

  const cur = existing.revision ?? 0;
  let nextRevision: number;
  if (input.revision !== undefined) {
    // Authoritative ordering: the ledger revision, never the wall clock.
    if (ex.revision! < cur) return { ok: false, reason: 'stale-revision' };
    if (ex.revision === cur) {
      return sameLabel(ex, existing)
        ? { ok: true, duplicate: true, revision: cur }
        : { ok: false, reason: 'stale-revision' };
    }
    nextRevision = ex.revision!;
  } else {
    const tIn = Date.parse(ex.chosen_at);
    const tEx = Date.parse(existing.chosen_at);
    if (tIn < tEx) return { ok: false, reason: 'older-than-existing' };
    if (tIn === tEx) {
      return sameLabel(ex, existing)
        ? { ok: true, duplicate: true, revision: cur }
        : { ok: false, reason: 'stale-revision' };
    }
    nextRevision = cur + 1;
  }

  const prev: NonNullable<DecisionExample['label_history']>[number] = {
    chosen_at: existing.chosen_at,
    superseded_by_revision: nextRevision,
  };
  if (existing.selected_option_ids) prev.selected_option_ids = existing.selected_option_ids;
  if (existing.human_reasoning !== undefined) prev.human_reasoning = existing.human_reasoning;
  return {
    ok: true,
    example: {
      ...ex,
      revision: nextRevision,
      label_history: [...(existing.label_history ?? []), prev],
    },
  };
}

export class MemoryHistoryStore implements HistoryStore {
  private readonly items = new Map<string, DecisionExample>();
  private readonly state: CommonState;
  private ver = 0;

  constructor(opts: { learningEnabled?: boolean } = {}) {
    this.state = { learning: opts.learningEnabled === true, optOut: new Set() };
  }
  learningEnabled(): boolean {
    return this.state.learning;
  }
  setLearningEnabled(enabled: boolean): void {
    this.state.learning = enabled;
    this.ver++;
  }
  setProjectOptOut(tag: string, optedOut: boolean): void {
    if (optedOut) {
      this.state.optOut.add(tag);
      // Opting a project out also removes what was already learned from it.
      for (const [id, ex] of this.items) if (ex.project_tags?.includes(tag)) this.items.delete(id);
    } else this.state.optOut.delete(tag);
    this.ver++;
  }
  isProjectOptedOut(tag: string): boolean {
    return this.state.optOut.has(tag);
  }
  optedOutProjects(): string[] {
    return [...this.state.optOut].sort();
  }
  record(example: DecisionExample): RecordResult {
    const r = prepare(this.state, example, this.items.get(example.question_id));
    if (!r.ok) return { recorded: false, reason: r.reason };
    if (r.duplicate) return { recorded: true, revision: r.revision, duplicate: true };
    this.items.set(r.example.question_id, r.example);
    this.ver++;
    return { recorded: true, revision: r.example.revision ?? 0 };
  }
  get(id: string): DecisionExample | undefined {
    const e = this.items.get(id);
    return e ? structuredClone(e) : undefined;
  }
  all(): DecisionExample[] {
    return [...this.items.values()].map((e) => structuredClone(e));
  }
  count(): number {
    return this.items.size;
  }
  candidates(): DecisionExample[] {
    return this.all();
  }
  forget(id: string): boolean {
    const had = this.items.delete(id);
    if (had) this.ver++;
    return had;
  }
  clear(): void {
    this.items.clear();
    this.ver++;
  }
  rebuildIndex(): void {
    // Nothing is persisted separately for the in-JS index; re-run redaction defensively.
    for (const [id, ex] of this.items) this.items.set(id, redactExample(ex));
    this.ver++;
  }
  version(): number {
    return this.ver;
  }
}
