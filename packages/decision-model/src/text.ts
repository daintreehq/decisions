const STOPWORDS = new Set(
  (
    'a an and are as at be but by for from has have had how i if in into is it its of on or our that the their ' +
    'them then there these they this to us was we were what when where which who will with would you your should ' +
    'could can do does did not no so than too very just also about over under again more most other some such ' +
    'only own same up down out off any all both each few get got let make use used using want like need ok okay ' +
    'please yes being been am he she his her him its'
  ).split(' '),
);

/** Cheap suffix stripping. Deterministic and idempotent enough for lexical matching, not linguistic. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('sses')) return w.slice(0, -2);
  const suffixes = ['ingly', 'edly', 'ing', 'ed', 'ly', 'es', 's'];
  for (const s of suffixes) {
    if (w.length - s.length >= 3 && w.endsWith(s)) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  if (w.length > 3 && /(.)\1$/.test(w) && !/(ss|ll|ee|oo)$/.test(w)) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!raw) return out;
  for (const t of raw) {
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    const s = stem(t);
    if (s.length >= 2 && !STOPWORDS.has(s)) out.push(s);
  }
  return out;
}

export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
