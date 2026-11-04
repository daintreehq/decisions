import type { ReactNode } from 'react';
import { app } from '../../app/controller.js';
import type { ActionView, QuestionView } from '../../domain/model.js';
import { answerSummary, correctionCount, optionLabels } from '../../domain/lists.js';
import { currentAnswer, effectiveStatus } from '../../domain/selectors.js';
import { previewText } from '../../lib/safe-text.js';
import { SafeText } from '../SafeText.js';

/**
 * A question's activity, newest decision first in a summary and then the whole story in order: asked, model
 * answer, your answer, confirmation, corrections (old → new, with the reason), expiry or withdrawal. Each answer
 * starts a revision, drawn as a clear boundary, and carries its delivery milestones collapsed underneath.
 *
 * Self-contained (it reads only the view, the clock and the store's desktop receipt), so the History record and
 * the workspace's "View activity" sheet can both mount it.
 */

const ANSWERING = new Set(['answer', 'override', 'proxy-answer']);

function when(iso: string, now: number): string {
  const d = new Date(iso);
  const n = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === n.toDateString()) return `Today, ${time}`;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  const date = d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/** "Keep Canopy — Canopy is the brand name", for a single action. */
function actionLine(v: QuestionView, a: ActionView): string {
  const labels = optionLabels(v, a).join(', ');
  const note = (a.content?.text ?? '').replace(/\s+/g, ' ').trim();
  return [labels, note].filter(Boolean).join(' — ') || 'No note';
}

function Answer({ v, a }: { v: QuestionView; a: ActionView }) {
  const labels = optionLabels(v, a);
  const text = a.content?.text?.trim();
  return (
    <div className="tl-answer">
      {labels.length > 0 && <p className="tl-choice">{labels.join(', ')}</p>}
      {text && <SafeText text={text} className="tl-note" />}
      {!labels.length && !text && <p className="tl-note muted">No note</p>}
    </div>
  );
}

type Tick = 'done' | 'warn' | 'wait';

function Delivery({ v, a }: { v: QuestionView; a: ActionView }) {
  if (a.provenance === 'proxy') return null;
  const d = v.deliveries[a.revision];
  const received = (app.store?.desktopAckSeq ?? 0) >= a.seq || d?.status === 'terminal-delivered';
  const steps: { label: string; tick: Tick }[] = [
    { label: 'Saved on your relay', tick: 'done' },
    {
      label: received ? 'Received by your computer' : 'Not yet received by your computer',
      tick: received ? 'done' : 'wait',
    },
  ];
  if (d?.status === 'terminal-delivered')
    steps.push({ label: 'Typed into the terminal', tick: 'done' });
  else if (d?.status === 'needs-attention')
    steps.push({ label: 'Needs attention on your computer', tick: 'warn' });
  else if (d?.status === 'delivery-uncertain')
    steps.push({ label: 'Delivery couldn’t be confirmed', tick: 'warn' });
  else if (received) steps.push({ label: 'Not yet typed into the terminal', tick: 'wait' });
  const last = steps[steps.length - 1]!;
  return (
    <details className="tl-delivery">
      <summary>
        <span className="tl-delivery-label">Delivery</span>
        <span className={last.tick === 'warn' ? 'tl-delivery-state warn' : 'tl-delivery-state'}>
          {last.label}
        </span>
      </summary>
      <ol className="tl-steps" aria-label="Delivery milestones">
        {steps.map((s) => (
          <li key={s.label} data-tick={s.tick}>
            <span className="tl-tick" aria-hidden="true" />
            {s.label}
            <span className="sr-only">
              {s.tick === 'done'
                ? ' (done)'
                : s.tick === 'warn'
                  ? ' (needs attention)'
                  : ' (waiting)'}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

interface Entry {
  key: string;
  kind: string;
  at: string;
  title: ReactNode;
  body?: ReactNode;
  /** Starts a new revision, labelled. */
  revision?: string;
}

function entries(v: QuestionView, now: number): Entry[] {
  const out: Entry[] = [
    {
      key: 'asked',
      kind: 'asked',
      at: v.createdAt,
      title: 'Asked by your agent',
      body:
        v.requirement === 'human-required' ? (
          <p className="tl-sub">Human decision required</p>
        ) : undefined,
    },
  ];
  const current = currentAnswer(v);
  let prev: ActionView | null = null;
  let answers = 0;
  for (const a of v.actions) {
    if (!a.verified) {
      out.push({
        key: a.actionId,
        kind: 'invalid',
        at: a.createdAt,
        title: 'An action could not be verified and was ignored',
      });
      continue;
    }
    if (ANSWERING.has(a.action)) {
      answers++;
      const isCurrent = a === current;
      const revision = `Revision ${answers}${isCurrent ? ' · current' : ''}`;
      if (a.action === 'override') {
        out.push({
          key: a.actionId,
          kind: 'correction',
          at: a.createdAt,
          revision,
          title: 'You changed the answer',
          body: (
            <>
              <p className="tl-change">
                <span className="tl-old">
                  {prev ? previewText(actionLine(v, prev), 160) : 'Earlier answer'}
                </span>
                <span className="tl-arrow" aria-label="changed to">
                  →
                </span>
                <span className="tl-new">{previewText(actionLine(v, a), 160)}</span>
              </p>
              {a.content?.reason && (
                <div className="tl-reason">
                  <span className="tl-reason-label">Reason</span>
                  <SafeText text={a.content.reason} />
                </div>
              )}
              <Delivery v={v} a={a} />
            </>
          ),
        });
      } else {
        const model = a.action === 'proxy-answer';
        const conf = model && a.content && 'confidence' in a.content ? a.content.confidence : null;
        out.push({
          key: a.actionId,
          kind: model ? 'model' : 'answer',
          at: a.createdAt,
          revision,
          title: model ? 'The decision model answered' : 'You answered',
          body: (
            <>
              <Answer v={v} a={a} />
              {conf !== null && (
                <p className="tl-sub">Model-reported confidence {Math.round(conf * 100)}%</p>
              )}
              <Delivery v={v} a={a} />
            </>
          ),
        });
      }
      prev = a;
      continue;
    }
    if (a.action === 'proxy-abstain')
      out.push({
        key: a.actionId,
        kind: 'abstain',
        at: a.createdAt,
        title: 'The decision model left it to you',
      });
    else if (a.action === 'confirm-proxy')
      out.push({
        key: a.actionId,
        kind: 'confirm',
        at: a.createdAt,
        title: 'You confirmed the model answer',
        body: a.content?.reason ? (
          <SafeText text={a.content.reason} className="tl-note" />
        ) : undefined,
      });
    else if (a.action === 'cancel')
      out.push({
        key: a.actionId,
        kind: 'withdrawn',
        at: a.createdAt,
        title: 'Withdrawn by your agent',
      });
    else if (a.action === 'reopen')
      out.push({
        key: a.actionId,
        kind: 'reopen',
        at: a.createdAt,
        title: 'Reopened by your agent',
      });
  }
  if (effectiveStatus(v, now) === 'expired' && v.expiresAt)
    out.push({
      key: 'expired',
      kind: 'expired',
      at: v.expiresAt,
      title: 'Expired without an answer',
    });
  return out;
}

function Summary({ v, now }: { v: QuestionView; now: number }) {
  const s = effectiveStatus(v, now);
  const a = currentAnswer(v);
  const sum = answerSummary(v);
  const changes = correctionCount(v);
  if (!a || !sum) {
    const closed =
      s === 'expired'
        ? 'Expired without an answer'
        : s === 'cancelled'
          ? 'Withdrawn by your agent'
          : s === 'open'
            ? 'Not answered yet'
            : 'No answer this device can show';
    return (
      <div className="activity-summary">
        <p className="eyebrow">Outcome</p>
        <p className="summary-closed">{closed}</p>
      </div>
    );
  }
  const author =
    sum.author === 'You'
      ? 'Your answer'
      : sum.confirmed
        ? 'Model answer, confirmed by you'
        : 'Model answer · review';
  return (
    <div className="activity-summary">
      <p className="eyebrow">Current answer</p>
      <Answer v={v} a={a} />
      <p className="summary-meta">
        <span className={sum.author === 'Model' ? 'by model' : 'by'}>{author}</span>
        <span>{when(a.createdAt, now)}</span>
        {changes > 0 && <span>Changed {changes === 1 ? 'once' : `${changes} times`}</span>}
      </p>
    </div>
  );
}

export function ActivityTimeline({ view, now = Date.now() }: { view: QuestionView; now?: number }) {
  const list = entries(view, now);
  return (
    <section className="activity" aria-label="Activity">
      <Summary v={view} now={now} />
      <h3 className="eyebrow activity-h">Activity</h3>
      <ol className="timeline">
        {list.map((e) => (
          <li key={e.key} className="tl-item" data-kind={e.kind}>
            {e.revision && <p className="tl-rev">{e.revision}</p>}
            <div className="tl-row">
              <span className="tl-dot" aria-hidden="true" />
              <div className="tl-body">
                <p className="tl-title">
                  <span>{e.title}</span>
                  <time dateTime={e.at}>{when(e.at, now)}</time>
                </p>
                {e.body}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
