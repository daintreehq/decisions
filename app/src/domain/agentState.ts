import {
  LIMITS,
  snapshotFreshness,
  type QuestionStatus,
  type SnapshotAgentState,
} from '@daintreehq/decisions-protocol';
import { ageLabel } from '../lib/time.js';
import type { SnapshotState } from './snapshot.js';

/** The states a row can name: every observed state except one this version does not know. */
export type KnownAgentState = Exclude<SnapshotAgentState, 'unknown'>;

/**
 * Daintree's own words for an observed agent state (its state filter and Canopy rows), so the phone and the
 * desktop say the same thing about the same pane. The terminal drawer uses these words too. They name what was
 * observed, never what it means: "Finished" is Daintree's word for `completed`, and nothing here says "blocked".
 */
export const AGENT_STATE_LABEL: Record<KnownAgentState, string> = {
  working: 'Working',
  waiting: 'Waiting',
  directing: 'Directing',
  idle: 'Idle',
  completed: 'Finished',
  exited: 'Exited',
};

/** Colour sits on the dot only: Daintree's working green, its waiting amber, and a neutral for the rest. */
export type AgentTone = 'working' | 'waiting' | 'neutral';

const TONE: Record<KnownAgentState, AgentTone> = {
  working: 'working',
  waiting: 'waiting',
  directing: 'neutral',
  idle: 'neutral',
  completed: 'neutral',
  exited: 'neutral',
};

export interface AgentStateView {
  state: KnownAgentState;
  label: string;
  tone: AgentTone;
  /** `stale`: the relay received the observation over a minute ago, or a refresh went unanswered. */
  fresh: 'fresh' | 'stale';
  /** How long ago the relay received it, relay time: "just now", "4 min ago". */
  age: string;
  /** When Daintree read the pane, desktop time. */
  observedAt: string;
}

/**
 * What a row shows about the asking agent, or null when it shows nothing extra: no snapshot (an older desktop, or
 * none yet), sharing turned off, a closed question, or a state this version does not know. `relayNow` is the
 * phone's clock corrected to relay time; freshness never compares the desktop's clock with anyone's.
 */
export function agentStateView(
  s: SnapshotState | undefined,
  status: QuestionStatus,
  relayNow: number,
): AgentStateView | null {
  const o = s?.observation;
  if (!o || o.sharing === 'off' || o.agentState === 'unknown') return null;
  const f = snapshotFreshness({
    now: relayNow,
    status,
    snapshot: { received_at: o.receivedAt, sharing: o.sharing },
    refresh: s.refreshDeadline ? { deadline_at: s.refreshDeadline } : null,
  });
  if (f === 'none' || f === 'off') return null;
  // A refresh still in flight leaves the last observation as it was: fresh while it is inside the window.
  const fresh =
    f === 'fresh' ||
    (f === 'pending' && relayNow - Date.parse(o.receivedAt) <= LIMITS.snapshotFreshMs);
  return {
    state: o.agentState,
    label: AGENT_STATE_LABEL[o.agentState],
    tone: TONE[o.agentState],
    fresh: fresh ? 'fresh' : 'stale',
    age: ageLabel(o.receivedAt, relayNow),
    observedAt: o.observedAt,
  };
}

/** The words a screen reader hears for a row's agent state: "Agent working" or "Agent waiting, as of 4 min ago". */
export function agentStateSpoken(a: AgentStateView): string {
  const word = a.label.toLowerCase();
  return a.fresh === 'stale' ? `Agent ${word}, as of ${a.age}` : `Agent ${word}`;
}
