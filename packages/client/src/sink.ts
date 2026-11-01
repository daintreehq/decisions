import type { QuestionOrigin } from './types.js';

/**
 * Why the originating terminal cannot take an answer right now. The delivery engine routes each one:
 *
 * - `host-offline`: wait (`pending-host`) and try again when the host is back.
 * - `relaunched`: the pane id may still exist, but the ownership principal or agent incarnation changed, so
 *   this is a different run. `gone`, `generation-mismatch` and `session-mismatch` likewise mean the original
 *   agent is no longer there. All four resume through a verified adapter when one can, else `needs-attention`.
 * - `rejected`: the terminal is there but refused the text (for example a write that failed before any byte
 *   was written). Straight to `needs-attention`; resuming would not help.
 */
export type UnavailableReason =
  'host-offline' | 'relaunched' | 'gone' | 'generation-mismatch' | 'session-mismatch' | 'rejected';

/** What the host knows about the terminal a question came from. */
export type LocateState = 'alive' | Exclude<UnavailableReason, 'rejected'>;

/**
 * The full identity of the destination. Two targets are the same terminal only if every field matches;
 * `sameTarget` is the comparison and the engine never types into a target that differs from the origin.
 */
export interface TerminalTarget {
  hostId: string;
  paneId: string;
  terminalGeneration: number;
  /** The run of the pane (changes on relaunch even when the pane id is reused). */
  ownershipPrincipal: string;
  /** The start of the agent inside the pane. */
  agentIncarnation: string;
  agentSessionId: string | null;
  /** Part of the destination identity: an answer for worktree A must never land in worktree B. */
  worktreeId: string;
}

export interface LocateResult {
  state: LocateState;
  target?: TerminalTarget;
}

/**
 * The outcome of one `inject()` call. Exactly one of:
 *
 * - `delivered`: the text was written to the terminal, and `proof` says how the sink knows (Daintree: the
 *   `confirmDelivery` observation of `pty_written`). Queue acceptance is NOT delivery: a sink that has only
 *   handed the text to something that may type it later must wait for the outcome. A `delivered` result
 *   without a non-empty proof is treated as `ambiguous`.
 * - `held`: nothing was written and nothing will be; try again later (busy pane, user typing, wake gate
 *   closed). No attention, nothing reported to the relay.
 * - `unavailable`: nothing was written; the destination is not there (see `UnavailableReason` for routing).
 * - `ambiguous`: the text may or may not have been written (Enter dropped, write interrupted, crash). It
 *   becomes `delivery-uncertain` and is never typed again automatically.
 *
 * A thrown error is treated as `ambiguous`, and so is any result that does not match one of these shapes.
 */
export type InjectResult =
  | { outcome: 'delivered'; proof: string }
  | { outcome: 'held'; reason?: string }
  | { outcome: 'unavailable'; reason: UnavailableReason; detail?: string }
  | { outcome: 'ambiguous'; reason?: string };

/**
 * How the bridge talks to the real terminal. Daintree implements this on top of its terminal-notice /
 * wake-gate machinery; the CLI ships a demo sink. Implementations must never type into a pane that does
 * not match the origin exactly (host, pane, generation, ownership principal, agent incarnation, agent
 * session, worktree).
 */
export interface TerminalSink {
  /**
   * Exact-match lookup of the originating terminal. Must compare generation, principal, incarnation, session
   * and worktree, and report `relaunched` when the pane id is live but the principal or incarnation changed.
   */
  locate(origin: QuestionOrigin): Promise<LocateResult>;
  /** True when it is safe to type now (waiting at a prompt, user not typing, no alternate screen). */
  isIdle(target: TerminalTarget): Promise<boolean>;
  /**
   * Type the text and resolve with what really happened. The bridge has already persisted the injection
   * intent. Resolve only once the outcome is known; see `InjectResult`.
   */
  inject(target: TerminalTarget, text: string, injectionId: string): Promise<InjectResult>;
  /** Crash reconciliation: has the text carrying this injection id already appeared in the terminal? */
  hasMarker(target: TerminalTarget, injectionId: string): Promise<boolean>;
  /** Optionally resume the agent session in the original host/worktree; null when impossible. */
  resume?(origin: QuestionOrigin): Promise<TerminalTarget | null>;
}

/**
 * Per-agent resume (spec 16.4). Adapters must be backed by a real, tested CLI contract; an adapter that
 * is not verified reports `supported: false` and the bridge falls back to `needs-attention`.
 */
export interface AgentResumeAdapter {
  kind: string;
  probe(hostId: string): Promise<{ supported: boolean; reason?: string }>;
  canResume(origin: QuestionOrigin): Promise<boolean>;
  resume(origin: QuestionOrigin): Promise<{ target: TerminalTarget; ready: boolean }>;
}

/** Embeds the marker in the typed notice so `hasMarker` can find it after a crash. */
export function markerFor(injectionId: string): string {
  return `[decision-injection ${injectionId}]`;
}

/** Two targets are the same destination only if EVERY identity field matches. */
export function sameTarget(a: TerminalTarget, b: TerminalTarget): boolean {
  return (
    a.hostId === b.hostId &&
    a.paneId === b.paneId &&
    a.terminalGeneration === b.terminalGeneration &&
    a.ownershipPrincipal === b.ownershipPrincipal &&
    a.agentIncarnation === b.agentIncarnation &&
    a.agentSessionId === b.agentSessionId &&
    a.worktreeId === b.worktreeId
  );
}

/** The destination an origin names: what a located target must equal before anything is typed. */
export function targetOf(o: QuestionOrigin): TerminalTarget {
  return {
    hostId: o.host_id,
    paneId: o.pane_id,
    terminalGeneration: o.terminal_generation,
    ownershipPrincipal: o.ownership_principal,
    agentIncarnation: o.agent_incarnation,
    agentSessionId: o.agent_session_id,
    worktreeId: o.worktree_id,
  };
}
