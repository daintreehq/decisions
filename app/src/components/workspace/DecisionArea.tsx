import { useEffect, useId, useRef, useState } from 'react';
import type { HumanAnswerContentV1, ProxyAnswerContentV1 } from '@daintreehq/decisions-protocol';
import type { ActionView, QuestionView } from '../../domain/model.js';
import { entryImages, type OutboxEntry } from '../../data/outbox.js';
import { momentLabel } from '../../lib/time.js';
import { SafeText } from '../SafeText.js';
import { CopyIcon, RefreshIcon, WarningIcon } from '../Icons.js';
import { PhotoGrid } from './Photos.js';

export const optionLabel = (view: QuestionView, id: string) =>
  view.content?.options.find((o) => o.id === id)?.label ?? id;

type Content = (HumanAnswerContentV1 & Partial<ProxyAnswerContentV1>) | null;

/** The options as radio cards. Selecting is reversible until Send; nothing is preselected. */
export function OptionCards({
  view,
  selected,
  onSelect,
  disabled,
  currentIds,
  legend,
}: {
  view: QuestionView;
  selected: readonly string[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  /** Marks the answer in force, when correcting it. */
  currentIds?: readonly string[];
  legend: string;
}) {
  const gid = useId();
  const options = view.content?.options ?? [];
  return (
    <fieldset className="options" disabled={disabled} id="ws-options">
      <legend className="eyebrow">{legend}</legend>
      {options.map((o) => {
        const on = selected.includes(o.id);
        const current = !!currentIds?.includes(o.id);
        return (
          <label key={o.id} className={`option${on ? ' on' : ''}`}>
            <input
              type="radio"
              name={`${gid}-opt`}
              value={o.id}
              checked={on}
              onChange={() => onSelect(o.id)}
            />
            <span className="option-body">
              <span className="option-label">
                {o.label}
                {current && (
                  <span className="option-current">
                    <span aria-hidden="true"> · </span>
                    <span className="sr-only">, </span>
                    Current answer
                  </span>
                )}
              </span>
              {o.description && (
                <>
                  <span className="sr-only">. </span>
                  <SafeText text={o.description} className="option-desc" />
                </>
              )}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** What an answer says: the chosen option, the text, and the reason when it is a correction. */
export function AnswerBody({ view, content }: { view: QuestionView; content: Content }) {
  if (!content) return null;
  const labels = content.selected_option_ids.map((id) => optionLabel(view, id));
  return (
    <div className="answer-body">
      {labels.length > 0 && <p className="answer-choice">{labels.join(', ')}</p>}
      {content.text && <SafeText text={content.text} className="answer-text" />}
      {content.reason && (
        <p className="answer-reason">
          <span className="eyebrow-inline">Reason</span>{' '}
          <SafeText text={content.reason} className="inline" />
        </p>
      )}
    </div>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy with honest feedback: "Copied", or how to copy by hand. */
export function CopyButton({
  text,
  label = 'Copy text',
  quiet,
}: {
  text: string;
  label?: string;
  /** A utility beside the real decisions: drawn as a ghost button so it doesn't compete with them. */
  quiet?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <>
      <button
        type="button"
        className={`btn small${quiet ? ' ghost' : ''}`}
        onClick={() => void copy(text).then((ok) => setState(ok ? 'ok' : 'fail'))}
      >
        <CopyIcon size={16} />
        {state === 'ok' ? 'Copied' : label}
      </button>
      {state === 'fail' && (
        <span className="muted copy-fail" role="status">
          Couldn’t copy. Select the text to copy it.
        </span>
      )}
    </>
  );
}

/**
 * Another device answered first, the question changed, or it expired. The answer in force is already a message in
 * the thread above, so the card names it rather than repeating it, then keeps the unsent words as the person's own
 * reply that never went: a dashed outgoing bubble, with what can still be done with them beneath.
 */
export function ConflictCard({
  view,
  entry,
  current,
  now,
  canCorrect,
  onUseAsCorrection,
  onSendAsFollowUp,
  onDismiss,
  dismissDiscards,
  onKeepCurrent,
  keepBusy,
  keepError,
  onRetry,
  note,
}: {
  view: QuestionView;
  entry: OutboxEntry;
  current: ActionView | null;
  now: number;
  /** The answer in force is a model answer still open to overruling. */
  canCorrect: boolean;
  onUseAsCorrection: () => void;
  /** The answer in force is a person's, which is final: the words can still go as a follow-up. */
  onSendAsFollowUp?: () => void;
  onDismiss: () => void;
  /** Dismissing removes the words from this device (nothing can take them any more): it asks first. */
  dismissDiscards?: boolean;
  /** The answer in force is a model answer awaiting review: the person can agree with it from here. */
  onKeepCurrent?: () => void;
  /** Confirming the model answer is under way: both decisions hold until it settles. */
  keepBusy?: boolean;
  /** Why confirming the model answer didn't go through. */
  keepError?: string | null;
  /** Its photos were lost on the relay, which sending again (with fresh copies) can put right. */
  onRetry?: () => void;
  /** Why moving it elsewhere didn't happen (its photos couldn't be read, or didn't fit). */
  note?: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const askId = useId();
  const keepRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  // Focus moves into the question when it opens and back to the button that opened it when it closes, so a
  // keyboard never lands on the page while deciding about real loss.
  const opened = useRef(false);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (opened.current) discardRef.current?.focus();
    opened.current = confirming;
  }, [confirming]);
  const expired = entry.state === 'expired';
  const inForce = current
    ? [
        current.provenance === 'proxy' ? 'The model’s answer' : 'Your answer from another device',
        (current.content as Content)?.selected_option_ids
          ?.map((id) => `“${optionLabel(view, id)}”`)
          .join(', '),
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  const reason = expired
    ? 'The question expired before your answer reached your relay.'
    : entry.refusedAt === 'image' && entry.errorCode === 'payload_too_large'
      ? 'This question can’t take more photos.'
      : entry.refusedAt === 'image' && entry.state === 'rejected'
        ? 'Your relay refused its photos.'
        : current
          ? `${inForce}${inForce.includes(',') ? ',' : ''} was saved first at ${momentLabel(current.createdAt, now)}. Nothing was overwritten.`
          : 'The question changed before your answer arrived.';
  const labels = entry.selected.map((id) => optionLabel(view, id));
  const plain = [labels.join(', '), entry.text.trim()].filter(Boolean).join('\n\n');
  const sentAt = momentLabel(new Date(entry.createdAt).toISOString(), now);
  const hasDecision =
    !!onRetry ||
    (!expired && (canCorrect || !!onKeepCurrent || (!!onSendAsFollowUp && !canCorrect)));
  return (
    <section className="conflict" aria-labelledby="ws-conflict-h" id="ws-conflict">
      {/* Only the explanation is the alert, so the actions changing below it never re-announce the whole card. */}
      <div className="callout warn" role="alert">
        <WarningIcon size={16} />
        <div>
          <h2 id="ws-conflict-h" className="callout-title">
            Your answer was not applied
          </h2>
          <p className="callout-text">{reason}</p>
        </div>
      </div>
      <div className="msg out unsent">
        <div className="bubble">
          <span className="sr-only">Your answer, not sent, from {sentAt}: </span>
          {/* Its time, so the person can see their words predate the answer saved first. */}
          <p className="bubble-label" aria-hidden="true">
            Your answer · not sent · {sentAt}
          </p>
          <PhotoGrid view={view} images={entryImages(entry)} />
          {labels.length > 0 && <p className="answer-choice">{labels.join(', ')}</p>}
          {entry.text.trim() && <SafeText text={entry.text} className="answer-text" />}
        </div>
        {confirming ? (
          <div
            key="confirm"
            className="conflict-actions confirm"
            role="group"
            aria-labelledby={askId}
          >
            <p className="conflict-ask" id={askId}>
              Remove your unsent words from this device?
            </p>
            <button
              ref={keepRef}
              type="button"
              className="btn small"
              onClick={() => setConfirming(false)}
            >
              Keep them
            </button>
            <button type="button" className="btn small danger" onClick={onDismiss}>
              Discard
            </button>
          </div>
        ) : (
          <div key="actions" className="conflict-actions">
            {onRetry && (
              <button type="button" className="btn small" onClick={onRetry}>
                <RefreshIcon size={16} />
                Try again
              </button>
            )}
            {canCorrect && !expired && (
              <button
                type="button"
                className="btn small"
                aria-disabled={keepBusy || undefined}
                onClick={() => !keepBusy && onUseAsCorrection()}
              >
                Use as correction
              </button>
            )}
            {onKeepCurrent && !expired && (
              <button
                type="button"
                className="btn small"
                aria-disabled={keepBusy || undefined}
                onClick={() => !keepBusy && onKeepCurrent()}
              >
                {keepBusy ? 'Confirming…' : 'Confirm model answer'}
              </button>
            )}
            {onSendAsFollowUp && !expired && !canCorrect && (
              <button type="button" className="btn small" onClick={onSendAsFollowUp}>
                Send as a follow-up
              </button>
            )}
            {/* The utilities break onto their own line, under the decisions. */}
            {hasDecision && <span className="conflict-break" aria-hidden="true" />}
            {plain && <CopyButton text={plain} quiet />}
            <button
              ref={discardRef}
              type="button"
              className="btn small ghost"
              onClick={() => (dismissDiscards ? setConfirming(true) : onDismiss())}
            >
              {dismissDiscards ? 'Discard' : 'Dismiss'}
            </button>
          </div>
        )}
      </div>
      {keepError && (
        <p className="status error conflict-error" role="alert">
          {keepError}
        </p>
      )}
      {note && (
        <p className="callout-text conflict-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
