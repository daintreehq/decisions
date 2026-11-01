import { CorrectionResult, PROTOCOL_VERSION } from '@daintree/decisions-protocol';

/**
 * Whole-passage AI clean-up of a dictated answer. The contract mirrors Daintree desktop dictation:
 * strict schema, any doubt keeps the raw text, unsure words are flagged rather than guessed.
 *
 * OFFSET CONVENTION: `uncertain_spans[].start/end` are UTF-16 code-unit offsets (JavaScript string indices,
 * end exclusive) into `corrected_text`, and `corrected_text.slice(start, end)` is the model's current choice.
 */

export type KeptRawReason =
  'timeout' | 'provider-error' | 'malformed' | 'editor-changed' | 'drift' | 'unavailable';

export type CorrectionOutcome =
  | {
      kind: 'applied';
      result: CorrectionResult;
      model: string;
      spans: Span[];
      /**
       * True only for conservative changes (token order and negation placement preserved). Anything else is a
       * suggestion the human must accept explicitly; it is never written over what they dictated on its own.
       */
      autoApply: boolean;
      reviewReason?: string;
    }
  | { kind: 'kept-raw'; reason: KeptRawReason; detail?: string };

export interface Span {
  start: number;
  end: number;
  raw: string;
  candidate: string;
  reason: string;
}

const POLARITY_WORDS = new Set([
  'yes',
  'no',
  'nope',
  'not',
  'never',
  'approve',
  'approved',
  'approves',
  'reject',
  'rejected',
  'rejects',
  'without',
  'dont',
  'cant',
  'wont',
  'cannot',
]);

function normalizeForPolarity(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\bcan't\b/g, 'can not')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/\bcannot\b/g, 'can not')
    .replace(/n't\b/g, ' not');
}

export function polarityCounts(s: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const w of normalizeForPolarity(s).match(/[a-z]+/g) ?? []) {
    if (POLARITY_WORDS.has(w)) counts[w] = (counts[w] ?? 0) + 1;
  }
  return counts;
}

const TOKEN = /[A-Za-z0-9_][A-Za-z0-9_./:\\-]*/g;

function tokens(s: string): string[] {
  return (s.match(TOKEN) ?? []).map((t) => t.replace(/[.:\\/-]+$/, ''));
}

function identifierLike(t: string): boolean {
  return /\d/.test(t) || /[_./:\\]/.test(t) || /[a-z][A-Z]/.test(t);
}

/** Returns a reason when the corrected text drifted from what was actually said; null when it is safe. */
export function detectDrift(
  raw: string,
  corrected: string,
  keyterms: readonly string[],
): string | null {
  const rawTrim = raw.trim();
  if (rawTrim.length === 0) return 'nothing was dictated';
  const ratio = corrected.trim().length / rawTrim.length;
  if (ratio < 0.5 || ratio > 2.0) return 'length changed too much';

  const a = polarityCounts(raw);
  const b = polarityCounts(corrected);
  for (const w of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[w] ?? 0) !== (b[w] ?? 0)) return `polarity word "${w}" changed`;
  }

  const known = new Set<string>();
  for (const t of tokens(raw)) known.add(t.toLowerCase());
  for (const k of keyterms) {
    known.add(k.toLowerCase());
    for (const t of tokens(k)) known.add(t.toLowerCase());
  }
  for (const t of tokens(corrected)) {
    if (identifierLike(t) && !known.has(t.toLowerCase())) return `new identifier or number "${t}"`;
  }
  return null;
}

function wordTokens(s: string): string[] {
  return normalizeForPolarity(s).match(/[a-z0-9]+/g) ?? [];
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

export interface ChangeClass {
  auto: boolean;
  reason?: string;
}

/**
 * Decides whether a corrected passage may replace the dictated text without the human looking at it.
 * Only conservative edits qualify: most words stay in the same order, and every polarity word (not, no,
 * never, approve, reject, ...) keeps the same neighbours, so a negation cannot migrate to a different clause.
 * Everything else is offered as a suggestion that needs an explicit Accept.
 */
export function classifyChange(raw: string, corrected: string): ChangeClass {
  const a = wordTokens(raw);
  const b = wordTokens(corrected);
  if (a.length > 2000 || b.length > 2000)
    return { auto: false, reason: 'too long to check automatically' };
  const pa = a.flatMap((t, i) => (POLARITY_WORDS.has(t) ? [i] : []));
  const pb = b.flatMap((t, i) => (POLARITY_WORDS.has(t) ? [i] : []));
  if (pa.length !== pb.length || pa.some((ia, k) => a[ia] !== b[pb[k]!])) {
    return { auto: false, reason: 'a yes/no/negation word changed' };
  }
  for (let k = 0; k < pa.length; k++) {
    for (const off of [-1, 1, 2]) {
      if (a[pa[k]! + off] !== b[pb[k]! + off]) {
        return { auto: false, reason: `the words around "${a[pa[k]!]}" changed` };
      }
    }
  }
  const longest = Math.max(a.length, b.length);
  if (longest > 0 && lcsLength(a, b) < 0.85 * longest)
    return { auto: false, reason: 'the wording or order changed a lot' };
  return { auto: true };
}

/** Keep only well-formed, non-overlapping spans that do not split a surrogate pair. */
export function validSpans(text: string, spans: readonly Span[]): Span[] {
  const ok = spans.filter((s) => {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) return false;
    if (s.start < 0 || s.end <= s.start || s.end > text.length) return false;
    const lead = text.charCodeAt(s.start);
    const last = text.charCodeAt(s.end - 1);
    if (lead >= 0xdc00 && lead <= 0xdfff) return false; // starts mid-pair
    if (last >= 0xd800 && last <= 0xdbff) return false; // ends mid-pair
    return true;
  });
  ok.sort((x, y) => x.start - y.start);
  const out: Span[] = [];
  for (const s of ok) if (!out.length || s.start >= out[out.length - 1]!.end) out.push(s);
  return out;
}

export type SpanChoice = 'corrected' | 'raw' | 'candidate';

/** Replace span `index` with the user's choice, shifting the remaining spans; the resolved span disappears. */
export function resolveSpan(
  text: string,
  spans: readonly Span[],
  index: number,
  choice: SpanChoice,
): { text: string; spans: Span[] } {
  const s = spans[index];
  if (!s) return { text, spans: [...spans] };
  const replacement =
    choice === 'raw' ? s.raw : choice === 'candidate' ? s.candidate : text.slice(s.start, s.end);
  const delta = replacement.length - (s.end - s.start);
  const next = text.slice(0, s.start) + replacement + text.slice(s.end);
  const rest = spans
    .filter((_, i) => i !== index)
    .map((x) => (x.start >= s.end ? { ...x, start: x.start + delta, end: x.end + delta } : x));
  return { text: next, spans: rest };
}

export interface DictationRegion {
  start: number;
  end: number;
  raw: string;
}

/**
 * Replace the dictated region with the corrected passage only if the region is still byte-for-byte what
 * was inserted. Returns null (keep everything as is) when the user edited it in the meantime.
 */
export function applyToRegion(
  editorText: string,
  region: DictationRegion,
  corrected: string,
): { text: string; region: DictationRegion } | null {
  if (editorText.slice(region.start, region.end) !== region.raw) return null;
  const text = editorText.slice(0, region.start) + corrected + editorText.slice(region.end);
  return {
    text,
    region: { start: region.start, end: region.start + corrected.length, raw: corrected },
  };
}

export interface CorrectionRequest {
  post: (path: string, body: unknown, signal: AbortSignal) => Promise<Response>;
  provider: 'anthropic' | 'openai';
  raw: string;
  question: string;
  optionLabels: string[];
  keyterms: string[];
  /** Editor text when the request started and a way to read it now. */
  editorAtStart: string;
  getEditorText: () => string;
  timeoutMs?: number;
}

const TIMED_OUT = Symbol('timed out');

export async function runCorrection(r: CorrectionRequest): Promise<CorrectionOutcome> {
  const ctl = new AbortController();
  const ms = r.timeoutMs ?? 8000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The deadline is enforced here, independently of whether the request honours its abort signal.
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve(TIMED_OUT);
    }, ms);
  });
  const within = <T>(p: Promise<T>) => Promise.race([p, deadline]);
  try {
    let res: Response | typeof TIMED_OUT;
    try {
      res = await within(
        r.post(
          '/voice/correct',
          {
            protocol_version: PROTOCOL_VERSION,
            provider: r.provider,
            consent: true,
            raw_transcript: r.raw,
            question: r.question,
            option_labels: r.optionLabels,
            keyterms: r.keyterms,
          },
          ctl.signal,
        ),
      );
    } catch {
      return { kind: 'kept-raw', reason: ctl.signal.aborted ? 'timeout' : 'unavailable' };
    }
    if (res === TIMED_OUT || ctl.signal.aborted) return { kind: 'kept-raw', reason: 'timeout' };
    if (!res.ok) return { kind: 'kept-raw', reason: 'provider-error' };
    let body: { result?: unknown; model?: unknown } | typeof TIMED_OUT;
    try {
      body = await within(res.json() as Promise<{ result?: unknown; model?: unknown }>);
    } catch {
      return { kind: 'kept-raw', reason: ctl.signal.aborted ? 'timeout' : 'malformed' };
    }
    // A result that arrives after the deadline is discarded, even if it is perfectly good.
    if (body === TIMED_OUT || ctl.signal.aborted) return { kind: 'kept-raw', reason: 'timeout' };
    const parsed = CorrectionResult.safeParse(body.result);
    if (!parsed.success) return { kind: 'kept-raw', reason: 'malformed' };
    if (r.getEditorText() !== r.editorAtStart)
      return { kind: 'kept-raw', reason: 'editor-changed' };
    const drift = detectDrift(r.raw, parsed.data.corrected_text, r.keyterms);
    if (drift) return { kind: 'kept-raw', reason: 'drift', detail: drift };
    const change = classifyChange(r.raw, parsed.data.corrected_text);
    return {
      kind: 'applied',
      result: parsed.data,
      model: typeof body.model === 'string' ? body.model : 'unknown',
      spans: validSpans(parsed.data.corrected_text, parsed.data.uncertain_spans),
      autoApply: change.auto,
      ...(change.reason ? { reviewReason: change.reason } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Keyterms: option labels plus distinctive words from the question, <=100 terms of <=50 chars. */
export function buildKeyterms(
  question: string,
  optionLabels: readonly string[],
  extra: readonly string[] = [],
): string[] {
  const out = new Set<string>();
  const add = (t: string) => {
    const x = t.trim();
    if (x.length >= 2 && x.length <= 50) out.add(x);
  };
  for (const l of optionLabels) add(l);
  for (const e of extra) add(e);
  const STOP = new Set([
    'the',
    'and',
    'for',
    'with',
    'that',
    'this',
    'should',
    'would',
    'could',
    'which',
    'what',
    'when',
    'from',
    'have',
    'does',
    'into',
    'your',
    'about',
  ]);
  for (const w of question.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? []) {
    if (STOP.has(w.toLowerCase())) continue;
    if (/[A-Z0-9_.]/.test(w.slice(1)) || w.length >= 6) add(w);
  }
  return [...out].slice(0, 100);
}
