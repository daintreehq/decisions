import {
  DELIVERY_DONE_LABELS,
  DELIVERY_LABELS,
  type DeliveryProgress as Progress,
  type DeliveryStep,
} from '../domain/selectors.js';
import type { ActionView, QuestionView } from '../domain/model.js';
import { ageLabel, absoluteLabel } from '../lib/time.js';
import { SafeText } from './SafeText.js';
import type { HumanAnswerContentV1, ProxyAnswerContentV1 } from '@daintree/decisions-protocol';

const PHONE_ORDER: DeliveryStep[] = ['queued', 'sending', 'confirmed', 'desktop', 'terminal'];
/** An answer made on the computer (the decision model's) never passed through this phone. */
const RELAY_ORDER: DeliveryStep[] = ['confirmed', 'desktop', 'terminal'];

export function DeliveryProgress({
  progress,
  fromPhone = true,
}: {
  progress: Progress;
  fromPhone?: boolean;
}) {
  if (progress.step === 'attention') {
    return (
      <div className="card warn" role="status">
        <strong>{progress.label}</strong>
        <p>
          The answer is saved on your relay, but Daintree could not confirm it reached the agent
          {progress.detail ? ` (${progress.detail})` : ''}. Open Daintree on your computer to see
          what happened.
        </p>
      </div>
    );
  }
  const order = fromPhone ? PHONE_ORDER : RELAY_ORDER;
  const idx = order.indexOf(progress.step);
  const finished = progress.step === 'terminal';
  return (
    <section className="delivery" aria-labelledby="delivery-h">
      <h2 id="delivery-h">Delivery</h2>
      <ol className="progress" aria-label="Delivery progress">
        {order.map((s, i) => {
          const done = i < idx || (finished && i === idx);
          return (
            <li
              key={s}
              className={`${done ? 'done' : ''} ${i === idx ? 'current' : ''}`.trim()}
              aria-current={i === idx ? 'step' : undefined}
            >
              {i < idx ? (DELIVERY_DONE_LABELS[s] ?? DELIVERY_LABELS[s]) : DELIVERY_LABELS[s]}
              {i > idx && <span className="sr-only"> (not yet)</span>}
            </li>
          );
        })}
      </ol>
      <p className="sr-only" role="status">
        {DELIVERY_LABELS[progress.step]}
      </p>
    </section>
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
  now,
  error,
  confirmedAt,
  onConfirm,
  onOverrule,
}: {
  view: QuestionView;
  a: ActionView;
  busy: boolean;
  now?: number;
  /** Why the last Confirm failed, if it did. */
  error?: string | null;
  /** When the owner confirmed this answer, if they have. */
  confirmedAt?: string | null;
  onConfirm?: () => void;
  onOverrule?: () => void;
}) {
  const c = a.content as ProxyAnswerContentV1;
  const pct = Math.round((c.confidence ?? 0) * 100);
  return (
    <section className="card proxy" aria-label="Answer from the decision model">
      <header>
        <span className="badge proxy">Answered by decision model</span>
        <span className="muted" title={absoluteLabel(a.createdAt)}>
          {ageLabel(a.createdAt, now)}
        </span>
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
        <details className="proxy-rationale">
          <summary>Why it chose this</summary>
          <SafeText text={c.rationale} />
        </details>
      )}
      {confirmedAt ? (
        <p className="note">
          <strong>You confirmed this answer</strong> {ageLabel(confirmedAt, now)}.
        </p>
      ) : (
        <p className="note">
          This is not your decision yet. The decision model answers without waiting for you, so your
          agent may already be acting on it. Confirm it, or overrule it to send a correction.
        </p>
      )}
      {(onConfirm || onOverrule) && (
        <div className="row">
          {onConfirm && (
            <button type="button" className="btn primary" disabled={busy} onClick={onConfirm}>
              Confirm
            </button>
          )}
          {onOverrule && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              data-reopen-correction=""
              onClick={onOverrule}
            >
              Overrule…
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="note error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function HumanAnswerCard({ view, a }: { view: QuestionView; a: ActionView }) {
  return (
    <section className="card answered" aria-label="Your answer">
      <header>
        <span className="badge human">
          {a.action === 'override' ? 'Your corrected answer' : 'Answered by you'}
        </span>
        <span className="muted" title={absoluteLabel(a.createdAt)}>
          {ageLabel(a.createdAt)}
        </span>
      </header>
      <AnswerSummary view={view} a={a} />
    </section>
  );
}
