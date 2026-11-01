import { ApiError } from './errors.js';
import type { ActionKind, QuestionStatus, Requirement, Role } from './schema.js';
import { DESKTOP_ROLES, HUMAN_ROLES } from './schema.js';

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
  answer: HUMAN_ROLES,
  override: HUMAN_ROLES,
  'confirm-proxy': HUMAN_ROLES,
  'proxy-answer': DESKTOP_ROLES,
  'proxy-abstain': DESKTOP_ROLES,
  cancel: DESKTOP_ROLES,
  reopen: ['owner-desktop'],
};

/** The provenance an action's signer role implies. Used by relay and clients alike. */
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

/**
 * Pure, authoritative transition table (spec section 7). Throws ApiError on any illegal move.
 * `expectedRevision` is compare-and-swap input from the signer.
 */
export function applyAction(
  state: QuestionState,
  action: ActionKind,
  role: Role,
  expectedRevision: number,
): Transition {
  if (!ROLE_ALLOWED[action].includes(role)) {
    throw new ApiError('forbidden', `role ${role} may not perform ${action}`);
  }
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
