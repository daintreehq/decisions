import { ApiError } from './errors.js';
import type { ActionKind, Provenance, QuestionStatus, Requirement, Role } from './schema.js';
import { DESKTOP_ROLES, HUMAN_ANSWER_ROLES, HUMAN_ROLES } from './schema.js';

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
