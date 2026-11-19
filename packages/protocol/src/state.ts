import { ApiError } from './errors.js';
import { LIMITS } from './limits.js';
import type {
  ActionKind,
  EventType,
  Provenance,
  QuestionStatus,
  Requirement,
  Role,
} from './schema.js';
import {
  ADVISORY_ROUND_REVISION,
  DESKTOP_ROLES,
  HUMAN_ANSWER_ROLES,
  HUMAN_ROLES,
} from './schema.js';
import { applyMessage, type MessageSide } from './thread.js';

export interface QuestionState {
  status: QuestionStatus;
  revision: number;
  requirement: Requirement;
  proxyAbstained: boolean;
  /** Role-agnostic: true when the question has a human answer in history. */
  hasHumanAnswer?: boolean;
}

export interface Transition {
  status: QuestionStatus;
  revision: number;
  proxyAbstained: boolean;
  /** Whether this action produces an answer that must reach the originating terminal. */
  deliverable: boolean;
  /** True when the action is an idempotent retry that changes nothing and must emit no event. */
  noop: boolean;
  eventType:
    | 'decision.answer.committed'
    | 'decision.answer.overridden'
    | 'decision.proxy.committed'
    | 'decision.proxy.abstained'
    | 'decision.proxy.confirmed'
    | 'decision.cancelled'
    | 'decision.reopened';
}

const ROLE_ALLOWED: Record<ActionKind, readonly Role[]> = {
  answer: HUMAN_ANSWER_ROLES,
  override: HUMAN_ROLES,
  'confirm-proxy': HUMAN_ROLES,
  'proxy-answer': DESKTOP_ROLES,
  'proxy-abstain': DESKTOP_ROLES,
  /**
   * A desktop withdraws its question; a phone or tablet declines to answer it, and so does the owner desktop with a
   * signed `decline: true` (open questions only).
   */
  cancel: [...DESKTOP_ROLES, ...HUMAN_ROLES],
  reopen: ['owner-desktop'],
};

/**
 * Whether a device of `role` may sign `action` at all, given the record's signed `decline` flag. Receivers check
 * signers with it, as the relay does. Only the owner desktop signs a `decline`, and only on a `cancel`: a phone or
 * tablet declines by its role alone, and a `desktop-host` never declines.
 */
export function roleMaySign(action: ActionKind, role: Role, decline?: true): boolean {
  if (decline === true) return action === 'cancel' && role === 'owner-desktop';
  return ROLE_ALLOWED[action].includes(role);
}

/**
 * True when a `cancel` means the person declined to answer, rather than the desktop withdrawing the question: signed
 * by a phone or tablet, or by the owner desktop with `decline: true` in the signed record. `decline` must come from
 * that record, never from a relay-supplied field. Only meaningful for a cancel whose signature and signer certificate
 * have been verified and whose signer passed `roleMaySign`.
 */
export const isPersonDecline = (action: ActionKind, role: Role, decline?: true): boolean =>
  action === 'cancel' &&
  (HUMAN_ROLES.includes(role) || (role === 'owner-desktop' && decline === true));

/**
 * The provenance an action implies when a phone or tablet signs the human actions and a desktop the rest. It cannot
 * tell the owner desktop's `answer` (`human-desktop`) from a phone's: `provenanceForSigner` can.
 */
export function provenanceForAction(action: ActionKind): 'human' | 'proxy' | 'none' {
  switch (action) {
    case 'answer':
    case 'override':
    case 'confirm-proxy':
      return 'human';
    case 'proxy-answer':
      return 'proxy';
    default:
      return 'none';
  }
}

function assertRoleAllowed(action: ActionKind, role: Role, decline?: true): void {
  if (!roleMaySign(action, role, decline)) {
    throw new ApiError(
      'forbidden',
      decline === true
        ? `role ${role} may not sign a decline`
        : `role ${role} may not perform ${action}`,
    );
  }
}

/**
 * The provenance a signed action carries, from its action and its signer's certified role: `human-desktop` for the
 * person's answer signed on the owner desktop, otherwise `provenanceForAction`. Throws `forbidden` for a role the
 * action does not allow, as `applyAction` does.
 */
export function provenanceForSigner(action: ActionKind, role: Role): Provenance | 'none' {
  assertRoleAllowed(action, role);
  if (action === 'answer' && role === 'owner-desktop') return 'human-desktop';
  return provenanceForAction(action);
}

/**
 * Pure, authoritative transition table (spec section 7). Throws ApiError on any illegal move.
 * `expectedRevision` is compare-and-swap input from the signer, and `decline` the signed record's `decline` flag.
 */
export function applyAction(
  state: QuestionState,
  action: ActionKind,
  role: Role,
  expectedRevision: number,
  decline?: true,
): Transition {
  assertRoleAllowed(action, role, decline);
  const conflict = () =>
    new ApiError('revision_conflict', 'question changed since you last saw it', {
      details: { latest_revision: state.revision, status: state.status },
    });

  switch (action) {
    case 'answer': {
      if (state.status === 'expired') throw new ApiError('expired', 'question expired');
      if (state.status !== 'open') {
        if (state.status === 'human-answered' || state.status === 'proxy-answered')
          throw conflict();
        throw new ApiError('invalid_state', `cannot answer a ${state.status} question`);
      }
      if (expectedRevision !== state.revision) throw conflict();
      return {
        status: 'human-answered',
        revision: state.revision + 1,
        proxyAbstained: state.proxyAbstained,
        deliverable: true,
        noop: false,
        eventType: 'decision.answer.committed',
      };
    }
    case 'override': {
      if (state.status !== 'human-answered' && state.status !== 'proxy-answered') {
        throw new ApiError('invalid_state', 'only an answered question can be overridden');
      }
      if (expectedRevision !== state.revision) throw conflict();
      return {
        status: 'human-answered',
        revision: state.revision + 1,
        proxyAbstained: state.proxyAbstained,
        deliverable: true,
        noop: false,
        eventType: 'decision.answer.overridden',
      };
    }
    case 'proxy-answer': {
      if (state.requirement === 'human-required') {
        throw new ApiError('forbidden', 'a proxy can never answer a human-required question');
      }
      if (state.status !== 'open') throw conflict();
      if (expectedRevision !== state.revision) throw conflict();
      return {
        status: 'proxy-answered',
        revision: state.revision + 1,
        proxyAbstained: false,
        deliverable: true,
        noop: false,
        eventType: 'decision.proxy.committed',
      };
    }
    case 'proxy-abstain': {
      if (state.requirement === 'human-required') {
        throw new ApiError('forbidden', 'human-required questions never involve a proxy');
      }
      if (state.status !== 'open') throw conflict();
      if (expectedRevision !== state.revision) throw conflict();
      return {
        status: 'open',
        revision: state.revision,
        proxyAbstained: true,
        deliverable: false,
        noop: false,
        eventType: 'decision.proxy.abstained',
      };
    }
    case 'confirm-proxy': {
      if (state.status !== 'proxy-answered') {
        throw new ApiError('invalid_state', 'nothing to confirm');
      }
      if (expectedRevision !== state.revision) throw conflict();
      return {
        status: 'human-answered',
        revision: state.revision + 1,
        proxyAbstained: state.proxyAbstained,
        deliverable: false,
        noop: false,
        eventType: 'decision.proxy.confirmed',
      };
    }
    case 'cancel': {
      if (expectedRevision !== state.revision) throw conflict();
      if (state.status === 'cancelled') {
        return {
          status: 'cancelled',
          revision: state.revision,
          proxyAbstained: state.proxyAbstained,
          deliverable: false,
          noop: true,
          eventType: 'decision.cancelled',
        };
      }
      if (state.status !== 'open' && state.status !== 'proxy-answered') {
        throw new ApiError('invalid_state', `cannot cancel a ${state.status} question`);
      }
      // A person declines only a question still waiting on them; a proxy answer is confirmed or overridden instead.
      if (state.status !== 'open' && isPersonDecline(action, role, decline)) {
        throw new ApiError('invalid_state', `cannot decline a ${state.status} question`);
      }
      return {
        status: 'cancelled',
        revision: state.revision,
        proxyAbstained: state.proxyAbstained,
        deliverable: false,
        noop: false,
        eventType: 'decision.cancelled',
      };
    }
    case 'reopen': {
      if (state.status !== 'cancelled' && state.status !== 'expired') {
        throw new ApiError('invalid_state', 'only cancelled or expired questions can be reopened');
      }
      if (expectedRevision !== state.revision) throw conflict();
      return {
        status: 'open',
        revision: state.revision + 1,
        proxyAbstained: false,
        deliverable: false,
        noop: false,
        eventType: 'decision.reopened',
      };
    }
  }
}

export const isTerminalStatus = (s: QuestionStatus): boolean =>
  s === 'human-answered' || s === 'cancelled' || s === 'expired';

/* ---------- rounds and advisory deadlines (docs/protocol.md section 21) ---------- */

/**
 * A question's current round, as the relay holds it. A round opens with the create (revision 0) or a reopen, and
 * `expiresAt` is that round's signed deadline: the create's `expires_at`, or the reopen's.
 */
export interface RoundState extends QuestionState {
  /** The current round's deadline, in ms of relay time; null = it never expires. */
  expiresAt: number | null;
  /** The signed create's reply mode was `advisory` (`replyModeOf`). Only its first round is advisory. */
  advisory: boolean;
}

/** True while the round is the advisory round the signed create opened; a reopened round always waits. */
export const isAdvisoryRound = (s: Pick<RoundState, 'advisory' | 'revision'>): boolean =>
  s.advisory && s.revision === ADVISORY_ROUND_REVISION;

/**
 * One input to a question's round, with the authority behind it. `at` is relay time in ms: when the relay commits
 * it, never when a client receives it, so replaying committed history never re-judges an answer by a later clock.
 */
export type RoundEvent =
  /** A signed action whose signature and signer certificate were verified; `role` is the certified role. */
  | {
      type: 'action';
      action: ActionKind;
      role: Role;
      expectedRevision: number;
      /** The signed record's `decline` flag. */
      decline?: true;
      /** `reopen` only: the signed new deadline, in ms; null or absent = none. */
      expiresAt?: number | null;
      at: number;
    }
  /** The relay's deadline check (its alarm or a lazy sweep). Relay-asserted and unsigned: it answers nothing. */
  | { type: 'deadline'; at: number }
  /** A verified thread message (section 16). It never answers, and it never moves the round or its deadline. */
  | {
      type: 'message';
      side: MessageSide;
      role: Role;
      signerIsPublisher: boolean;
      messageCount: number;
      at: number;
    }
  /** `DELETE /questions/{id}`: authenticated, unsigned, with no `expected_revision`. */
  | { type: 'delete'; role: Role };

/**
 * What a round event means. `advisory-unanswered` and `expired-unsatisfied` are both an expiry with no answer:
 * only the first lets the asking host tell its agent that the plan it stated is due.
 */
export type RoundOutcome =
  | 'answered'
  | 'overridden'
  | 'proxy-answered'
  | 'proxy-abstained'
  | 'proxy-confirmed'
  | 'declined'
  | 'withdrawn'
  | 'reopened'
  | 'advisory-unanswered'
  | 'expired-unsatisfied'
  | 'message'
  | 'deleted'
  | 'unchanged';

/**
 * Who stands behind a transition: `person` (an answer, override, confirmation, decline or human message, signed on a
 * phone, a tablet or the owner desktop), `proxy` (a desktop's model), `desktop` (a withdrawal, reopen, agent message
 * or delete), or `relay` (a deadline, on the relay's clock and unsigned).
 */
export type RoundAuthority = 'person' | 'proxy' | 'desktop' | 'relay';

export interface RoundTransition {
  /** The round after the event; null once the question is deleted. */
  state: RoundState | null;
  outcome: RoundOutcome;
  authority: RoundAuthority;
  /** The answer's provenance; null for everything that is not an answer, a deadline above all. */
  provenance: Provenance | null;
  /** The event carries an answer the asking desktop must deliver. */
  deliverable: boolean;
  /**
   * True only for `advisory-unanswered`: the asking host may now tell its agent that the plan it stated is due. It
   * is not an answer, a choice or an approval, and it says nothing about whether a notice reached the agent or
   * whether the agent acted on the plan.
   */
  fallbackDue: boolean;
  /** The decision model may learn from this: only a person's answer or override, never a deadline. */
  trainable: boolean;
  /** The ledger event the relay appends, or null when it appends none (a no-op, or a deadline not yet due). */
  eventType: EventType | null;
  /**
   * Set when the submitted event itself was refused after the relay committed the round's due deadline in the
   * same transaction: the transition is that deadline's, and the submitter observes this error (`410 expired`).
   * Every other refusal throws, and nothing commits.
   */
  refusal: ApiError | null;
}

const OUTCOME: Record<Transition['eventType'], RoundOutcome> = {
  'decision.answer.committed': 'answered',
  'decision.answer.overridden': 'overridden',
  'decision.proxy.committed': 'proxy-answered',
  'decision.proxy.abstained': 'proxy-abstained',
  'decision.proxy.confirmed': 'proxy-confirmed',
  'decision.cancelled': 'withdrawn',
  'decision.reopened': 'reopened',
};

/** The relay's deadline transition at `at`, or null when the round is not open or not yet due. */
function dueDeadline(s: RoundState, at: number): RoundTransition | null {
  if (s.status !== 'open' || s.expiresAt === null || at < s.expiresAt) return null;
  const advisory = isAdvisoryRound(s);
  return {
    state: { ...s, status: 'expired' },
    outcome: advisory ? 'advisory-unanswered' : 'expired-unsatisfied',
    authority: 'relay',
    provenance: null,
    deliverable: false,
    fallbackDue: advisory,
    trainable: false,
    eventType: 'decision.expired',
    refusal: null,
  };
}

/**
 * The executable transition table for one question round (docs/protocol.md section 21), for every reader that
 * replays or decides a round: the relay, the publishing desktop, the phone app and Daintree. It adds the deadline,
 * deletion, messages and the advisory outcome to `applyAction` and `applyMessage`, and refuses exactly what they
 * refuse, with the same errors. `state` null means the question was deleted (`404 not_found`).
 *
 * A due deadline commits before anything else at the same instant: a submission at or after an open round's
 * deadline returns the deadline's transition with `refusal` set to `410 expired`, as the relay commits the expiry and
 * refuses the submission in one transaction. A late answer on a round already expired throws `expired`, a late
 * decline `invalid_state`, a late proxy answer `revision_conflict`, all as `applyAction` does.
 */
export function applyRoundEvent(state: RoundState | null, ev: RoundEvent): RoundTransition {
  if (state === null) throw new ApiError('not_found', 'no such question');
  if (ev.type === 'delete') {
    if (ev.role !== 'owner-desktop')
      throw new ApiError('forbidden', `role ${ev.role} may not delete`);
    return {
      state: null,
      outcome: 'deleted',
      authority: 'desktop',
      provenance: null,
      deliverable: false,
      fallbackDue: false,
      trainable: false,
      eventType: 'decision.deleted',
      refusal: null,
    };
  }
  const due = dueDeadline(state, ev.at);
  if (ev.type === 'deadline') {
    return (
      due ?? {
        state: { ...state },
        outcome: 'unchanged',
        authority: 'relay',
        provenance: null,
        deliverable: false,
        fallbackDue: false,
        trainable: false,
        eventType: null,
        refusal: null,
      }
    );
  }
  if (due) return { ...due, refusal: new ApiError('expired', 'question expired') };

  if (ev.type === 'message') {
    const m = applyMessage(state, ev);
    return {
      state: { ...state, ...m.state },
      outcome: 'message',
      authority: ev.side === 'human' ? 'person' : 'desktop',
      provenance: null,
      deliverable: false,
      fallbackDue: false,
      trainable: false,
      eventType: 'decision.message.posted',
      refusal: null,
    };
  }

  const tr = applyAction(state, ev.action, ev.role, ev.expectedRevision, ev.decline);
  let expiresAt = state.expiresAt;
  if (ev.action === 'reopen') {
    expiresAt = ev.expiresAt ?? null;
    if (
      expiresAt !== null &&
      (expiresAt <= ev.at || expiresAt > ev.at + LIMITS.maxQuestionExpiryMs)
    ) {
      throw new ApiError('validation_error', 'expires_at must be in the future (or null)');
    }
  }
  const declined = isPersonDecline(ev.action, ev.role, ev.decline);
  const provenance = provenanceForSigner(ev.action, ev.role);
  return {
    state: {
      ...state,
      status: tr.status,
      revision: tr.revision,
      proxyAbstained: tr.proxyAbstained,
      expiresAt,
    },
    outcome: tr.noop ? 'unchanged' : declined ? 'declined' : OUTCOME[tr.eventType],
    authority:
      provenance === 'proxy' || ev.action === 'proxy-abstain'
        ? 'proxy'
        : provenance !== 'none' || declined
          ? 'person'
          : 'desktop',
    provenance: provenance === 'none' ? null : provenance,
    deliverable: tr.deliverable,
    fallbackDue: false,
    trainable: !tr.noop && (ev.action === 'answer' || ev.action === 'override'),
    eventType: tr.noop ? null : tr.eventType,
    refusal: null,
  };
}
