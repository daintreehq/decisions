import {
  CREATOR_MISSING_FEATURE,
  Id,
  QuestionStatus,
  type ProtocolFeature,
  type SignedAction,
} from '@daintreehq/decisions-protocol';
import { z } from 'zod';
import type { RelayError } from './errors.js';

/*
 * The person declining a question on the owner desktop (protocol section 6.1): a host app (Daintree) signs a `cancel`
 * with `decline: true` with the owner desktop's key and publishes it through the outbox. Every desktop that declared
 * `owner-desktop-declines-v1` files it as the person's decline, exactly as it files a phone's. It declines the owner's
 * own questions and a Remote Host's alike, so nothing here needs a local question row. Withdrawing a question is a
 * different call (`cancelQuestion`).
 */

/** The feature a relay advertises, and a question's desktop declares, for the owner desktop's decline (section 19). */
export const OWNER_DECLINE_FEATURE: ProtocolFeature = 'owner-desktop-declines-v1';

/** How long one send of a decline, or one read of its question to confirm it, may take before the outbox retries. */
export const OWNER_DECLINE_TIMEOUT_MS = 15_000;

/** What a host app submits for the person: the question and the revision they saw open. */
export const DeclineQuestionInput = z
  .object({
    questionId: Id,
    /** The question's revision as the person saw it. A decline is never moved onto a later revision. */
    expectedRevision: z.number().int().min(0),
    /**
     * The decline's id (its signed action id), chosen by the host so a repeated submission, such as a double click or
     * a retry after a crash, is the same decline and never a second one. Generated when left out.
     */
    declineId: Id.optional(),
  })
  .strict();
export type DeclineQuestionInput = z.input<typeof DeclineQuestionInput>;
/** `DeclineQuestionInput` once parsed. */
export type DeclineQuestionRequest = z.output<typeof DeclineQuestionInput>;

/**
 * Where a decline stands, for a UI to show:
 * - `queued`: committed locally and not settled yet: the relay could not be reached, the decline waits behind its
 *   question's unsent create or withdrawal, the relay took it and it is being confirmed, or the bridge is stopped. The
 *   outbox keeps sending the same signed decline.
 * - `declined`: the relay committed this decline. The asking desktop tells its agent, as it would a phone's decline.
 * - `already-answered`: the question was answered first (by the person, or by the decision model).
 * - `changed`: the question is open at another revision than the one the person saw (it was reopened).
 * - `closed`: it expired, was withdrawn or declined first (`cancelled`), or the relay has no such question
 *   (`not-found`).
 * - `unsupported`: the relay, or the computer that asked the question, does not take a decline made on a computer yet.
 * - `rejected`: any other refusal, with the relay's error code.
 */
export type OwnerDeclineOutcome =
  | { status: 'queued' }
  | { status: 'declined' }
  | { status: 'already-answered' }
  | { status: 'changed' }
  | { status: 'closed'; reason: 'expired' | 'cancelled' | 'not-found' }
  | { status: 'unsupported'; by: 'relay' | 'asking-desktop' }
  | { status: 'rejected'; code: string };

/** An outcome the decline keeps: everything but `queued`. */
export type SettledOwnerDecline = Exclude<OwnerDeclineOutcome, { status: 'queued' }>;

export type OwnerDeclineResult = {
  declineId: string;
  questionId: string;
  expectedRevision: number;
} & OwnerDeclineOutcome;

/**
 * The outbox payload of an `owner-decline` item: signed once, replayed byte for byte on every retry. The signed action
 * id is the decline id, and also the relay idempotency key. `confirming` is set once the relay has answered the send
 * (taken, or refused for a state it does not name): from then on the decline is settled by reading its question, and
 * never sent again.
 */
export interface OwnerDeclinePayload {
  signed: SignedAction;
  confirming?: true;
}

/** What is kept for each decline id, written before its outbox item and kept after it, with its outcome once it has one. */
export interface OwnerDeclineRecord {
  question_id: string;
  expected_revision: number;
  result: OwnerDeclineResult | null;
}

/** The meta key of a decline id's record. */
export const ownerDeclineKey = (declineId: string) => `owner-decline:${declineId}`;
/** The outbox id of a decline, kept apart from every other item's id whatever id the host chose. */
export const ownerDeclineItemId = (declineId: string) => `owner-decline:${declineId}`;

export function parseOwnerDeclineRecord(raw: string | null): OwnerDeclineRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as OwnerDeclineRecord;
    return r && typeof r.question_id === 'string' && typeof r.expected_revision === 'number'
      ? r
      : null;
  } catch {
    return null;
  }
}

/**
 * The outcome of a permanent refusal of the owner desktop's decline, told apart by the relay's error code and details,
 * never its message (section 6.1 and `applyAction`). Null when only the question's state can say: an `invalid_state`
 * without a reason is a question that is answered, proxy-answered or expired at the revision the person saw. A `403`
 * is classified by the caller, which knows whether the relay still advertises the feature.
 */
export function ownerDeclineRefusal(e: RelayError): SettledOwnerDecline | null {
  switch (e.code) {
    case 'invalid_state':
      return e.details?.reason === CREATOR_MISSING_FEATURE
        ? { status: 'unsupported', by: 'asking-desktop' }
        : null;
    case 'revision_conflict':
      return fromState(String(e.details?.status ?? ''), null);
    case 'expired':
      return { status: 'closed', reason: 'expired' };
    case 'not_found':
      return { status: 'closed', reason: 'not-found' };
    default:
      return { status: 'rejected', code: e.code };
  }
}

/** The part of `GET /questions/{id}` (`QuestionDetail`) a decline is confirmed from. */
const DeclineConfirmation = z.object({
  status: QuestionStatus,
  revision: z.number().int().min(0),
  actions: z.array(
    z.object({
      action_id: z.string(),
      record: z.object({ signature: z.string() }),
    }),
  ),
});

/**
 * Settle a decline from its question as the relay holds it. A cancel the relay takes and a retry of one it already
 * took answer alike, and so does a cancel of a question that another cancel closed first, so only the question's
 * action log tells them apart: `declined` when this very signed decline is in it, whatever happened since. Otherwise
 * the question's state says why it was not taken. Null for a detail that cannot be read.
 */
export function ownerDeclineFromDetail(
  detail: unknown,
  signed: SignedAction,
): SettledOwnerDecline | null {
  const d = DeclineConfirmation.safeParse(detail);
  if (!d.success) return null;
  const { action_id, signature } = signed.record;
  if (d.data.actions.some((a) => a.action_id === action_id && a.record.signature === signature))
    return { status: 'declined' };
  return (
    fromState(d.data.status, d.data.revision === signed.record.expected_revision) ?? {
      // Open at the revision the person saw with no trace of the decline: a relay that took it should have stored it.
      status: 'rejected',
      code: 'not_committed',
    }
  );
}

/**
 * The outcome a question's state gives a decline that was not taken. `sameRevision` is null when the state comes
 * from a revision conflict, which already says the revision moved on.
 */
function fromState(status: string, sameRevision: boolean | null): SettledOwnerDecline | null {
  switch (status) {
    case 'human-answered':
    case 'proxy-answered':
      return { status: 'already-answered' };
    case 'cancelled':
      return { status: 'closed', reason: 'cancelled' };
    case 'expired':
      return { status: 'closed', reason: 'expired' };
    case 'open':
      return sameRevision === true ? null : { status: 'changed' };
    default:
      return sameRevision === null ? { status: 'changed' } : null;
  }
}
