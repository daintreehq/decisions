import type { AgentStateView } from '../domain/agentState.js';
import { agentStateSpoken } from '../domain/agentState.js';

/**
 * The asking agent's observed state on a row: a small dot and Daintree's word for it. Colour sits on the dot only
 * (working green, waiting amber, neutral for the rest). A stale observation steps down rather than fading: the dot
 * becomes a hollow neutral ring, the word drops to secondary text, and (where there is room, `age`) its age follows.
 * Screen readers hear ", Agent working" or ", Agent waiting, as of 4 min ago" as part of the row's name; nothing
 * here is a live region, so updates are never read out.
 */
export function AgentStateMark({ a, age = true }: { a: AgentStateView; age?: boolean }) {
  return (
    <span
      className="agent-state"
      data-state={a.state}
      data-tone={a.tone}
      data-fresh={a.fresh}
      title={a.fresh === 'stale' ? `Last observed ${a.age}` : undefined}
    >
      <span className="agent-dot" aria-hidden="true" />
      <span className="sr-only">, {agentStateSpoken(a)}</span>
      <span className="agent-label" aria-hidden="true">
        {a.label}
      </span>
      {age && a.fresh === 'stale' && (
        <span className="agent-age" aria-hidden="true">
          · {a.age}
        </span>
      )}
    </span>
  );
}
