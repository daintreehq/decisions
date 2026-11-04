import { memo, type MouseEvent } from 'react';
import type { AgentStateView } from '../../domain/agentState.js';
import type { QuestionView } from '../../domain/model.js';
import {
  answerSummary,
  choiceLine,
  closedLine,
  dueLabel,
  principalStatus,
  type RowStatus,
} from '../../domain/lists.js';
import { hiddenQuestionText, originParts } from '../../domain/selectors.js';
import { previewText } from '../../lib/safe-text.js';
import { ageLabel } from '../../lib/time.js';
import { AgentStateMark } from '../AgentState.js';
import { ClockIcon, SendIcon, WarningIcon } from '../Icons.js';
import { StatusGlyph } from './StatusGlyph.js';

/** An answer from this device still in its outbox: what was chosen, and whether it is queued or in flight. */
export interface PendingAnswer {
  state: 'queued' | 'sending';
  selected: string[];
  text: string;
}

export interface RowExtras {
  pending: PendingAnswer | undefined;
}

/**
 * A deadline is something to act on only when it is close: every question carries its host's default expiry (a
 * week), and a "Due in 6 d" on every row would be noise. Inside a day it takes the warning hue.
 */
const DUE_SOON_MS = 3 * 24 * 3_600_000;

/** Compact relative time for a row's corner: "4 min", "3 h", "2 d". */
function since(iso: string, now: number): string {
  const s = ageLabel(iso, now);
  return s === 'just now' ? 'now' : s.replace(/ ago$/, '');
}

/**
 * One question in the list, as compact as a chat list's row. The whole row opens it. The question takes one line,
 * two at most, with its relative time at the right; the answer in force follows as one line ("You: …" /
 * "Model: …"), or why it closed without one; then project · computer, and only the chips someone can act on: a due time, an answer still queued
 * or sending from this device, a delivery issue. When the asking desktop shares pane snapshots, the agent's
 * observed state ends that line in a slot of its own. The state glyph leads, and says its state in words to screen
 * readers.
 */
export const QuestionRow = memo(function QuestionRow({
  v,
  now,
  selected,
  extras,
  agent = null,
  onOpen,
}: {
  v: QuestionView;
  now: number;
  selected: boolean;
  extras: RowExtras;
  /** The asking agent's observed state, or null to show nothing extra (no snapshot, sharing off, closed). */
  agent?: AgentStateView | null;
  onOpen: (e: MouseEvent<HTMLAnchorElement>, id: string) => void;
}) {
  const pending = extras.pending;
  // An answer that has not left this device is the person's, already decided: it reads as theirs, not as owed.
  const status: RowStatus = pending ? 'sending' : principalStatus(v, now);
  const answer = pending
    ? { author: 'You' as const, text: choiceLine(v, pending.selected, pending.text) }
    : answerSummary(v);
  const closed = closedLine(status);
  const due =
    !pending && v.expiresAt && Date.parse(v.expiresAt) - now < DUE_SOON_MS
      ? dueLabel(v, now)
      : null;
  const { project, machine } = originParts(v);
  // A question that needs you is as old as its asking; anything else, as its latest event.
  const at = status === 'needs' || status === 'sending' ? v.createdAt : v.lastEventAt;

  return (
    <li className="qrow-item">
      <a
        href={`/q/${v.id}`}
        className="qrow"
        data-row-id={v.id}
        data-status={status}
        aria-current={selected ? 'page' : undefined}
        onClick={(e) => onOpen(e, v.id)}
      >
        <span className="qrow-glyph">
          <StatusGlyph status={status} />
        </span>
        <span className="qrow-line">
          <span className="qrow-q">
            {v.content ? previewText(v.content.question, 240) : hiddenQuestionText(v)}
          </span>
          <time className="qrow-time" dateTime={at}>
            <span aria-hidden="true">{since(at, now)}</span>
            <span className="sr-only">, {ageLabel(at, now)}</span>
          </time>
        </span>
        {answer ? (
          <span className="qrow-a">
            <span className="who">{answer.author}:</span> {answer.text || 'No note'}
          </span>
        ) : (
          closed && <span className="qrow-a closed">{closed}</span>
        )}
        <span className="qrow-meta">
          <span className="qrow-origin">
            <span className="project">{project}</span>
            {machine && (
              <>
                <span className="sep" aria-hidden="true">
                  {' · '}
                </span>
                <span className="sr-only">, on </span>
                <span className="machine">{machine}</span>
              </>
            )}
          </span>
          {due && (
            <span className={due.urgent ? 'badge warn' : 'badge'}>
              <ClockIcon size={12} />
              {due.label}
            </span>
          )}
          {pending && (
            <span className="badge">
              <SendIcon size={12} />
              {pending.state === 'queued' ? 'Queued on this device' : 'Sending…'}
            </span>
          )}
          {status === 'delivery' && (
            <span className="badge warn">
              <WarningIcon size={12} />
              Delivery issue
            </span>
          )}
          {/* Last, in a slot that never changes the line count: going stale or changing word only redraws it. */}
          {agent && (
            <span className="m agent">
              <AgentStateMark a={agent} />
            </span>
          )}
        </span>
      </a>
    </li>
  );
});
