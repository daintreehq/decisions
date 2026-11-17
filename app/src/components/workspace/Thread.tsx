import { forwardRef, type ReactNode, type Ref } from 'react';
import type {
  HumanAnswerContentV1,
  PreparationReport,
  ProxyAnswerContentV1,
} from '@daintreehq/decisions-protocol';
import { preparationLine } from '../../domain/involvement.js';
import type { ActionView, QuestionView, ThreadMessage } from '../../domain/model.js';
import {
  agentName,
  answerBy,
  declineBy,
  originParts,
  withdrawnLabel,
  type FollowUpBy,
} from '../../domain/selectors.js';
import { previewText } from '../../lib/safe-text.js';
import { absoluteLabel, momentLabel } from '../../lib/time.js';
import { SafeText } from '../SafeText.js';
import { CheckIcon, ModelIcon, UndoIcon } from '../Icons.js';
import { AnswerBody } from './DecisionArea.js';
import { PhotoGrid, type PhotoUpload } from './Photos.js';

/**
 * The question as a conversation: the agent's question as an incoming message, the person's answers as outgoing
 * replies with a receipt, the decision model's answers as labelled incoming messages, and lifecycle events as quiet
 * system lines. The thread is a log: messages are only ever appended, and only additions are announced.
 */
export const Thread = forwardRef(function Thread(
  { children }: { children: ReactNode },
  ref: Ref<HTMLDivElement>,
) {
  return (
    <div
      ref={ref}
      className="thread"
      role="log"
      aria-label="Conversation"
      aria-relevant="additions"
    >
      {children}
    </div>
  );
});

export { agentName } from '../../domain/selectors.js';

/** The time, with a spoken pause before it: the dot that separates it on screen is drawn, not read. */
function Time({ iso, now }: { iso: string; now: number }) {
  return (
    <time className="msg-time" dateTime={iso} title={absoluteLabel(iso)}>
      <span className="sr-only">, </span>
      {momentLabel(iso, now)}
    </time>
  );
}

/**
 * How the agent says it prepared the question (docs/protocol.md section 20.1): whether it consulted other agents and
 * whether they agreed, with its own summary. It is the agent's account, labelled as such: nothing checked it, and it
 * is never an answer.
 */
export function PreparationNote({ report }: { report: PreparationReport }) {
  return (
    <div className="msg-prep" role="note" aria-label="The agent’s account of how it prepared">
      <p className="msg-prep-head">
        <span className="msg-prep-label">The agent’s account</span> {preparationLine(report)}
      </p>
      {report.summary && <SafeText text={report.summary} className="msg-prep-summary" />}
    </div>
  );
}

/**
 * The agent's question: who asked (agent kind and project), then one message holding the question, its files, its
 * context (collapsed), the agent's account of how it prepared (when it gave one) and its choices. `meta` sits under
 * the message (the deadline).
 */
export function AgentMessage({
  view,
  now,
  headingRef,
  files,
  context,
  choices,
  meta,
}: {
  view: QuestionView;
  now: number;
  headingRef: Ref<HTMLDivElement>;
  files?: ReactNode;
  context?: ReactNode;
  choices?: ReactNode;
  meta?: ReactNode;
}) {
  const c = view.content!;
  const { project } = originParts(view);
  return (
    <div className="msg in agent">
      {/* The header already names the project and computer, so the sender line is who and when; the project is
          kept for assistive tech, which reads the thread on its own. */}
      <p className="msg-from">
        <span className="msg-name">{agentName(view)}</span>
        <span className="sr-only"> in {project}</span>
        <Time iso={view.createdAt} now={now} />
      </p>
      <div className="bubble">
        <div id="q-title" role="heading" aria-level={1} tabIndex={-1} ref={headingRef}>
          <SafeText text={c.question} className="msg-question" />
        </div>
        {files}
        {context}
        {c.preparation && <PreparationNote report={c.preparation} />}
        {choices}
      </div>
      {meta && <p className="msg-meta">{meta}</p>}
    </div>
  );
}

/**
 * A message from the asking agent after its question: the agent's name and the time, then what it said. Straight
 * after another of its messages it is the same turn: only the time shows, closer to the message above (the name
 * stays for assistive tech). When it is waiting on the person, the words say so beneath it, beside the same amber
 * ring that marks Needs you in the list.
 */
export function AgentNote({
  view,
  m,
  now,
  asking,
  grouped,
}: {
  view: QuestionView;
  m: ThreadMessage;
  now: number;
  /** This message is the one the agent is waiting on a reply to. */
  asking: boolean;
  /** It follows another message from the agent closely: one turn. */
  grouped?: boolean;
}) {
  return (
    <div className={`msg in agent note${asking ? ' asking' : ''}${grouped ? ' grouped' : ''}`}>
      <p className="msg-from">
        <span className={grouped ? 'sr-only' : 'msg-name'}>{agentName(view)}</span>
        <Time iso={m.createdAt} now={now} />
      </p>
      <div className="bubble">
        <SafeText text={m.text} className="msg-text" />
      </div>
      {asking && (
        <p className="msg-meta msg-asking">
          <span className="ask-ring" aria-hidden="true" />
          Waiting for your reply
        </p>
      )}
    </div>
  );
}

/** "Context" collapsed inside the message, with a one-line literal preview while closed. */
export function MessageContext({ text, title = 'Context' }: { text: string; title?: string }) {
  return (
    <details className="msg-context">
      <summary>
        <span className="summary-title">{title}</span>{' '}
        <span className="summary-preview">{previewText(text, 120)}</span>
      </summary>
      <SafeText text={text} />
    </details>
  );
}

/**
 * The choices as they were offered, once they can no longer be picked here: every option stays (so the thread keeps
 * what the alternatives were), with the one in force marked.
 */
export function StaticChoices({
  view,
  chosen,
  caption,
  byModel,
  pending,
}: {
  view: QuestionView;
  chosen: readonly string[];
  caption?: string;
  /** The marked option is the decision model's, still waiting for review: it wears the model's mark, not a check. */
  byModel?: boolean;
  /** The marked option is this device's answer on its way, not yet saved: its check steps down until it lands. */
  pending?: boolean;
}) {
  const opts = view.content?.options ?? [];
  if (!opts.length) return null;
  return (
    <div className={`msg-choices${pending ? ' pending' : ''}`}>
      {caption && <p className="msg-caption">{caption}</p>}
      <ul className="choice-list">
        {opts.map((o) => {
          const on = chosen.includes(o.id);
          return (
            <li key={o.id} className={on ? 'on' : undefined}>
              <span className={`choice-mark${on && byModel ? ' model' : ''}`} aria-hidden="true">
                {on && (byModel ? <ModelIcon size={12} /> : <CheckIcon size={12} />)}
              </span>
              <span className="choice-body">
                <span className="choice-label">
                  {o.label}
                  {on && (
                    <span className="sr-only">
                      {byModel
                        ? ' (the model’s answer, not yet confirmed)'
                        : pending
                          ? ' (your answer, not saved yet)'
                          : ' (in force)'}
                    </span>
                  )}
                </span>
                {o.description && (
                  <>
                    <span className="sr-only">. </span>
                    <SafeText text={o.description} className="choice-desc" />
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One of the person's own messages, right-aligned. With a receipt, its time and the receipt share one quiet line
 * under the bubble ("17:57 · Typed into the terminal"); when delivery needs attention the line reads "17:57 · Needs
 * attention on your computer" with the warning mark, the bubble takes a warning edge, and the explanation follows.
 * Without a receipt the time sits inside the bubble. `tone` marks a pending reply or one that was not applied.
 */
export function OutgoingMessage({
  label,
  at,
  now,
  receipt,
  tone,
  flagged,
  id,
  children,
}: {
  label?: string;
  at?: string;
  now: number;
  receipt?: ReactNode;
  tone?: 'pending' | 'draft' | 'failed';
  /** Delivery needs attention: the reply itself carries the warning, not only its receipt. */
  flagged?: boolean;
  id?: string;
  children: ReactNode;
}) {
  // With a receipt the time is always on the line under the bubble, so the bubble's shape never depends on delivery.
  const footed = !!receipt && !!at;
  return (
    <div className={`msg out${tone ? ` ${tone}` : ''}${flagged ? ' flagged' : ''}`} id={id}>
      <div className="bubble">
        {/* Only the label's first letter drops to lower case: a computer's name in it keeps its own. */}
        <span className="sr-only">
          You{label ? `, ${label[0]!.toLowerCase()}${label.slice(1)}` : ''}:{' '}
        </span>
        {label && (
          <p className="bubble-label" aria-hidden="true">
            {label}
          </p>
        )}
        {children}
        {at && !footed && (
          <span className="bubble-time">
            {/* The explanation right under the bubble carries the warning; this only says it for assistive tech. */}
            {flagged && <span className="sr-only">Not typed into the terminal, </span>}
            <Time iso={at} now={now} />
          </span>
        )}
      </div>
      {footed ? (
        // The same line in every stage, a problem included: the time, then the receipt's mark and words. A problem's
        // explanation takes the row beneath it, open at once.
        <div className="msg-foot">
          <Time iso={at!} now={now} />
          {receipt}
        </div>
      ) : (
        receipt
      )}
    </div>
  );
}

/**
 * A human answer, as the person's reply, named as the answer so it stays distinct from the follow-ups after it. One
 * made on the computer names it ("Your answer on Studio Mac"). An older app's correction of an answer reads "Changed
 * answer".
 */
export function HumanAnswer({
  view,
  a,
  changed,
  now,
  receipt,
  flagged,
  tone,
  upload,
  extra,
}: {
  view: QuestionView;
  a: ActionView;
  /** It replaced the person's own earlier answer (an older app's correction). */
  changed?: boolean;
  now: number;
  receipt?: ReactNode;
  flagged?: boolean;
  /** Still on this device (queued or sending). */
  tone?: 'pending';
  /** Its photos' progress while they upload. */
  upload?: PhotoUpload;
  /** What follows the words while it is on its way (an upload that stopped). */
  extra?: ReactNode;
}) {
  return (
    <OutgoingMessage
      label={changed ? 'Changed answer' : answerBy(a).subject}
      at={a.createdAt}
      now={now}
      receipt={receipt}
      flagged={flagged}
      tone={tone}
      id={receipt ? 'ws-answer' : undefined}
    >
      <PhotoGrid
        view={view}
        images={(a.content as HumanAnswerContentV1 | null)?.images ?? []}
        upload={upload}
        unverified={a.imagesOk === false}
      />
      <AnswerBody view={view} content={a.content as never} />
      {extra}
    </OutgoingMessage>
  );
}

/**
 * One of the person's follow-ups, as their outgoing reply: "Follow-up" from a phone or tablet, "Follow-up on Studio
 * Mac" for one sent on the computer (`followUpBy`), with its own receipt. The same component, under the same key,
 * while it is on its way from this device and once committed, so its photos (and a viewer open on one) stay put.
 */
export function HumanFollowUp({
  view,
  by,
  text,
  images,
  at,
  now,
  receipt,
  flagged,
  tone,
  upload,
  extra,
  id,
}: {
  view: QuestionView;
  by: FollowUpBy;
  text: string;
  images: ThreadMessage['images'];
  at: string;
  now: number;
  receipt?: ReactNode;
  flagged?: boolean;
  /** Still on this device (queued or sending). */
  tone?: 'pending';
  /** Its photos' progress while they upload. */
  upload?: PhotoUpload;
  /** What follows the words while it is on its way (an upload that stopped). */
  extra?: ReactNode;
  id?: string;
}) {
  return (
    <OutgoingMessage
      label={by.label}
      at={at}
      now={now}
      receipt={receipt}
      flagged={flagged}
      tone={tone}
      id={id}
    >
      <PhotoGrid view={view} images={images} upload={upload} />
      {text.trim() && <SafeText text={text} className="answer-text" />}
      {extra}
    </OutgoingMessage>
  );
}

/**
 * The decision model's answer, as an incoming message that always says so: the violet mark and the words "Model
 * answer", the model, its reported confidence and how many earlier decisions it drew on, then where it has reached.
 * While it awaits review it carries Confirm answer and Overrule.
 */
export function ModelMessage({
  view,
  a,
  now,
  review,
  busy,
  error,
  onConfirm,
  onOverrule,
  receipt,
}: {
  view: QuestionView;
  a: ActionView;
  now: number;
  review: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm?: () => void;
  onOverrule?: () => void;
  receipt?: ReactNode;
}) {
  const c = a.content as ProxyAnswerContentV1;
  const pct = Math.round((c.confidence ?? 0) * 100);
  const refs = c.retrieval_reference_ids?.length ?? 0;
  return (
    <div className="msg in model" id={receipt ? 'ws-answer' : undefined}>
      <p className="msg-from">
        <span className="msg-name model-name">
          <ModelIcon size={12} />
          Model answer
        </span>
        <span className="msg-origin">
          <span className="sr-only">, </span>
          {c.model_id}
        </span>
        <Time iso={a.createdAt} now={now} />
      </p>
      <div className="bubble">
        <AnswerBody view={view} content={a.content as never} />
        <p className="model-meta">
          Model-reported confidence {pct}%
          {refs > 0 && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
              based on {refs} of your earlier decisions
            </>
          )}
        </p>
        {/* Where the model's answer has reached sits with its facts, before the choice to confirm it. */}
        {receipt}
        {c.rationale && <MessageContext text={c.rationale} title="Why the model chose this" />}
        {review && (
          <div className="msg-actions">
            <p className="model-note">Your agent may already be acting on this.</p>
            <div className="msg-buttons">
              <button
                type="button"
                className="btn primary"
                aria-disabled={busy || undefined}
                onClick={() => !busy && onConfirm?.()}
              >
                {busy ? 'Confirming…' : 'Confirm answer'}
              </button>
              {onOverrule && (
                <button
                  type="button"
                  className="btn"
                  aria-disabled={busy || undefined}
                  onClick={() => !busy && onOverrule()}
                >
                  Overrule
                </button>
              )}
            </div>
            {error && (
              <p className="status error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A cancel in the thread: the person declining it (on a phone or tablet, or on the computer, named) or the computer
 * withdrawing it, classified only from the verified record (`declineBy`).
 */
export function CancelLine({ view, a, now }: { view: QuestionView; a: ActionView; now: number }) {
  const declined = declineBy(a);
  return (
    <SystemLine
      now={now}
      at={a.createdAt}
      icon={<UndoIcon size={14} />}
      detail={
        declined
          ? 'You chose not to answer it, so nothing was approved.'
          : 'No answer is needed, and nothing was approved here.'
      }
    >
      {declined ? declined.label : withdrawnLabel(view)}
    </SystemLine>
  );
}

/** A quiet, centred line for something that happened to the question rather than something someone said. */
export function SystemLine({
  icon,
  at,
  now,
  detail,
  tone,
  children,
}: {
  icon?: ReactNode;
  at?: string;
  now: number;
  detail?: ReactNode;
  tone?: 'warn';
  children: ReactNode;
}) {
  return (
    <div className={`msg sys${tone ? ` ${tone}` : ''}`}>
      <p className="sys-line">
        {icon && <span className="sys-icon">{icon}</span>}
        <span className="sys-text">{children}</span>
        {at && (
          <>
            <span aria-hidden="true" className="sys-dot">
              ·
            </span>
            <Time iso={at} now={now} />
          </>
        )}
      </p>
      {detail && <div className="sys-detail">{detail}</div>}
    </div>
  );
}
