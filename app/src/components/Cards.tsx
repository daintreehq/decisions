import {
  DELIVERY_LABELS,
  type DeliveryProgress as Progress,
  type DeliveryStep,
} from '../domain/selectors.js';
import type { ActionView, QuestionView } from '../domain/model.js';
import { ageLabel, absoluteLabel } from '../lib/time.js';
import { SafeText } from './SafeText.js';
import type { HumanAnswerContentV1, ProxyAnswerContentV1 } from '@daintree/decisions-protocol';

const ORDER: DeliveryStep[] = ['queued', 'sending', 'confirmed', 'desktop', 'terminal'];

export function DeliveryProgress({ progress }: { progress: Progress }) {
  if (progress.step === 'attention') {
    return (
      <div className="card warn" role="status">
        <strong>{progress.label}</strong>
        <p>
          Your answer is saved. {progress.detail ? `(${progress.detail}) ` : ''}Open Daintree on
          your computer to see what happened.
        </p>
      </div>
    );
  }
  const idx = ORDER.indexOf(progress.step);
  return (
    <ol className="progress" aria-label="Delivery progress">
      {ORDER.map((s, i) => (
        <li
          key={s}
          className={i < idx ? 'done' : i === idx ? 'current' : ''}
          aria-current={i === idx ? 'step' : undefined}
        >
          {DELIVERY_LABELS[s]}
        </li>
      ))}
    </ol>
  );
}

function optionLabels(view: QuestionView, ids: string[]): string[] {
  return ids.map((id) => view.content?.options.find((o) => o.id === id)?.label ?? id);
}

export function AnswerSummary({ view, a }: { view: QuestionView; a: ActionView }) {
  const c = a.content as (HumanAnswerContentV1 & Partial<ProxyAnswerContentV1>) | null;
  if (!c) return null;
  const labels = optionLabels(view, c.selected_option_ids);
  return (
    <div className="answer-summary">
      {labels.length > 0 && <p className="choice">{labels.join(', ')}</p>}
      {c.text && <SafeText text={c.text} />}
      {c.reason && (
        <p className="note">
          Reason: <SafeText text={c.reason} className="inline" />
        </p>
      )}
    </div>
  );
}

export function ProxyCard({
  view,
  a,
  busy,
  onConfirm,
  onOverrule,
}: {
  view: QuestionView;
  a: ActionView;
  busy: boolean;
  onConfirm?: () => void;
  onOverrule?: () => void;
}) {
  const c = a.content as ProxyAnswerContentV1;
  const pct = Math.round((c.confidence ?? 0) * 100);
  return (
    <section className="card proxy" aria-label="Answer from the decision model">
      <header>
        <span className="badge proxy">Answered by decision model</span>
        <span className="muted">{ageLabel(a.createdAt)}</span>
      </header>
      <AnswerSummary view={view} a={a} />
      <dl className="meta">
        <dt>Model</dt>
        <dd>{c.model_id}</dd>
        <dt>Confidence</dt>
        <dd>
          about {pct}%{' '}
          <span className="muted">(the model’s own estimate, not a measured probability)</span>
        </dd>
        {c.retrieval_reference_ids.length > 0 && (
          <>
            <dt>Based on</dt>
            <dd>{c.retrieval_reference_ids.length} of your earlier decisions</dd>
          </>
        )}
      </dl>
      {c.rationale && (
        <details>
          <summary>Why it chose this</summary>
          <SafeText text={c.rationale} />
        </details>
      )}
      <p className="note">
        This is not your decision yet. The agent has already been told this answer.
      </p>
      {(onConfirm || onOverrule) && (
        <div className="row">
          {onConfirm && (
            <button type="button" className="btn primary" disabled={busy} onClick={onConfirm}>
              Confirm
            </button>
          )}
          {onOverrule && (
            <button type="button" className="btn" disabled={busy} onClick={onOverrule}>
              Overrule…
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function HumanAnswerCard({ view, a }: { view: QuestionView; a: ActionView }) {
  return (
    <section className="card answered" aria-label="Your answer">
      <header>
        <span className="badge human">
          {a.action === 'override' ? 'Your corrected answer' : 'Your answer'}
        </span>
        <span className="muted" title={absoluteLabel(a.createdAt)}>
          {ageLabel(a.createdAt)}
        </span>
      </header>
      <AnswerSummary view={view} a={a} />
    </section>
  );
}
