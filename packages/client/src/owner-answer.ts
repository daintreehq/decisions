import {
  CREATOR_MISSING_FEATURE,
  Id,
  type CryptoEnvelope,
  type ProtocolFeature,
  type SignedAction,
} from '@daintreehq/decisions-protocol';
import { z } from 'zod';
import type { RelayError } from './errors.js';

/*
 * The person's answer given on the owner desktop (protocol section 2, `human-desktop` provenance): a host app (Daintree)
 * signs it with the owner desktop's key and publishes it through the outbox. It answers the owner's own questions and
 * a Remote Host's alike, so nothing here needs a local question row.
 */

/** The relay feature that says it commits the owner desktop's answer (docs/protocol.md sections 2 and 19). */
export const OWNER_ANSWER_FEATURE: ProtocolFeature = 'owner-desktop-answers-v1';

/** How long one send of an answer may take before it is left to the outbox's retries. */
export const OWNER_ANSWER_TIMEOUT_MS = 15_000;

/**
 * What a host app submits for the person: the same content a phone sends (selected options, text, explicit approval,
 * reason and the SHA-256 digests of the plaintext images the person reviewed), and the revision the person reviewed,
 * which is signed as is. The protocol's content schema bounds every field when the answer is built.
 */
export const AnswerQuestionInput = z
  .object({
    questionId: Id,
    /** The question's revision as the person saw it. An answer is never moved onto a later revision. */
    expectedRevision: z.number().int().min(0),
    selectedOptionIds: z.array(z.string()).default([]),
    text: z.string().optional(),
    explicitApproval: z.boolean().optional(),
    reason: z.string().optional(),
    reviewedAttachmentDigests: z.array(z.string()).default([]),
    /**
     * The answer's id (its signed action id), chosen by the host so a repeated submission of the same answer, such as
     * a double click or a retry after a crash, is the same answer and never a second one. Generated when left out.
     */
    answerId: Id.optional(),
  })
  .strict();
export type AnswerQuestionInput = z.input<typeof AnswerQuestionInput>;
/** `AnswerQuestionInput` once parsed, its defaults filled in. */
export type AnswerQuestionRequest = z.output<typeof AnswerQuestionInput>;

/**
 * Where an answer stands, for a UI to show:
 * - `queued`: committed locally and not settled yet: the relay could not be reached, the answer waits behind its
 *   question's unsent create or cancellation or the person's earlier follow-up or decline on it, or the bridge is
 *   stopped. The outbox keeps sending it.
 * - `sent`: the relay committed it. The asking desktop types it, as it would a phone's.
 * - `already-answered`: another answer (from a phone, the decision model or this computer) was committed first.
 * - `changed`: the question is open at another revision than the one the person reviewed (it was reopened); review
 *   it again.
 * - `closed`: it expired, was cancelled or declined, or the relay has no such question (`not-found`).
 * - `unsupported`: the relay, or the computer that asked the question, does not take answers made on a computer yet.
 * - `rejected`: any other refusal, with the relay's error code.
 */
export type OwnerAnswerOutcome =
  | { status: 'queued' }
  | { status: 'sent' }
  | { status: 'already-answered' }
  | { status: 'changed' }
  | { status: 'closed'; reason: 'expired' | 'cancelled' | 'not-found' }
  | { status: 'unsupported'; by: 'relay' | 'asking-desktop' }
  | { status: 'rejected'; code: string };

/** An outcome the answer keeps: everything but `queued`. */
export type SettledOwnerAnswer = Exclude<OwnerAnswerOutcome, { status: 'queued' }>;

export type OwnerAnswerResult = {
  answerId: string;
  questionId: string;
  expectedRevision: number;
} & OwnerAnswerOutcome;

/**
 * The outbox payload of an `owner-answer` item: signed once, replayed byte for byte on every retry. The signed
 * action id is the answer id, and also the relay idempotency key.
 */
export interface OwnerAnswerPayload {
  signed: SignedAction;
  /**
   * Its place among the person's follow-ups, answers and declines from this computer on its question
   * (`ownerMessageCountKey`), from 1: they are sent in that order. Absent on an answer queued before the order was
   * kept, which goes first.
   */
  seq?: number;
}

/**
 * What is kept for each answer id, written before its outbox item and kept after it: the submission, as the relay
 * ciphertext it was signed with (so a reused id is compared by opening it, and nothing derived from the answer is
 * stored in the clear), and its outcome once it has one.
 */
export interface OwnerAnswerRecord {
  question_id: string;
  expected_revision: number;
  envelope: CryptoEnvelope;
  result: OwnerAnswerResult | null;
}

/** The meta key of an answer id's record. */
export const ownerAnswerKey = (answerId: string) => `owner-answer:${answerId}`;
/** The outbox id of an answer, kept apart from every other item's id whatever id the host chose. */
export const ownerAnswerItemId = (answerId: string) => `owner-answer:${answerId}`;

export function parseOwnerAnswerRecord(raw: string | null): OwnerAnswerRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as OwnerAnswerRecord;
    return r &&
      typeof r.question_id === 'string' &&
      typeof r.expected_revision === 'number' &&
      r.envelope &&
      typeof r.envelope === 'object'
      ? r
      : null;
  } catch {
    return null;
  }
}

/**
 * The outcome of a permanent refusal of the owner desktop's answer, told apart by the relay's error code and details,
 * never its message (protocol section 2 and `applyAction`). A `403` is classified by the caller, which knows whether
 * the relay still advertises the feature.
 */
export function ownerAnswerRefusal(e: RelayError): SettledOwnerAnswer {
  switch (e.code) {
    case 'invalid_state':
      // The only other state an open-or-answered check refuses is a cancelled question.
      return e.details?.reason === CREATOR_MISSING_FEATURE
        ? { status: 'unsupported', by: 'asking-desktop' }
        : { status: 'closed', reason: 'cancelled' };
    case 'revision_conflict': {
      const s = e.details?.status;
      return s === 'human-answered' || s === 'proxy-answered'
        ? { status: 'already-answered' }
        : { status: 'changed' };
    }
    case 'expired':
      return { status: 'closed', reason: 'expired' };
    case 'not_found':
      return { status: 'closed', reason: 'not-found' };
    default:
      return { status: 'rejected', code: e.code };
  }
}
