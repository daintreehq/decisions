import type { PhoneImageReference, Role } from '@daintreehq/decisions-protocol';
import type { QuestionRow } from './types.js';

/**
 * One locally stored answer for a question: delivery bookkeeping in clear, content sealed.
 *
 * What the human (or proxy) actually said (the choices, the text, the reviewed image digests, the model's
 * confidence) is never stored in clear: it lives in `sealed`, encrypted under the identity's epoch key (see
 * `at-rest.ts`), and is opened in memory only when it has to be typed, shown or exported.
 */
export interface AnswerEntry {
  entry_id: string;
  /**
   * `declined`: the person dismissed the question, from a phone or tablet (a human-signed cancel) or on the owner
   * desktop (its cancel with the signed `decline` flag); no content. `unpublished`: the question's deadline passed
   * before it ever reached the relay, so no answer to it was recorded; written by this desktop (`source: system`), no
   * content.
   */
  kind: 'answer' | 'expired' | 'declined' | 'unpublished';
  action: 'answer' | 'override' | 'proxy-answer' | 'confirm-proxy' | 'expire' | 'cancel';
  revision: number;
  /**
   * Who the answer is from: `human` for the person (from a phone, a tablet or the owner desktop; `signer_role` tells
   * them apart), `proxy` for a desktop's decision model, `system` for an expiry.
   */
  source: 'human' | 'proxy' | 'system';
  /**
   * The device that signed the action, and its certified role when it was verified: on a decline, a phone's or
   * tablet's, or the owner desktop's. Absent on an expiry, which no device signed, on a decline stored before
   * declines kept their signer, and on answers stored before signers were kept, which were all a phone's or tablet's
   * when human: an earlier library refused every other signer.
   */
  signer_device_id?: string;
  signer_role?: Role;
  /**
   * `unpublished` only: the question was advisory (protocol section 21) and the host's policy allowed its stated plan
   * to go ahead at the deadline, so the agent is told it may carry the plan out. Nothing was decided or approved.
   * Delivery drops it before the notice is typed once the host no longer allows advice (`unpublishedPlanDue`), never
   * the other way.
   */
  fallback_due?: boolean;
  /**
   * `expired` only: the expiry closed the advisory round of an advisory question (protocol section 21) on a host that
   * delivers advisory outcomes, so the agent is told in its own notice, never the blocking expiry block.
   * `fallback-due`: the host's policy lets the stated plan go ahead; `fallback-withheld`: it does not. Absent on an
   * ordinary expiry. Delivery may only ever turn `fallback-due` into `fallback-withheld` before the notice is typed
   * (the policy no longer allows advice, or the host no longer delivers advisory outcomes and types the ordinary
   * expiry block instead), never the other way. Nothing was decided or approved either way.
   */
  advisory_disposition?: AdvisoryDisposition;
  /**
   * An advisory notice only: the attempt whose write may or may not have reached the terminal (an ambiguous sink
   * answer, or a crash recovery that found no marker). Kept with the entry so `get_decision` still says so once a
   * reopen has replaced the round; the notice is never typed again on its own.
   */
  uncertain_injection_id?: string;
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

/** What an advisory question's unanswered deadline lets the asking agent do (`AnswerEntry.advisory_disposition`). */
export type AdvisoryDisposition = 'fallback-due' | 'fallback-withheld';

/**
 * The disposition an advisory expiry notice not yet typed may still carry, as the host stands now: `fallback-due`
 * becomes `fallback-withheld` once its policy no longer allows advice, or once it no longer delivers advisory outcomes
 * (it then types the ordinary expiry block, which says the same). Never upgraded.
 */
export function currentDisposition(
  d: AdvisoryDisposition | undefined,
  host: { outcomes: boolean; allowed: boolean },
): AdvisoryDisposition | undefined {
  if (d === undefined) return undefined;
  return d === 'fallback-due' && !(host.outcomes && host.allowed) ? 'fallback-withheld' : d;
}

/**
 * Whether a never-published advisory question's stated plan may still go ahead (`AnswerEntry.fallback_due`), as the
 * host stands now. Its notice, not yet typed, follows the host as a published advisory expiry does
 * (`currentDisposition`): only a host that still delivers advisory outcomes and whose policy still allows advice lets
 * it go ahead. A notice typed, or that may have been (`delivery-uncertain`), keeps what it said. Never upgraded.
 */
export function unpublishedPlanDue(
  e: Pick<AnswerEntry, 'fallback_due' | 'delivered'>,
  q: Pick<QuestionRow, 'delivery_status'>,
  host: { outcomes: boolean; allowed: boolean },
): boolean {
  if (e.fallback_due !== true) return false;
  return (
    e.delivered || q.delivery_status === 'delivery-uncertain' || (host.outcomes && host.allowed)
  );
}

/** An entry whose stated plan is due: an advisory expiry's `fallback-due`, or a never-published `fallback_due`. */
export const planDue = (e: Pick<AnswerEntry, 'advisory_disposition' | 'fallback_due'>): boolean =>
  e.advisory_disposition === 'fallback-due' || e.fallback_due === true;

/**
 * The entry with its stated plan withheld, as delivery records it before typing once the host no longer allows it:
 * an advisory expiry becomes `fallback-withheld`, a never-published notice loses `fallback_due`.
 */
export function withholdPlan(e: AnswerEntry): AnswerEntry {
  if (e.advisory_disposition === 'fallback-due')
    return { ...e, advisory_disposition: 'fallback-withheld' };
  const { fallback_due: _due, ...rest } = e;
  return rest;
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

/** An expiry notice of an advisory round, typed as the advisory notice (`advisory_disposition`). */
export const isAdvisoryNotice = (e: Pick<AnswerEntry, 'kind' | 'advisory_disposition'>): boolean =>
  e.kind === 'expired' && e.advisory_disposition !== undefined;

/** A content-free notice that closed a round without an answer: an expiry, or the person's decline. */
export const isClosure = (e: Pick<AnswerEntry, 'kind'>): boolean =>
  e.kind === 'expired' || e.kind === 'declined';

/**
 * True while a closure notice still describes its question: it closed the current round, and the question is
 * still closed that way. A reopen moves the round on, so an earlier round's notice is never typed after it.
 */
export function closureInForce(
  e: Pick<AnswerEntry, 'kind' | 'revision'>,
  q: Pick<QuestionRow, 'local_status' | 'question_revision'>,
): boolean {
  if (e.revision !== q.question_revision) return false;
  return e.kind === 'expired' ? q.local_status === 'expired' : q.local_status === 'cancelled';
}

/**
 * True when an answer intent at `revision` can only have been for a closure notice of a round since replaced: every
 * entry at that revision, typed or not, is such a notice. An answer at the same revision keeps the intent its own.
 */
export function supersededClosure(
  q: Pick<QuestionRow, 'answers_json' | 'local_status' | 'question_revision'>,
  revision: number,
): boolean {
  const at = parseAnswers(q.answers_json).filter((e) => e.revision === revision);
  return at.length > 0 && at.every((e) => isClosure(e) && !closureInForce(e, q));
}

/**
 * Where the person gave a human answer: `computer` when the owner desktop signed it (the person's own answer, made
 * on the computer, never a proxy's), `phone` for a phone or tablet. Null for a proxy answer and an expiry.
 */
export function answeredOn(
  e: Pick<AnswerEntry, 'source' | 'signer_role'>,
): 'computer' | 'phone' | null {
  if (e.source !== 'human') return null;
  return e.signer_role === 'owner-desktop' ? 'computer' : 'phone';
}

/** True when two digest lists hold the same digests the same number of times, in any order. */
export function sameDigests(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map((d) => d.toLowerCase()).sort();
  const y = b.map((d) => d.toLowerCase()).sort();
  return x.every((d, i) => d === y[i]);
}
