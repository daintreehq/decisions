import { useId, useState } from 'react';
import type { HumanAnswerContentV1, ProxyAnswerContentV1 } from '@daintreehq/decisions-protocol';
import type { ActionView, QuestionView } from '../../domain/model.js';
import type { OutboxEntry } from '../../data/outbox.js';
import { momentLabel } from '../../lib/time.js';
import { SafeText } from '../SafeText.js';
import { CopyIcon, ModelIcon, WarningIcon } from '../Icons.js';

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
                {current && <span className="option-current"> · Current answer</span>}
              </span>
              {o.description && <SafeText text={o.description} className="option-desc" />}
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

/** A human answer in force, as a read-only card with its author and time. */
export function AnswerCard({ view, a, now }: { view: QuestionView; a: ActionView; now: number }) {
  return (
    <section className="answer-card" aria-labelledby="ws-answer-h" id="ws-answer">
      <header>
        <h2 id="ws-answer-h" className="eyebrow">
          {a.action === 'override' ? 'Your corrected answer' : 'Your answer'}
        </h2>
        <span className="answer-when">{momentLabel(a.createdAt, now)}</span>
      </header>
      <AnswerBody view={view} content={a.content as Content} />
    </section>
  );
}

/**
 * The decision model's answer. Provenance stays visible (violet, always with the words "Model answer"); confirming
 * records an endorsement and never rewrites who authored it.
 */
export function ModelAnswerCard({
  view,
  a,
  now,
  confirmedAt,
  review,
}: {
  view: QuestionView;
  a: ActionView;
  now: number;
  confirmedAt: string | null;
  review: boolean;
}) {
  const c = a.content as ProxyAnswerContentV1;
  const pct = Math.round((c.confidence ?? 0) * 100);
  return (
    <section className="answer-card model" aria-labelledby="ws-answer-h" id="ws-answer">
      <header>
        <h2 id="ws-answer-h" className="model-label">
          <ModelIcon size={12} />
          {confirmedAt
            ? `Model answer, confirmed by you · ${momentLabel(confirmedAt, now)}`
            : 'Model answer'}
        </h2>
        {!confirmedAt && <span className="answer-when">{momentLabel(a.createdAt, now)}</span>}
      </header>
      <AnswerBody view={view} content={a.content as Content} />
      <p className="model-meta">
        <span>{c.model_id}</span>
        <span aria-hidden="true"> · </span>
        <span>Model-reported confidence {pct}%</span>
      </p>
      {(c.rationale || c.retrieval_reference_ids.length > 0) && (
        <details className="disclosure">
          <summary>Why the model chose this</summary>
          {c.rationale && <SafeText text={c.rationale} />}
          {c.retrieval_reference_ids.length > 0 && (
            <p className="muted">
              Based on {c.retrieval_reference_ids.length} of your earlier decisions.
            </p>
          )}
        </details>
      )}
      {review && !confirmedAt && (
        <p className="model-note">
          Your agent may already be acting on this. Confirm it, or change it to send a correction.
        </p>
      )}
    </section>
  );
}

/** The answer sealed on this device and on its way, read-only (there is no second Send). */
export function PendingCard({ view, entry }: { view: QuestionView; entry: OutboxEntry }) {
  const labels = entry.selected.map((id) => optionLabel(view, id));
  return (
    <section className="answer-card" aria-labelledby="ws-answer-h" id="ws-answer">
      <header>
        <h2 id="ws-answer-h" className="eyebrow">
          {entry.kind === 'override'
            ? 'Your correction'
            : entry.kind === 'confirm-proxy'
              ? 'Your confirmation'
              : 'Your answer'}
        </h2>
      </header>
      {entry.kind === 'confirm-proxy' ? (
        <p className="answer-text">Confirming the model answer.</p>
      ) : (
        <div className="answer-body">
          {labels.length > 0 && <p className="answer-choice">{labels.join(', ')}</p>}
          {entry.text.trim() && <SafeText text={entry.text} className="answer-text" />}
          {entry.reason.trim() && (
            <p className="answer-reason">
              <span className="eyebrow-inline">Reason</span>{' '}
              <SafeText text={entry.reason} className="inline" />
            </p>
          )}
        </div>
      )}
    </section>
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
export function CopyButton({ text, label = 'Copy text' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <>
      <button
        type="button"
        className="btn small"
        onClick={() => void copy(text).then((ok) => setState(ok ? 'ok' : 'fail'))}
      >
        <CopyIcon size={16} />
        {state === 'ok' ? 'Copied' : label}
      </button>
      {state === 'fail' && (
        <span className="muted" role="status">
          Couldn’t copy. Select the text to copy it.
        </span>
      )}
    </>
  );
}

/**
 * Another device answered first, the question changed, or it expired: show what is in force and what this device
 * tried to send, and keep the unsent words.
 */
export function ConflictCard({
  view,
  entry,
  current,
  now,
  canCorrect,
  onUseAsCorrection,
  onDismiss,
}: {
  view: QuestionView;
  entry: OutboxEntry;
  current: ActionView | null;
  now: number;
  canCorrect: boolean;
  onUseAsCorrection: () => void;
  onDismiss: () => void;
}) {
  const expired = entry.state === 'expired';
  const reason = expired
    ? 'Your answer arrived after the question expired, so it was not applied.'
    : current
      ? 'Another answer was saved first, so yours was not applied. Nothing was overwritten.'
      : 'The question changed before your answer arrived, so it was not applied.';
  const labels = entry.selected.map((id) => optionLabel(view, id));
  const plain = [labels.join(', '), entry.text.trim()].filter(Boolean).join('\n\n');
  return (
    <section className="conflict" role="alert" aria-labelledby="ws-conflict-h" id="ws-conflict">
      <div className="callout warn">
        <WarningIcon size={16} />
        <div>
          <h2 id="ws-conflict-h" className="callout-title">
            Your answer was not applied
          </h2>
          <p className="callout-text">{reason}</p>
        </div>
      </div>
      {current && (
        <div className="conflict-pane">
          <h3 className="eyebrow">
            Current answer · {current.provenance === 'proxy' ? 'Model' : 'You, on another device'} ·{' '}
            {momentLabel(current.createdAt, now)}
          </h3>
          <AnswerBody view={view} content={current.content as Content} />
        </div>
      )}
      <div className="conflict-pane mine">
        <h3 className="eyebrow">Your unsent answer</h3>
        {labels.length > 0 && <p className="answer-choice">{labels.join(', ')}</p>}
        {entry.text.trim() && <SafeText text={entry.text} className="answer-text" />}
      </div>
      <div className="row">
        {plain && <CopyButton text={plain} />}
        {canCorrect && !expired && (
          <button type="button" className="btn small" onClick={onUseAsCorrection}>
            Use as correction
          </button>
        )}
        <button type="button" className="btn small ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
