import { useCallback, useState } from 'react';
import { app } from '../app/controller.js';
import { useApp, useNow } from '../app/hooks.js';
import { AnswerEditor } from '../components/AnswerEditor.js';
import { AttachmentGallery, type ReviewState } from '../components/AttachmentGallery.js';
import { DeliveryProgress, HumanAnswerCard, ProxyCard } from '../components/Cards.js';
import { SafeText } from '../components/SafeText.js';
import { Link } from '../app/router.js';
import {
  currentAnswer,
  deliveryProgress,
  effectiveStatus,
  lastProxyAction,
  originLabel,
  proxyNeedsReview,
  submitKind,
} from '../domain/selectors.js';
import { absoluteLabel, ageLabel, untilLabel } from '../lib/time.js';
import type { OutboxEntry } from '../data/outbox.js';

const NO_REVIEW: ReviewState = { digests: [], total: 0, loaded: 0, expired: 0, failed: 0 };

function Conflict({
  entry,
  view,
}: {
  entry: OutboxEntry;
  view: ReturnType<NonNullable<typeof app.store>['get']> & object;
}) {
  const winner = currentAnswer(view);
  const [copied, setCopied] = useState(false);
  return (
    <section className="card warn" role="alert" aria-label="Answered on another device">
      <strong>
        {entry.state === 'expired' ? 'This question expired' : 'Answered on another device'}
      </strong>
      <p>
        {entry.state === 'expired'
          ? 'Your answer was not applied because the question expired first.'
          : winner
            ? 'Another answer was saved first, so yours was not applied. Nothing was overwritten.'
            : 'The question changed before your answer arrived, so it was not applied.'}
      </p>
      {(entry.text || entry.selected.length > 0) && (
        <div className="draft">
          <p className="muted">Your answer, kept for you:</p>
          {entry.selected.length > 0 && (
            <p className="choice">
              {entry.selected
                .map((id) => view.content?.options.find((o) => o.id === id)?.label ?? id)
                .join(', ')}
            </p>
          )}
          {entry.text && <SafeText text={entry.text} />}
          {entry.text && (
            <button
              type="button"
              className="btn small"
              onClick={() =>
                void navigator.clipboard?.writeText(entry.text).then(() => setCopied(true))
              }
            >
              {copied ? 'Copied' : 'Copy text'}
            </button>
          )}
        </div>
      )}
      <div className="row">
        <button type="button" className="btn" onClick={() => void app.outbox?.discard(entry.id)}>
          Dismiss
        </button>
      </div>
    </section>
  );
}

export function QuestionDetail({ id }: { id: string }) {
  const snap = useApp();
  const now = useNow();
  const [review, setReview] = useState<ReviewState>(NO_REVIEW);
  const [overriding, setOverriding] = useState(false);
  const [busy, setBusy] = useState(false);
  const onReview = useCallback((s: ReviewState) => setReview(s), []);
  void snap.rev;

  const view = app.store?.get(id);
  if (!view || !app.store || !app.outbox) {
    return (
      <div className="empty">
        <h2>{snap.syncing ? 'Loading…' : 'Question not found'}</h2>
        <p>
          {snap.syncing
            ? 'Fetching the latest from your relay.'
            : 'It may have been deleted, or it has not synced yet.'}
        </p>
        <Link to="/" className="btn">
          Back to inbox
        </Link>
      </div>
    );
  }

  const status = effectiveStatus(view, now);
  const entries = app.outbox.forQuestion(id);
  const pending = app.outbox.pendingState(id);
  const failed = entries.filter(
    (e) => e.state === 'conflicted' || e.state === 'rejected' || e.state === 'expired',
  );
  const progress = deliveryProgress(view, app.store, pending);
  const answer = currentAnswer(view);
  const proxy = lastProxyAction(view);
  const kind = submitKind(view, now);
  const verified = view.verification.ok;
  const content = view.content;
  const initial = failed[0] ? { selected: failed[0].selected, text: failed[0].text } : undefined;

  return (
    <article className="detail" aria-labelledby="q-title">
      <header className="detail-head">
        <Link to="/" className="back" aria-label="Back to inbox">
          ‹ Inbox
        </Link>
        <p className="origin">{originLabel(view)}</p>
        <p className="muted" title={absoluteLabel(view.createdAt)}>
          Asked {ageLabel(view.createdAt, now)} · {absoluteLabel(view.createdAt)}
          {view.expiresAt && status === 'open' ? ` · ${untilLabel(view.expiresAt, now)}` : ''}
        </p>
        <p>
          <span className={`badge ${status}`}>{statusLabel(status)}</span>{' '}
          {view.requirement === 'human-required' && (
            <span className="badge strong">Needs a person</span>
          )}
        </p>
      </header>

      {!verified && (
        <section className="card danger" role="alert">
          <strong>Could not verify this question</strong>
          <p>
            It was not signed by a device you trust, or its contents do not match its signature, so
            it cannot be shown or answered.
            {!view.verification.ok && <span className="muted"> ({view.verification.reason})</span>}
          </p>
        </section>
      )}
      {view.integrityIssues.length > 0 && verified && (
        <section className="card warn" role="alert">
          <strong>Some activity could not be verified</strong>
          <ul className="plain">
            {view.integrityIssues.slice(0, 4).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </section>
      )}

      {content && (
        <>
          <h1 id="q-title" className="sr-only">
            Question
          </h1>
          <SafeText text={content.question} className="question" />
          {content.context && (
            <details className="context">
              <summary>Show context</summary>
              <SafeText text={content.context} />
            </details>
          )}
          <AttachmentGallery view={view} onReview={onReview} />
        </>
      )}

      {status === 'expired' && (
        <section className="card warn" role="status">
          <strong>This question expired</strong>
          <p>
            Your agent was told it expired. It will not continue on its own; ask it again from your
            computer if you still need an answer.
          </p>
        </section>
      )}
      {status === 'cancelled' && (
        <section className="card" role="status">
          <strong>Your agent withdrew this question</strong>
        </section>
      )}

      {failed.map((e) => (
        <Conflict key={e.id} entry={e} view={view} />
      ))}

      {answer?.provenance === 'proxy' && proxy ? (
        <ProxyCard
          view={view}
          a={proxy}
          busy={busy}
          onConfirm={
            proxyNeedsReview(view, now)
              ? () => {
                  setBusy(true);
                  void app
                    .submit({
                      view,
                      kind: 'confirm-proxy',
                      expectedRevision: proxy.revision,
                      selected: [],
                      text: '',
                      reviewedDigests: [],
                    })
                    .finally(() => setBusy(false));
                }
              : undefined
          }
          onOverrule={kind === 'override' ? () => setOverriding(true) : undefined}
        />
      ) : answer ? (
        <HumanAnswerCard view={view} a={answer} />
      ) : null}

      {progress && <DeliveryProgress progress={progress} />}

      {verified && content && kind === 'answer' && !pending && (
        <section aria-label="Your answer">
          <AnswerEditor
            key={`${view.id}-answer-${failed[0]?.id ?? ''}`}
            view={view}
            mode="answer"
            review={review}
            initial={initial}
          />
        </section>
      )}
      {verified && content && kind === 'override' && !pending && (
        <section aria-label="Change the answer">
          {overriding ? (
            <AnswerEditor
              key={`${view.id}-override`}
              view={view}
              mode="override"
              review={review}
              onDone={() => setOverriding(false)}
              onCancel={() => setOverriding(false)}
            />
          ) : (
            answer?.provenance !== 'proxy' && (
              <button type="button" className="btn" onClick={() => setOverriding(true)}>
                Change this answer…
              </button>
            )
          )}
        </section>
      )}
      {status === 'open' && view.proxyAbstained && (
        <p className="note">The decision model passed on this one, so it is waiting for you.</p>
      )}
    </article>
  );
}

function statusLabel(s: ReturnType<typeof effectiveStatus>): string {
  switch (s) {
    case 'open':
      return 'Needs you';
    case 'proxy-answered':
      return 'Proxy answered';
    case 'human-answered':
      return 'Answered';
    case 'cancelled':
      return 'Withdrawn';
    case 'expired':
      return 'Expired';
    default:
      return 'Unverified';
  }
}
