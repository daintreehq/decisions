import {
  CREATOR_MISSING_FEATURE,
  Id,
  type ProtocolFeature,
  type SignedMessage,
} from '@daintreehq/decisions-protocol';
import { z } from 'zod';
import type { RelayError } from './errors.js';

/*
 * The person's follow-up written on the owner desktop (protocol section 16): a host app (Daintree) signs it with the
 * owner desktop's key as the person's thread message and publishes it through the outbox. It goes to the owner's own
 * questions and a Remote Host's alike, so nothing here needs a local question row.
 */

/**
 * The feature a desktop declares to take the person's follow-up signed by the owner desktop, and a relay advertises to
 * commit one (docs/protocol.md sections 16 and 19). The relay commits one only on a question whose desktop declared it.
 */
export const OWNER_MESSAGE_FEATURE: ProtocolFeature = 'owner-desktop-messages-v1';

/** How long one send of a follow-up, or the read of its question after a refusal, may take. */
export const OWNER_MESSAGE_TIMEOUT_MS = 15_000;

/**
 * What a host app submits for the person: the text they wrote, as a phone sends it. A follow-up from the computer
 * carries no phone images and never expects a reply (only the agent's messages do); the protocol's content schema
 * bounds the text when the message is built.
 */
export const SendFollowUpInput = z
  .object({
    questionId: Id,
    text: z.string(),
    /**
     * The message's id (its signed message id), chosen by the host so a repeated submission of the same follow-up,
     * such as a double click or a retry after a crash, is the same message and never a second one. Generated when
     * left out.
     */
    messageId: Id.optional(),
  })
  .strict();
export type SendFollowUpInput = z.input<typeof SendFollowUpInput>;
/** `SendFollowUpInput` once parsed. */
export type SendFollowUpRequest = z.output<typeof SendFollowUpInput>;

/**
 * Where a follow-up stands, for a UI to show:
 * - `queued`: committed locally and not settled yet: the relay could not be reached, the follow-up waits behind its
 *   question's unsent create or withdrawal or the person's earlier follow-up, answer or decline on it, or the bridge
 *   is stopped. The outbox keeps sending it.
 * - `sent`: the relay committed it to the thread. The asking desktop types it into the pane, as it would a phone's.
 * - `closed`: the question expired or was cancelled or declined, or the relay has no such question (`not-found`).
 * - `unsupported`: the relay, or the computer that asked the question, does not take follow-ups sent from a computer
 *   yet. Submit it again under a new id once it does.
 * - `rejected`: any other refusal, with the relay's error code (`invalid_state` for a thread at its message limit).
 */
export type OwnerFollowUpOutcome =
  | { status: 'queued' }
  | { status: 'sent' }
  | { status: 'closed'; reason: 'expired' | 'cancelled' | 'not-found' }
  | { status: 'unsupported'; by: 'relay' | 'asking-desktop' }
  | { status: 'rejected'; code: string };

/** An outcome the follow-up keeps: everything but `queued`. */
export type SettledOwnerFollowUp = Exclude<OwnerFollowUpOutcome, { status: 'queued' }>;

export type OwnerFollowUpResult = {
  messageId: string;
  questionId: string;
} & OwnerFollowUpOutcome;

/**
 * The outbox payload of an `owner-message` item: signed once, replayed byte for byte on every retry. The signed
 * message id is the follow-up's id, and also the relay idempotency key.
 */
export interface OwnerMessagePayload {
  signed: SignedMessage;
  /**
   * The follow-up's place among the person's follow-ups, answers and declines from this computer on its question,
   * from 1: sent in order.
   */
  seq: number;
}

/**
 * What is kept for each follow-up id, written before its outbox item and kept after it: the signed message (its text
 * only as the relay ciphertext, so a reused id is compared by opening it and nothing it says is stored in the clear),
 * its order, and its outcome once it has one. A crash between this record and the outbox item queues this same
 * signed message, never a second one.
 */
export interface OwnerMessageRecord extends OwnerMessagePayload {
  question_id: string;
  result: OwnerFollowUpResult | null;
}

/** The meta key of a follow-up id's record. */
export const ownerMessageKey = (messageId: string) => `owner-message:${messageId}`;
/** The outbox id of a follow-up, kept apart from every other item's id whatever id the host chose. */
export const ownerMessageItemId = (messageId: string) => `owner-message:${messageId}`;
/** The person's follow-ups, answers and declines from this computer on a question, ever: their order. */
export const ownerMessageCountKey = (questionId: string) => `owner-messages:${questionId}`;

export function parseOwnerMessageRecord(raw: string | null): OwnerMessageRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as OwnerMessageRecord;
    return r &&
      typeof r.question_id === 'string' &&
      typeof r.seq === 'number' &&
      r.signed &&
      typeof r.signed === 'object' &&
      r.signed.record &&
      r.signed.envelope
      ? r
      : null;
  } catch {
    return null;
  }
}

/**
 * The outcome of a permanent refusal of the owner desktop's follow-up, told apart by the relay's error code and
 * details, never its message (protocol section 16). `null` for a bare `invalid_state`, which a cancelled question,
 * a thread at its message limit and a desktop that takes no messages all share: the caller reads the question to tell
 * them apart. A `403` is classified by the caller, which knows whether the relay still advertises the feature.
 */
export function ownerMessageRefusal(e: RelayError): SettledOwnerFollowUp | null {
  switch (e.code) {
    case 'invalid_state':
      return e.details?.reason === CREATOR_MISSING_FEATURE
        ? { status: 'unsupported', by: 'asking-desktop' }
        : null;
    case 'expired':
      return { status: 'closed', reason: 'expired' };
    case 'not_found':
      return { status: 'closed', reason: 'not-found' };
    default:
      return { status: 'rejected', code: e.code };
  }
}
