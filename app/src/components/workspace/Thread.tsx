import { forwardRef, type ReactNode, type Ref } from 'react';
import type { HumanAnswerContentV1, ProxyAnswerContentV1 } from '@daintreehq/decisions-protocol';
import type { ActionView, QuestionView, ThreadMessage } from '../../domain/model.js';
import { agentName, originParts } from '../../domain/selectors.js';
import { previewText } from '../../lib/safe-text.js';
import { absoluteLabel, momentLabel } from '../../lib/time.js';
import { SafeText } from '../SafeText.js';
import { CheckIcon, ModelIcon } from '../Icons.js';
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

function Time({ iso, now }: { iso: string; now: number }) {
  return (
    <time className="msg-time" dateTime={iso} title={absoluteLabel(iso)}>
      {momentLabel(iso, now)}
    </time>
  );
}

/**
 * The agent's question: who asked (agent kind and project), then one message holding the question, its files, its
 * context (collapsed) and its choices. `meta` sits under the message (the deadline).
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
        {choices}
      </div>
      {meta && <p className="msg-meta">{meta}</p>}
    </div>
  );
}

/**
 * A message from the asking agent after its question: the agent's name and the time, then what it said. When it is
 * waiting on the person, the words say so beneath it, beside the same amber ring that marks Needs you in the list.
 */
export function AgentNote({
  view,
  m,
  now,
  asking,
}: {
  view: QuestionView;
  m: ThreadMessage;
  now: number;
  /** This message is the one the agent is waiting on a reply to. */
  asking: boolean;
}) {
  return (
    <div className={`msg in agent note${asking ? ' asking' : ''}`}>
      <p className="msg-from">
        <span className="msg-name">{agentName(view)}</span>
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
        <span className="summary-title">{title}</span>
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
}: {
  view: QuestionView;
  chosen: readonly string[];
  caption?: string;
  /** The marked option is the decision model's, still waiting for review: it wears the model's mark, not a check. */
  byModel?: boolean;
}) {
  const opts = view.content?.options ?? [];
  if (!opts.length) return null;
  return (
    <div className="msg-choices">
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
                      {byModel ? ' (the model’s answer, not yet confirmed)' : ' (in force)'}
                    </span>
                  )}
                </span>
                {o.description && <SafeText text={o.description} className="choice-desc" />}
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
 * under the bubble ("17:57 · Typed into the terminal"); when delivery needs attention the line is the time alone and
 * the explanation follows it. Without a receipt the time sits inside the bubble. `tone` marks a pending reply or one
 * that was not applied.
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
  // With a receipt the time is always on the line under the bubble, so the bubble's shape never depends on
  // delivery; when delivery needs attention that line is the time alone and the explanation follows it.
  const footed = !!receipt && !!at;
  return (
    <div className={`msg out${tone ? ` ${tone}` : ''}${flagged ? ' flagged' : ''}`} id={id}>
      <div className="bubble">
        <span className="sr-only">You{label ? `, ${label.toLowerCase()}` : ''}: </span>
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
      {footed && flagged ? (
        <>
          <div className="msg-foot">
            <span className="sr-only">Not typed into the terminal, </span>
            <Time iso={at!} now={now} />
          </div>
          {receipt}
        </>
      ) : footed ? (
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
 * A human answer, as the person's reply, named as the answer so it stays distinct from the follow-ups after it. An
 * older app's correction of an answer reads "Changed answer".
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
      label={changed ? 'Changed answer' : 'Your answer'}
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
        <span className="msg-origin">{c.model_id}</span>
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
              based on {refs} of your earlier decision{refs === 1 ? '' : 's'}
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
                <button type="button" className="btn" onClick={onOverrule}>
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
