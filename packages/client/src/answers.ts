/**
 * One locally stored answer for a question: delivery bookkeeping in clear, content sealed.
 *
 * What the human (or proxy) actually said (the choices, the text, the reviewed image digests, the model's
 * confidence) is never stored in clear: it lives in `sealed`, encrypted under the identity's epoch key (see
 * `at-rest.ts`), and is opened in memory only when it has to be typed, shown or exported.
 */
export interface AnswerEntry {
  entry_id: string;
  kind: 'answer' | 'expired';
  action: 'answer' | 'override' | 'proxy-answer' | 'confirm-proxy' | 'expire';
  revision: number;
  source: 'human' | 'proxy' | 'system';
  /** Replaces an earlier answer. */
  correction: boolean;
  created_at: string;
  /** Needs to be typed into the terminal. */
  deliver: boolean;
  delivered: boolean;
  injection_id?: string;
  /** The sealed `AnswerContent`, or null for an entry that carries none (an expiry notice). */
  sealed: string | null;
}

/** The content of an answer. Held in memory only; at rest it is sealed into `AnswerEntry.sealed`. */
export interface AnswerContent {
  choices: { id: string; label?: string }[];
  text: string;
  reviewed_attachment_digests: string[];
  confidence?: number;
  model_id?: string;
}

/** An answer with its content opened. Never stored. */
export type OpenAnswerEntry = Omit<AnswerEntry, 'sealed'> & AnswerContent;

export const EMPTY_ANSWER_CONTENT: AnswerContent = Object.freeze({
  choices: [],
  text: '',
  reviewed_attachment_digests: [],
}) as AnswerContent;

/** The content fields an entry written before sealing existed carried in clear. */
export const ANSWER_CONTENT_FIELDS = [
  'choices',
  'text',
  'reviewed_attachment_digests',
  'confidence',
  'model_id',
] as const;

/** True for an entry from a store written before content was sealed: its content is still in clear. */
export function hasLegacyContent(e: AnswerEntry): boolean {
  const r = e as unknown as Record<string, unknown>;
  return ANSWER_CONTENT_FIELDS.some((k) => r[k] !== undefined);
}

/** The clear-text content of a legacy entry (empty when it has none). */
export function legacyContent(e: AnswerEntry): AnswerContent {
  const r = e as unknown as Partial<AnswerContent>;
  return {
    choices: Array.isArray(r.choices) ? r.choices : [],
    text: typeof r.text === 'string' ? r.text : '',
    reviewed_attachment_digests: Array.isArray(r.reviewed_attachment_digests)
      ? r.reviewed_attachment_digests
      : [],
    ...(typeof r.confidence === 'number' ? { confidence: r.confidence } : {}),
    ...(typeof r.model_id === 'string' && r.model_id ? { model_id: r.model_id } : {}),
  };
}

export function parseAnswers(json: string): AnswerEntry[] {
  try {
    const v = JSON.parse(json) as AnswerEntry[];
    if (!Array.isArray(v)) return [];
    return v.map((e) => (e.sealed === undefined ? { ...e, sealed: null } : e));
  } catch {
    return [];
  }
}
export const serializeAnswers = (a: AnswerEntry[]): string => JSON.stringify(a);

/** True when two digest lists hold the same digests the same number of times, in any order. */
export function sameDigests(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map((d) => d.toLowerCase()).sort();
  const y = b.map((d) => d.toLowerCase()).sort();
  return x.every((d, i) => d === y[i]);
}
