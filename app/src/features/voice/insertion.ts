/**
 * Text plumbing for dictation, ported from Daintree so the two apps write dictated words the same way:
 * caret insertion with Daintree's spacing (`voiceInsertion.ts`), the spoken "new line" / "new paragraph" commands
 * (`voiceDictationCommands.ts`) and the word diff behind the correction underline (`correctionReview.ts`).
 */

export interface Span {
  from: number;
  to: number;
}

// Text that hugs the word before it, so dictation landing just ahead of it gets no space of its own.
const HUGS_PREVIOUS = /^[\s.,;:!?)\]}]/;
const OPENS = /[([{]$/;

export interface InsertPlan {
  next: string;
  /** The words alone, in the new text. */
  words: Span;
  /** Where the next words of the same passage go. */
  anchor: Span;
}

/**
 * Plans dictated words into `draft` at `anchor`, replacing the selection it holds. A space goes before the words
 * when they would otherwise run into the previous word, and after them when they would run into the next one; the
 * trailing space stays outside the passage so the next utterance lands right after these words.
 */
export function planVoiceWords(draft: string, anchor: Span, text: string): InsertPlan {
  const to = Math.min(Math.max(anchor.to, 0), draft.length);
  const from = Math.min(Math.max(anchor.from, 0), to);
  const before = draft.slice(0, from);
  const after = draft.slice(to);
  const leading =
    before && !/\s$/.test(before) && !OPENS.test(before) && !HUGS_PREVIOUS.test(text) ? ' ' : '';
  const trailing = after && !HUGS_PREVIOUS.test(after) ? ' ' : '';
  const wordsFrom = from + leading.length;
  const wordsTo = wordsFrom + text.length;
  return {
    next: before + leading + text + trailing + after,
    words: { from: wordsFrom, to: wordsTo },
    anchor: { from: wordsTo, to: wordsTo },
  };
}

/** A line break at the anchor; a selection no words have replaced yet survives it. */
export function planVoiceBreak(draft: string, anchor: Span): InsertPlan {
  const to = Math.min(Math.max(anchor.to, 0), draft.length);
  const from = Math.min(Math.max(anchor.from, 0), to);
  // A break eats the separator space the previous words left, so the new line does not start with one.
  const trimmed = draft.slice(0, from).replace(/ +$/, '');
  const next = trimmed + '\n' + draft.slice(from);
  const at = trimmed.length;
  return {
    next,
    words: { from: at, to: at + 1 },
    anchor: { from: at + 1, to: at + 1 + (to - from) },
  };
}

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['new paragraph', '\n\n'],
  ['new line', '\n'],
];
const ALTERNATION = COMMANDS.map(([p]) => p.replace(/\s+/g, '\\s+')).join('|');
const PUNCT = '[\\s.,;:!?]';
const TRAILING_CHAIN = new RegExp(
  `\\s*\\b((?:${ALTERNATION})(?:${PUNCT}+(?:${ALTERNATION}))*)${PUNCT}*$`,
  'i',
);
const SINGLE = new RegExp(`(?:${ALTERNATION})`, 'gi');

/**
 * Splits a finished utterance into its words and the line breaks spoken at its end. Only a trailing chain counts,
 * so "I'll add a new paragraph here" stays literal. No spoken command ever sends, selects or deletes anything.
 */
export function splitDictationCommands(text: string): { words: string; breaks: number } {
  const m = TRAILING_CHAIN.exec(text);
  if (!m) return { words: text, breaks: 0 };
  const phrases = m[1]!.match(SINGLE) ?? [];
  let breaks = 0;
  for (const p of phrases) {
    const key = p.replace(/\s+/g, ' ').toLowerCase();
    breaks += COMMANDS.find(([c]) => c === key)?.[1].length ?? 0;
  }
  return { words: text.slice(0, m.index).trimEnd(), breaks };
}

/**
 * Where `pos` in `old` lands in `next`, for an edit found as one changed run between a common head and tail.
 * A position inside the changed run moves to its end (`assoc` 1) or start (-1).
 */
export function mapThroughEdit(old: string, next: string, pos: number, assoc: 1 | -1 = 1): number {
  if (old === next) return pos;
  let head = 0;
  const min = Math.min(old.length, next.length);
  while (head < min && old.charCodeAt(head) === next.charCodeAt(head)) head++;
  let tail = 0;
  while (
    tail < min - head &&
    old.charCodeAt(old.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
  )
    tail++;
  if (pos <= head) return pos;
  if (pos >= old.length - tail) return pos + (next.length - old.length);
  return assoc === 1 ? next.length - tail : head;
}

/* ---------- the correction review's word diff (Daintree's diffCorrection) ---------- */

interface Word {
  text: string;
  from: number;
  to: number;
  core: string;
  key: string;
}

const LEADING_PUNCTUATION = /^["“«…—–]+/u;
const TRAILING_PUNCTUATION = /["”».,;:!?…—–]+$/u;
const SENTENCE_END = /[.!?…][)\]}"'”’»]*$/u;
const ONLY_PUNCTUATION = /^\p{P}+$/u;
const PRONOUN_I = /^I(?:'(?:m|ll|ve|d))?$/;
const LONE_CAPITAL = /^\p{Lu}(?=[^\p{Lu}]*$)/u;

function diffWords(text: string): Word[] {
  const words: Word[] = [];
  let opens = true;
  let prevTo = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const from = m.index;
    const to = from + m[0].length;
    if (text.slice(prevTo, from).includes('\n')) opens = true;
    prevTo = to;
    const core = m[0]
      .replaceAll('’', "'")
      .replace(LEADING_PUNCTUATION, '')
      .replace(TRAILING_PUNCTUATION, '');
    if (!ONLY_PUNCTUATION.test(core) && core !== '') {
      const folds = opens || PRONOUN_I.test(core);
      words.push({
        text: m[0],
        from,
        to,
        core,
        key: folds ? core.replace(LONE_CAPITAL, (c) => c.toLowerCase()) : core,
      });
      opens = false;
    }
    if (SENTENCE_END.test(m[0])) opens = true;
  }
  return words;
}

const sameWord = (x: Word, y: Word) => x.core === y.core || x.key === y.key;
const MAX_CELLS = 250_000;

function alignWords(a: readonly Word[], b: readonly Word[]): [number, number][] {
  let head = 0;
  while (head < a.length && head < b.length && sameWord(a[head]!, b[head]!)) head++;
  let endA = a.length;
  let endB = b.length;
  while (endA > head && endB > head && sameWord(a[endA - 1]!, b[endB - 1]!)) {
    endA--;
    endB--;
  }
  const kept: [number, number][] = [];
  for (let i = 0; i < head; i++) kept.push([i, i]);
  const m = endA - head;
  const n = endB - head;
  if (m > 0 && n > 0 && m * n <= MAX_CELLS) {
    const w = n + 1;
    const lcs = new Uint32Array((m + 1) * w);
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        lcs[i * w + j] = sameWord(a[head + i]!, b[head + j]!)
          ? lcs[(i + 1) * w + j + 1]! + 1
          : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (sameWord(a[head + i]!, b[head + j]!)) {
        kept.push([head + i, head + j]);
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; endA + k < a.length; k++) kept.push([endA + k, endB + k]);
  return kept;
}

/** A run of words the cleanup wrote, as offsets into the cleaned text, with what was heard there. */
export interface ChangedRun {
  from: number;
  to: number;
  heard: string;
}

/**
 * The words a cleanup changed. Punctuation and a sentence's capital that the cleanup added land quietly; a change to
 * the word itself counts. Removed words with nothing written in their place are not marked (there is nothing to
 * underline), as in Daintree's review they are a separate, quieter mark.
 */
export function diffCorrection(raw: string, cleaned: string): ChangedRun[] {
  const a = diffWords(raw);
  const b = diffWords(cleaned);
  const kept: [number, number][] = [[-1, -1], ...alignWords(a, b), [a.length, b.length]];
  const out: ChangedRun[] = [];
  for (let k = 0; k < kept.length - 1; k++) {
    const [pa, pb] = kept[k]!;
    const [na, nb] = kept[k + 1]!;
    if (nb - pb > 1) {
      const heard = na - pa > 1 ? raw.slice(a[pa + 1]!.from, a[na - 1]!.to) : '';
      out.push({ from: b[pb + 1]!.from, to: b[nb - 1]!.to, heard });
    }
  }
  return out;
}
