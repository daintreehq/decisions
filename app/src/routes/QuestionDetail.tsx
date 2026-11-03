import { useCallback, useEffect, useRef, useState } from 'react';
import { app } from '../app/controller.js';
import { useApp, useNow } from '../app/hooks.js';
import { AnswerEditor } from '../components/AnswerEditor.js';
import { AttachmentGallery, type ReviewState } from '../components/AttachmentGallery.js';
import { DeliveryProgress, HumanAnswerCard, ProxyCard } from '../components/Cards.js';
import { SafeText } from '../components/SafeText.js';
import { Link } from '../app/router.js';
import {
  badgeClass,
  currentAnswer,
  deliveryProgress,
  effectiveStatus,
  lastProxyAction,
  proxyNeedsReview,
  statusLabel,
  submitKind,
  unreadableHere,
} from '../domain/selectors.js';
import { ChevronLeft, ClockIcon, Origin, PersonIcon } from '../components/Icons.js';
import { announce } from '../lib/announce.js';
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
    <section
      className="card warn"
      role="alert"
      aria-label={entry.state === 'expired' ? 'Your answer arrived too late' : 'Answer not applied'}
    >
      <strong>
        {entry.state === 'expired'
          ? 'Your answer arrived after the question expired'
          : winner
            ? 'Answered on another device'
            : 'The question changed before your answer arrived'}
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
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const onReview = useCallback((s: ReviewState) => setReview(s), []);
  // Closing a correction puts focus back on the control that opened it.
  const wasOverriding = useRef(false);
  useEffect(() => {
    if (wasOverriding.current && !overriding)
      document.querySelector<HTMLElement>('[data-reopen-correction]')?.focus();
    wasOverriding.current = overriding;
  }, [overriding]);
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
  const open = status === 'open';
  const urgent = open && !!view.expiresAt && Date.parse(view.expiresAt) - now < 24 * 3_600_000;
  const confirmed = view.actions.find((a) => a.verified && a.action === 'confirm-proxy');
  const closedOptions =
    (status === 'expired' || status === 'cancelled') && content ? content.options : [];

  return (
    <article
      className="detail"
      aria-labelledby={content ? 'q-title' : undefined}
      aria-label={
        content
          ? undefined
          : unreadableHere(view)
            ? 'Question this phone cannot read'
            : 'Question that could not be verified'
      }
    >
      <header className="detail-head">
        <Link to="/" className="back">
          <ChevronLeft />
          Questions
        </Link>
        <Origin v={view} as="p" />
        <p className="meta-line">
          <span className="nowrap">Asked {ageLabel(view.createdAt, now)}</span> ·{' '}
          <span className="nowrap">{absoluteLabel(view.createdAt)}</span>
          {open && view.expiresAt && !urgent && (
            <>
              {' '}
              · <span className="nowrap">{untilLabel(view.expiresAt, now, true)}</span>
            </>
          )}
        </p>
        {status === 'expired' && view.expiresAt && (
          <p className="meta-line">Expired {absoluteLabel(view.expiresAt)}</p>
        )}
        <p className="detail-badges">
          {/* An answered question's answer card carries the provenance label; no need to say it twice. */}
          {status !== 'human-answered' && status !== 'proxy-answered' && (
            <span className={`badge ${badgeClass(status, view)}`}>{statusLabel(status, view)}</span>
          )}
          {open && view.requirement === 'human-required' && (
            <span className="badge req">
              <PersonIcon />
              Needs a person
            </span>
          )}
          {urgent && (
            <span className="badge warn">
              <ClockIcon />
              {untilLabel(view.expiresAt!, now, true)}
            </span>
          )}
          {status === 'proxy-answered' && proxyNeedsReview(view, now) && (
            <span className="badge warn">To review</span>
          )}
        </p>
      </header>

      {!verified && unreadableHere(view) && (
        <section className="card">
          <strong>This phone can’t read this question</strong>
          <p>
            It was sealed with a content key this phone was never given, usually because it was
            asked before this phone was paired. Answer it from a device that was paired then, or ask
            your agent to ask again.
          </p>
        </section>
      )}
      {!verified && !unreadableHere(view) && (
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
          {/* The question itself is the page's heading; SafeText keeps it plain text. */}
          <div id="q-title" role="heading" aria-level={1}>
            <SafeText text={content.question} className="question" />
          </div>
          {open && view.proxyAbstained && (
            <p className="note">The decision model passed on this one, so it is waiting for you.</p>
          )}
          {content.context && (
            <details className="context">
              <summary>Context from the agent</summary>
              <SafeText text={content.context} />
            </details>
          )}
          <AttachmentGallery view={view} onReview={onReview} />
        </>
      )}

      {status === 'expired' && (
        <section className="card closed" role="status">
          <strong>This question expired before it was answered</strong>
          <p>
            The time limit passed, so it can no longer be answered from here and nothing was
            approved. If you still want to decide, ask your agent again from your computer.
          </p>
        </section>
      )}
      {status === 'cancelled' && (
        <section className="card closed" role="status">
          <strong>Your agent withdrew this question</strong>
          <p>No answer is needed and nothing was approved here.</p>
        </section>
      )}
      {closedOptions.length > 0 && (
        <>
          <p className="muted">The options were:</p>
          <ul className="closed-options">
            {closedOptions.map((o) => (
              <li key={o.id}>
                {o.label}
                {o.description && <SafeText text={o.description} className="option-desc" />}
              </li>
            ))}
          </ul>
        </>
      )}

      {failed.map((e) => (
        <Conflict key={e.id} entry={e} view={view} />
      ))}

      {answer?.provenance === 'proxy' && proxy ? (
        <ProxyCard
          view={view}
          a={proxy}
          busy={busy}
          now={now}
          error={confirmError}
          confirmedAt={confirmed?.createdAt ?? null}
          onConfirm={
            proxyNeedsReview(view, now) && !overriding
              ? () => {
                  setBusy(true);
                  setConfirmError(null);
                  void app
                    .submit({
                      view,
                      kind: 'confirm-proxy',
                      expectedRevision: proxy.revision,
                      selected: [],
                      text: '',
                      reviewedDigests: [],
                    })
                    .then(() => announce('Your confirmation is being sent.'))
                    .catch((e: unknown) =>
                      setConfirmError(
                        e instanceof Error
                          ? e.message
                          : 'Could not send your confirmation. Try again.',
                      ),
                    )
                    .finally(() => setBusy(false));
                }
              : undefined
          }
          onOverrule={kind === 'override' && !overriding ? () => setOverriding(true) : undefined}
        />
      ) : answer ? (
        <HumanAnswerCard view={view} a={answer} />
      ) : null}

      {verified &&
        content &&
        kind === 'override' &&
        !pending &&
        (overriding || answer?.provenance !== 'proxy') && (
          <section aria-label="Change the answer">
            {overriding ? (
              <AnswerEditor
                key={`${view.id}-override`}
                view={view}
                mode="override"
                review={review}
                current={answer}
                onDone={() => setOverriding(false)}
                onCancel={() => setOverriding(false)}
              />
            ) : (
              answer?.provenance !== 'proxy' && (
                <button
                  type="button"
                  className="btn"
                  data-reopen-correction=""
                  onClick={() => setOverriding(true)}
                >
                  Change this answer…
                </button>
              )
            )}
          </section>
        )}

      {progress && (
        <DeliveryProgress
          progress={progress}
          fromPhone={!!pending || answer?.provenance !== 'proxy'}
        />
      )}

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
    </article>
  );
}
