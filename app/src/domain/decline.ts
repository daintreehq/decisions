import { CREATOR_MISSING_FEATURE } from '@daintreehq/decisions-protocol';
import type { OutboxEntry } from '../data/outbox.js';
import type { ActionView, QuestionView } from './model.js';
import { declineBy, withdrawnLabel } from './selectors.js';

/*
 * The person's dismissal from this phone or tablet (docs/protocol.md section 6.1), from the moment it is sealed into
 * the outbox until it settles. It is signed once against the revision the person saw and never signed again, so it
 * either closes that round or settles as something else that happened to the question first. Only this device's own
 * verified `cancel` in the thread says it was taken: a relay answers a cancel of a question another cancel closed with
 * a receipt shaped like a committed one, so a 2xx alone never does.
 */

/** How a dismissal settled without closing the question: kept with it until the person has seen it. */
export type DeclineOutcome =
  | { status: 'answered' }
  | { status: 'expired' }
  /** The desktop withdrew the round first; `label` names it as the closed line does. */
  | { status: 'withdrawn'; label: string }
  /** The person declined it first on another device, or on the computer it names. */
  | { status: 'declined-elsewhere'; computer: string | null }
  /** The question moved on (it was reopened) before the dismissal reached the relay. */
  | { status: 'changed' }
  /** The computer that asked it does not take a dismissal. */
  | { status: 'unsupported' }
  /** The relay no longer has the question. */
  | { status: 'gone' }
  | { status: 'rejected'; code: string };

/** Where a dismissal from this device stands, for the thread and the list. */
export type DeclineStanding =
  /** Sealed on this device and never sent. */
  | { kind: 'queued' }
  /** Sent at least once, with no answer from the relay yet (a dropped connection or a restart mid-send). */
  | { kind: 'unconfirmed' }
  | { kind: 'sending' }
  /** The relay answered; the thread has not yet shown how it settled. */
  | { kind: 'confirming' }
  /** The thread holds it: the question is declined. */
  | { kind: 'declined' }
  | { kind: 'settled'; outcome: DeclineOutcome };

/** This device's own decline in the thread: the very action it signed, verified, from this device. */
function ownDecline(e: OutboxEntry, v: QuestionView, deviceId: string): ActionView | undefined {
  return v.actions.find(
    (a) =>
      a.verified &&
      a.action === 'cancel' &&
      a.actionId === e.recordId &&
      a.signerDeviceId === deviceId,
  );
}

/** What closed the round the decline was signed against, when another verified cancel did. */
function otherCloser(e: OutboxEntry, v: QuestionView): DeclineOutcome | null {
  const a = v.actions.find(
    (x) =>
      x.verified &&
      x.action === 'cancel' &&
      x.revision === e.expectedRevision &&
      x.actionId !== e.recordId,
  );
  if (!a) return null;
  const by = declineBy(a);
  return by
    ? { status: 'declined-elsewhere', computer: by.computer }
    : { status: 'withdrawn', label: withdrawnLabel(v) };
}

/** The outcome a refusal names on its own, from the relay's code and details, never its message. */
function fromRefusal(e: OutboxEntry, v: QuestionView | undefined): DeclineOutcome {
  if (e.refusalReason === CREATOR_MISSING_FEATURE) return { status: 'unsupported' };
  switch (e.errorCode) {
    case 'expired':
      return { status: 'expired' };
    case 'not_found':
      return { status: 'gone' };
    case 'revision_conflict':
      switch (e.latestStatus) {
        case 'human-answered':
        case 'proxy-answered':
          return { status: 'answered' };
        case 'expired':
          return { status: 'expired' };
        case 'cancelled':
          // Reopened and closed again since: what closed the person's round says more, when the thread has it.
          return (v && otherCloser(e, v)) ?? { status: 'changed' };
        default:
          return { status: 'changed' };
      }
    case 'invalid_state': {
      // Refused at the revision the person saw from a state it does not name: answered (which a later revision would
      // have reported as a conflict) or, in practice, expired by the relay's sweep.
      const s = v?.status;
      return s === 'human-answered' || s === 'proxy-answered'
        ? { status: 'answered' }
        : { status: 'expired' };
    }
    default:
      return { status: 'rejected', code: e.errorCode ?? 'unknown' };
  }
}

/**
 * How a decline from this device has settled, read from its entry and the thread: `accepted` once the thread holds
 * the very decline it signed (it is then the thread's own and its entry can go), an outcome to keep when something
 * else settled the round first, or null while the thread can't yet say (the relay's answer has not been read back, or
 * the cancel that closed the round is not verified yet). A missing question is only ever read as gone for a decline
 * the relay took, since a thread being rebuilt has none for a moment.
 */
export function declineSettlement(
  e: OutboxEntry,
  v: QuestionView | undefined,
  deviceId: string,
): 'accepted' | DeclineOutcome | null {
  if (e.kind !== 'decline') return null;
  if (e.outcome) return e.outcome;
  if (v && ownDecline(e, v, deviceId)) return 'accepted';
  if (e.state === 'conflicted' || e.state === 'rejected' || e.state === 'expired')
    return fromRefusal(e, v);
  if (e.state !== 'committed') return null;
  // Taken by the relay, and the question is gone: there is nothing left to show it against.
  if (!v) return 'accepted';
  const closer = otherCloser(e, v);
  if (closer) return closer;
  // Still open at the round it was signed against: not read back yet. A cancelled round whose closer is not verified
  // yet waits for it too.
  if (v.revision === e.expectedRevision && (v.status === 'open' || v.status === 'cancelled'))
    return null;
  // The thread moved past that round with no cancel in it this device can verify.
  return { status: 'changed' };
}

/** Where a decline stands, as the thread and the list show it. */
export function declineStanding(
  e: OutboxEntry,
  v: QuestionView | undefined,
  deviceId: string,
): DeclineStanding {
  const s = declineSettlement(e, v, deviceId);
  if (s === 'accepted') return { kind: 'declined' };
  if (s) return { kind: 'settled', outcome: s };
  if (e.state === 'sending') return { kind: 'sending' };
  if (e.state === 'committed') return { kind: 'confirming' };
  return e.attempts > 0 ? { kind: 'unconfirmed' } : { kind: 'queued' };
}

/** Whether a decline is still on its way: it holds the question until it settles. */
export const declineActive = (st: DeclineStanding): boolean =>
  st.kind === 'queued' ||
  st.kind === 'unconfirmed' ||
  st.kind === 'sending' ||
  st.kind === 'confirming';

/** The line the thread shows for a decline still on its way. Each one says that it is only on this device. */
export function declineProgressText(
  st: DeclineStanding,
  online: boolean,
): { text: string; note?: string } | null {
  switch (st.kind) {
    case 'queued':
      return {
        text: 'Dismissal saved on this device, not sent yet.',
        note: online
          ? 'The question stays open everywhere else until it sends.'
          : 'It sends when you’re back online. The question stays open everywhere else until then.',
      };
    case 'unconfirmed':
      return {
        text: 'Dismissal saved on this device. Your relay hasn’t confirmed it yet.',
        note: online
          ? 'Trying again. The question may still be open everywhere else.'
          : 'It is tried again when you’re back online. The question may still be open everywhere else.',
      };
    case 'sending':
      return { text: 'Sending your dismissal…' };
    case 'confirming':
      return { text: 'Checking how your dismissal settled…' };
    default:
      return null;
  }
}

/** What the thread says about a dismissal that settled without closing the question. */
export function declineOutcomeText(o: DeclineOutcome): string {
  switch (o.status) {
    case 'answered':
      return 'Not dismissed: this question was answered first.';
    case 'expired':
      return 'Not dismissed: this question expired first.';
    case 'withdrawn':
      return `Not dismissed: it was already ${o.label.charAt(0).toLowerCase()}${o.label.slice(1)}.`;
    case 'declined-elsewhere':
      return o.computer
        ? `Already dismissed on ${o.computer}.`
        : 'Already dismissed on another of your devices.';
    case 'changed':
      return 'Not dismissed: this question changed before your dismissal reached your relay. Review it, and dismiss it again if you still want to.';
    case 'unsupported':
      return 'Not dismissed: the computer that asked this can’t take a dismissal until its Daintree is updated. The question stays open until it expires.';
    case 'gone':
      return 'Not dismissed: your relay no longer has this question.';
    case 'rejected':
      return 'Not dismissed: your relay refused it.';
  }
}

/** Dismiss was asked for while something else from this device is still on its way on the question. */
export class DeclineBlockedError extends Error {
  constructor(
    message = 'Something you sent on this question is still on its way. Dismiss it once that has gone.',
  ) {
    super(message);
    this.name = 'DeclineBlockedError';
  }
}

/** An answer or follow-up was asked for while this device's dismissal of the question is on its way. */
export class DeclineInFlightError extends Error {
  constructor(
    message = 'Your dismissal of this question is on its way, so it takes nothing else.',
  ) {
    super(message);
    this.name = 'DeclineInFlightError';
  }
}
