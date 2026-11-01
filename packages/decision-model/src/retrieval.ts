import type { HistoryStore } from './history.js';
import { indexText } from './history.js';
import { normalizeLabel, tokenize } from './text.js';
import type { DecisionExample, ProxyQuestionInput } from './types.js';

export interface RetrievalOptions {
  /** Examples to return before contradiction augmentation. Clamped to 1..12 (default 8). */
  limit?: number;
  now?: Date;
  recencyHalfLifeDays?: number;
  /** Max candidates pulled from the store when it prefilters (FTS5). */
  candidateLimit?: number;
  weights?: Partial<{ bm25: number; recency: number; tags: number; options: number }>;
  /** Min normalised BM25 for an example to count as relevant evidence. */
  minRelevance?: number;
}

export interface RetrievedExample {
  example: DecisionExample;
  score: number;
  bm25: number;
  /** BM25 divided by the best BM25 among candidates (0..1). */
  relevance: number;
  recency: number;
  tagOverlap: number;
  optionSimilarity: number;
  contradiction: boolean;
}

export interface Contradiction {
  a: string;
  b: string;
  shared_options: string[];
}

export interface RetrievalResult {
  examples: RetrievedExample[];
  contradictions: Contradiction[];
  /** True when top, option-overlapping examples disagree. */
  contradictory: boolean;
  referenceIds: string[];
}

const DEFAULT_WEIGHTS = { bm25: 0.65, recency: 0.1, tags: 0.15, options: 0.1 };
const MAX_EXAMPLES = 12;
const K1 = 1.2;
const B = 0.75;

function optionKeys(options: { id: string; label: string }[] | undefined): Set<string> {
  const s = new Set<string>();
  for (const o of options ?? []) {
    const k = normalizeLabel(o.label) || normalizeLabel(o.id);
    if (k) s.add(k);
  }
  return s;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Human-readable answer key of an example: selected option labels (or ids), sorted. */
export function answerKey(ex: DecisionExample): string | null {
  const ids = ex.selected_option_ids ?? [];
  if (ids.length === 0) return null;
  const byId = new Map((ex.options ?? []).map((o) => [o.id, o.label]));
  return ids
    .map((id) => normalizeLabel(byId.get(id) ?? id))
    .sort()
    .join('|');
}

export function queryTextFor(input: ProxyQuestionInput): string {
  return [input.question, input.context ?? '', ...input.options.map((o) => o.label)].join('\n');
}

export function retrieve(
  history: HistoryStore,
  input: ProxyQuestionInput,
  opts: RetrievalOptions = {},
): RetrievalResult {
  const limit = Math.min(MAX_EXAMPLES, Math.max(1, Math.floor(opts.limit ?? 8)));
  const w = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const now = (opts.now ?? new Date()).getTime();
  const halfLifeMs = (opts.recencyHalfLifeDays ?? 180) * 86_400_000;
  const minRelevance = opts.minRelevance ?? 0.15;

  const queryText = queryTextFor(input);
  const qTerms = [...new Set(tokenize(queryText))];
  const docs = history
    .candidates(queryText, opts.candidateLimit ?? 200)
    .filter((e) => e.question_id !== input.question_id);
  if (docs.length === 0 || qTerms.length === 0) {
    return { examples: [], contradictions: [], contradictory: false, referenceIds: [] };
  }

  const tokenized = docs.map((d) => tokenize(indexText(d)));
  const avgLen = tokenized.reduce((n, t) => n + t.length, 0) / tokenized.length || 1;
  const df = new Map<string, number>();
  for (const toks of tokenized) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;

  const raw = docs.map((ex, i) => {
    const toks = tokenized[i]!;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let bm25 = 0;
    for (const term of qTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      bm25 += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * toks.length) / avgLen));
    }
    return { ex, bm25 };
  });
  const maxBm25 = Math.max(...raw.map((r) => r.bm25));
  if (!(maxBm25 > 0))
    return { examples: [], contradictions: [], contradictory: false, referenceIds: [] };

  const inputKeys = optionKeys(input.options);
  const inputTags = new Set(input.project_tags ?? []);

  const scored: RetrievedExample[] = raw
    .filter((r) => r.bm25 > 0)
    .map(({ ex, bm25 }) => {
      const relevance = bm25 / maxBm25;
      const ageMs = Math.max(0, now - Date.parse(ex.chosen_at));
      const recency = Number.isFinite(ageMs) ? Math.exp((-Math.LN2 * ageMs) / halfLifeMs) : 0;
      const exTags = ex.project_tags ?? [];
      const tagOverlap =
        inputTags.size === 0 || exTags.length === 0
          ? 0
          : exTags.filter((t) => inputTags.has(t)).length / Math.max(inputTags.size, exTags.length);
      const optionSimilarity = jaccard(inputKeys, optionKeys(ex.options));
      const score =
        w.bm25 * relevance +
        w.recency * recency +
        w.tags * tagOverlap +
        w.options * optionSimilarity;
      return {
        example: ex,
        score,
        bm25,
        relevance,
        recency,
        tagOverlap,
        optionSimilarity,
        contradiction: false,
      };
    })
    .filter((s) => s.relevance >= minRelevance)
    .sort((a, b) => b.score - a.score || b.example.chosen_at.localeCompare(a.example.chosen_at));

  const chosen = scored.slice(0, limit);
  const top1Key = chosen[0] ? answerKey(chosen[0].example) : null;

  // Contradictory evidence must never be crowded out by agreeing examples, including when the cap is full:
  // find up to two qualifying dissenters across ALL scored candidates, then make room for them by dropping the
  // lowest-ranked agreeing examples (never the top hit).
  if (top1Key) {
    const dissenters = scored
      .filter((s) => {
        const k = answerKey(s.example);
        return !!k && k !== top1Key && s.optionSimilarity >= 0.5 && s.relevance >= 0.25;
      })
      .slice(0, 2);
    const dissenterIds = new Set(dissenters.map((d) => d.example.question_id));
    const have = new Set(chosen.map((c) => c.example.question_id));
    const missing = dissenters.filter((d) => !have.has(d.example.question_id));
    while (chosen.length + missing.length > MAX_EXAMPLES) {
      let drop = -1;
      for (let i = chosen.length - 1; i > 0; i--) {
        if (!dissenterIds.has(chosen[i]!.example.question_id)) {
          drop = i;
          break;
        }
      }
      if (drop < 1) break;
      chosen.splice(drop, 1);
    }
    chosen.push(...missing);
  }

  const contradictions: Contradiction[] = [];
  let contradictory = false;
  for (let i = 0; i < chosen.length; i++) {
    for (let j = i + 1; j < chosen.length; j++) {
      const a = chosen[i]!;
      const b = chosen[j]!;
      if (
        a.optionSimilarity < 0.5 ||
        b.optionSimilarity < 0.5 ||
        a.relevance < 0.25 ||
        b.relevance < 0.25
      )
        continue;
      const ka = answerKey(a.example);
      const kb = answerKey(b.example);
      if (!ka || !kb || ka === kb) continue;
      const shared = [...optionKeys(a.example.options)].filter((k) =>
        optionKeys(b.example.options).has(k),
      );
      if (shared.length === 0) continue;
      a.contradiction = true;
      b.contradiction = true;
      contradictions.push({
        a: a.example.question_id,
        b: b.example.question_id,
        shared_options: shared.sort(),
      });
      if (i < 3 || j < 3) contradictory = true;
    }
  }

  return {
    examples: chosen,
    contradictions,
    contradictory,
    referenceIds: chosen.map((c) => c.example.question_id),
  };
}
