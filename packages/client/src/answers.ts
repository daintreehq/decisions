import type { PhoneImageReference } from '@daintreehq/decisions-protocol';

/**
 * One locally stored answer for a question: delivery bookkeeping in clear, content sealed.
 *
 * What the human (or proxy) actually said (the choices, the text, the reviewed image digests, the model's
 * confidence) is never stored in clear: it lives in `sealed`, encrypted under the identity's epoch key (see
 * `at-rest.ts`), and is opened in memory only when it has to be typed, shown or exported.
 */
export interface AnswerEntry {
  entry_id: string;
  /** `declined`: the person dismissed the question from a phone or tablet (a human-signed cancel); no content. */
  kind: 'answer' | 'expired' | 'declined';
  action: 'answer' | 'override' | 'proxy-answer' | 'confirm-proxy' | 'expire' | 'cancel';
  revision: number;
  source: 'human' | 'proxy' | 'system';
  /** Replaces an earlier answer. */
  correction: boolean;
  created_at: string;
  /**
   * Ledger seq of the event that carried it: the entry's place in the question's thread, against its follow-up
   * messages. Absent on entries stored before threads existed, which precede every message.
   */
  event_seq?: number;
  /** Needs to be typed into the terminal. */
  deliver: boolean;
  delivered: boolean;
  injection_id?: string;
  /** The sealed `AnswerContent`, or null for an entry that carries none (an expiry or decline notice). */
  sealed: string | null;
  /**
   * Phone images the host already stored for this answer, by attachment id: the path its `PhoneImageStore`
   * returned. A retried delivery reuses them instead of downloading and storing the image again. Delivery
   * bookkeeping in clear, like the rest of the entry: no alt text or digest, only the host's path.
   */
  stored_images?: { attachment_id: string; path: string }[];
}

/** The content of an answer. Held in memory only; at rest it is sealed into `AnswerEntry.sealed`. */
export interface AnswerContent {
  choices: { id: string; label?: string }[];
  text: string;
  reviewed_attachment_digests: string[];
  confidence?: number;
  model_id?: string;
  /** Why the human corrected an earlier answer (the phone requires one for a correction). */
  reason?: string;
  /** Phone images the human attached, as the encrypted answer references them (protocol section 17). */
  images?: PhoneImageReference[];
  /** The image ids the signed action record lists; delivery checks them against `images` before any fetch. */
  image_ids?: string[];
}

/** An answer with its content opened. Never stored. */
export type OpenAnswerEntry = Omit<AnswerEntry, 'sealed'> & AnswerContent;

export const EMPTY_ANSWER_CONTENT: AnswerContent = Object.freeze({
  choices: [],
  text: '',
  reviewed_attachment_digests: [],
}) as AnswerContent;

/**
 * Every content field, which `storedEntry` strips from an entry before it is stored: the ones an entry written
 * before sealing existed carried in clear, and the image fields, which only ever exist sealed.
 */
export const ANSWER_CONTENT_FIELDS = [
  'choices',
  'text',
  'reviewed_attachment_digests',
  'confidence',
  'model_id',
  'reason',
  'images',
  'image_ids',
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
    ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason } : {}),
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
