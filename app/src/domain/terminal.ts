import {
  LIMITS,
  isThreadClosedStatus,
  type QuestionStatus,
  type SnapshotWaitingReason,
} from '@daintreehq/decisions-protocol';
import { ageLabel } from '../lib/time.js';
import { AGENT_STATE_LABEL, type AgentTone, type KnownAgentState } from './agentState.js';
import type { SnapshotState } from './snapshot.js';

/**
 * Why a waiting agent waits, in observation language: what Daintree saw at the pane, never what it means. Daintree's
 * own headline for an error is "Blocked by an error"; the phone says what was observed instead, so nothing here reads
 * "blocked" or "stuck" (docs/daintree-integration-spec.md section 8).
 */
const WAITING: Record<SnapshotWaitingReason, string> = {
  prompt: 'Waiting at its prompt',
  question: 'Waiting on a question',
  approval: 'Waiting for approval',
  error: 'Waiting after an error',
};

/** The drawer's words for an observed state: the row's word, with the waiting reason spelled out. */
export function observedStateWords(
  state: KnownAgentState,
  reason: SnapshotWaitingReason | null,
): string {
  if (state === 'waiting') return WAITING[reason ?? 'prompt'];
  return AGENT_STATE_LABEL[state];
}

const TONE: Record<KnownAgentState, AgentTone> = {
  working: 'working',
  waiting: 'waiting',
  directing: 'neutral',
  idle: 'neutral',
  completed: 'neutral',
  exited: 'neutral',
};

/** "just now", "12 s ago", then the app's usual "4 min ago". Relay time on both sides. */
export function secondsAgo(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  return ageLabel(fromIso, now);
}

/** What the terminal drawer (and its button) shows for a question. */
export type TerminalView =
  /** The question has closed: the relay cleared its snapshot. */
  | { kind: 'closed' }
  /** The asking desktop said it does not share its panes. */
  | { kind: 'off' }
  /**
   * Nothing published yet (an older desktop, or none so far). `asking`: a refresh is on its way or outstanding;
   * `unanswered`: the last one passed its deadline with nothing sent; `idle`: none asked yet.
   */
  | { kind: 'none'; phase: 'asking' | 'unanswered' | 'idle' }
  | {
      kind: 'snapshot';
      /** Null for a state this version does not know: the drawer shows the lines without naming it. */
      state: KnownAgentState | null;
      words: string | null;
      tone: AgentTone;
      /**
       * The observation is old: the relay received it over a minute ago, or a refresh passed its deadline with no
       * newer one. Independent of `refreshing`: asking for a new snapshot is not evidence that the old one is current.
       */
      stale: boolean;
      /** A refresh is on its way to the relay, or outstanding with its deadline still ahead. */
      refreshing: boolean;
      /** A refresh passed its deadline with no newer snapshot: the computer did not answer. */
      unanswered: boolean;
      /** Relay time since the relay received it: "12 s ago". */
      age: string;
      /** When Daintree read the pane, desktop time (shown on hover). */
      observedAt: string;
      paneTitle: string;
      lines: string[];
      snapshotId: string;
    };

/**
 * Follows `snapshotFreshness` (docs/protocol.md section 18), every time in relay time, but keeps the two things it
 * folds together apart: whether the observation is still current, and whether a newer one has been asked for.
 * `requesting` is this phone's own request, before the relay has answered it.
 */
export function terminalView(
  s: SnapshotState | undefined,
  status: QuestionStatus,
  relayNow: number,
  requesting = false,
): TerminalView {
  if (isThreadClosedStatus(status)) return { kind: 'closed' };
  const o = s?.observation ?? null;
  if (o?.sharing === 'off') return { kind: 'off' };
  const deadline = s?.refreshDeadline ? Date.parse(s.refreshDeadline) : null;
  const outstanding = deadline !== null && relayNow < deadline;
  const unanswered = deadline !== null && relayNow >= deadline;
  const refreshing = requesting || outstanding;
  if (!o)
    return { kind: 'none', phase: refreshing ? 'asking' : unanswered ? 'unanswered' : 'idle' };
  const known = o.agentState === 'unknown' ? null : o.agentState;
  return {
    kind: 'snapshot',
    state: known,
    words: known ? observedStateWords(known, o.waitingReason) : null,
    tone: known ? TONE[known] : 'neutral',
    stale:
      unanswered ||
      !!s?.missedRefresh ||
      relayNow - Date.parse(o.receivedAt) > LIMITS.snapshotFreshMs,
    refreshing,
    unanswered: unanswered && !refreshing,
    age: secondsAgo(o.receivedAt, relayNow),
    observedAt: o.observedAt,
    paneTitle: o.paneTitle,
    lines: o.terminalLines,
    snapshotId: o.snapshotId,
  };
}

/** The terminal button's accessible name: what the drawer holds, at a glance. */
export function terminalButtonName(v: TerminalView): string {
  if (v.kind === 'off') return 'Terminal, not shared';
  if (v.kind !== 'snapshot' || !v.words) return 'Terminal';
  const words = v.words.charAt(0).toLowerCase() + v.words.slice(1);
  return v.stale ? `Terminal, agent ${words}, stale, as of ${v.age}` : `Terminal, agent ${words}`;
}
