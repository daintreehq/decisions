import type { QuestionOrigin } from './types.js';

/** What the host knows about the terminal a question came from. */
export type LocateState =
  'alive' | 'gone' | 'host-offline' | 'generation-mismatch' | 'session-mismatch';

export interface TerminalTarget {
  hostId: string;
  paneId: string;
  terminalGeneration: number;
  agentSessionId: string | null;
  /** Part of the destination identity: an answer for worktree A must never land in worktree B. */
  worktreeId: string;
}

export interface LocateResult {
  state: LocateState;
  target?: TerminalTarget;
}

export interface InjectResult {
  ok: boolean;
  /** Opaque proof the text was written (e.g. confirmDelivery in Daintree). */
  proof?: string;
  /** Why it failed, when it did. */
  reason?: string;
}

/**
 * How the bridge talks to the real terminal. Daintree implements this on top of its terminal-notice /
 * wake-gate machinery; the CLI ships a demo sink. Implementations must never type into a pane that does
 * not match the origin exactly (host, pane, generation, agent session, worktree).
 */
export interface TerminalSink {
  /** Exact-match lookup of the originating terminal. Must compare generation, session and worktree. */
  locate(origin: QuestionOrigin): Promise<LocateResult>;
  /** True when it is safe to type now (waiting at a prompt, user not typing, no alternate screen). */
  isIdle(target: TerminalTarget): Promise<boolean>;
  /** Type the text. The bridge has already persisted the injection intent. */
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
    a.agentSessionId === b.agentSessionId &&
    a.worktreeId === b.worktreeId
  );
}
