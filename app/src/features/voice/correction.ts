import {
  CorrectionResult,
  LIMITS,
  PROTOCOL_VERSION,
  voiceCleanupTimeoutMs,
} from '@daintreehq/decisions-protocol';

/**
 * Whole-passage AI clean-up of a dictated answer, as Daintree desktop dictation does it: one request after the
 * person stops, strict schema, and the clean-up lands as written. There is no meaning guard; the person reads the
 * cleaned text in the editor, can go back to exactly what they said in one tap, and nothing is sent until they
 * press Submit. Any failure keeps the raw text.
 *
 * OFFSET CONVENTION: `uncertain_spans[].start/end` are UTF-16 code-unit offsets (JavaScript string indices,
 * end exclusive) into `corrected_text`, and `corrected_text.slice(start, end)` is the model's current choice.
 */

export type KeptRawReason =
  'timeout' | 'provider-error' | 'malformed' | 'editor-changed' | 'unavailable';

export type CorrectionOutcome =
  | {
      kind: 'applied';
      result: CorrectionResult;
      model: string;
      spans: Span[];
      /** False when the clean-up found nothing to change. */
      changed: boolean;
      /** The model said at least one edit was a guess. */
      lowConfidence: boolean;
    }
  | { kind: 'kept-raw'; reason: KeptRawReason };

export interface Span {
  start: number;
  end: number;
  raw: string;
  candidate: string;
  reason: string;
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
  context?: string;
  options: { label: string; description?: string }[];
  askedAt?: string;
  projectLabel?: string;
  /** The answer text before the dictated passage (see `precedingText`). */
  precedingText?: string;
  transcriber?: 'xai' | 'openai';
  language?: string;
  /** Editor text when the request started and a way to read it now. */
  editorAtStart: string;
  getEditorText: () => string;
  timeoutMs?: number;
}

const TIMED_OUT = Symbol('timed out');
// The Worker gives up at its own deadline; the phone waits a little longer so a slow network is not a timeout.
const NETWORK_SLACK_MS = 3000;

export async function runCorrection(r: CorrectionRequest): Promise<CorrectionOutcome> {
  const ctl = new AbortController();
  const ms = r.timeoutMs ?? voiceCleanupTimeoutMs(r.raw.length, true) + NETWORK_SLACK_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The deadline is enforced here, independently of whether the request honours its abort signal.
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve(TIMED_OUT);
    }, ms);
  });
  const within = <T>(p: Promise<T>) => Promise.race([p, deadline]);
  const context = r.context?.trim();
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
            // The clean-up keeps only the newest part of a long context, so only that leaves the phone.
            ...(context ? { context: context.slice(-LIMITS.voiceCleanupContextChars) } : {}),
            options: r.options.map((o) => ({
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
            ...(r.askedAt ? { asked_at: r.askedAt } : {}),
            ...(r.projectLabel ? { project_label: r.projectLabel } : {}),
            ...(r.precedingText ? { preceding_text: r.precedingText } : {}),
            ...(r.transcriber ? { transcriber: r.transcriber } : {}),
            ...(r.language ? { language: r.language } : {}),
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
    return {
      kind: 'applied',
      result: parsed.data,
      model: typeof body.model === 'string' ? body.model : 'unknown',
      spans: validSpans(parsed.data.corrected_text, parsed.data.uncertain_spans),
      changed: parsed.data.corrected_text !== r.raw,
      lowConfidence: parsed.data.warnings.includes('low-confidence'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Daintree sends up to this much of the draft before a passage as its <confirmed_history>.
const PRECEDING_CHARS = LIMITS.voiceCleanupPrecedingChars;

/**
 * The answer text before position `from`, bounded, as Daintree's cleanup is given it: so a dictation that
 * carries on a typed sentence is not recased as if it stood alone. Empty when nothing but space comes before.
 */
export function precedingText(draft: string, from: number): string {
  const start = Math.max(0, from - PRECEDING_CHARS);
  let context = draft.slice(start, from);
  // Drop the word the bound cut through, if it cut one.
  if (start > 0 && /\S/.test(draft.charAt(start - 1))) context = context.replace(/^\S+/, '');
  // A trailing newline says the dictation starts a new line, so it stays.
  context = context.trimStart().replace(/[^\S\n]+$/, '');
  return context.trim() ? context : '';
}

/**
 * The language dictation is transcribed and cleaned up in. Daintree defaults to English; the phone does too when
 * its own language is English, and otherwise lets the provider detect it rather than guess.
 */
export function dictationLanguage(
  locale: string | undefined = globalThis.navigator?.language,
): string | undefined {
  return locale?.toLowerCase().split('-')[0] === 'en' ? 'en' : undefined;
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
