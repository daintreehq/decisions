import type { ReactNode } from 'react';
import { app } from '../../app/controller.js';
import type { ActionView, QuestionView, ThreadMessage } from '../../domain/model.js';
import { answerSummary, correctionCount, decidedAt, optionLabels } from '../../domain/lists.js';
import {
  agentName,
  answerBy,
  currentAnswer,
  deadlinePhase,
  deadlineWords,
  declineBy,
  declinedLabel,
  effectiveStatus,
  followUpBy,
  pastExpiryTitle,
  withdrawnLabel,
} from '../../domain/selectors.js';
import { previewText } from '../../lib/safe-text.js';
import { SuccessIcon, WarningIcon } from '../Icons.js';
import { SafeText } from '../SafeText.js';

/**
 * A question's activity: the outcome first (the answer in force, who gave it, when it was decided, and whether its
 * delivery needs a look), then the whole story in order: asked, model answer, your answer, confirmation, corrections
 * (old → new, with the reason), follow-up messages, expiry or withdrawal. Each answer starts a revision, drawn as a
 * labelled boundary across one continuous thread, and carries its delivery milestones collapsed underneath. A
 * message is never a revision: it sits on the thread as something said, not something decided.
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
interface Step {
  label: string;
  tick: Tick;
}

/** Where an answer has reached, as evidence: each stage a separate claim (redesign.md §1.4 rule 11). */
function deliverySteps(v: QuestionView, a: ActionView): Step[] | null {
  if (a.provenance === 'proxy') return null;
  const d = v.deliveries[a.revision];
  const received = (app.store?.desktopAckSeq ?? 0) >= a.seq || d?.status === 'terminal-delivered';
  const steps: Step[] = [
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
  return steps;
}

/** A follow-up's own evidence: the answer's receipt never stands in for a message's. */
function messageSteps(m: ThreadMessage): Step[] {
  const st = m.delivery?.status;
  const received = !!st && st !== 'relay-queued';
  const steps: Step[] = [
    { label: 'Saved on your relay', tick: 'done' },
    {
      label: received ? 'Received by your computer' : 'Not yet received by your computer',
      tick: received ? 'done' : 'wait',
    },
  ];
  if (st === 'terminal-delivered') steps.push({ label: 'Typed into the terminal', tick: 'done' });
  else if (st === 'needs-attention')
    steps.push({ label: 'Needs attention on your computer', tick: 'warn' });
  else if (st === 'delivery-uncertain')
    steps.push({ label: 'Delivery couldn’t be confirmed', tick: 'warn' });
  else if (received) steps.push({ label: 'Not yet typed into the terminal', tick: 'wait' });
  return steps;
}

/** The warning glyph, amber, with the words beside it in ordinary ink (status colour sits on the glyph). */
function Warn({ children }: { children: ReactNode }) {
  return (
    <span className="tl-warn">
      <span className="tl-warn-glyph" aria-hidden="true">
        <WarningIcon size={14} />
      </span>
      {children}
    </span>
  );
}

function Delivery({ steps }: { steps: Step[] | null }) {
  if (!steps) return null;
  const last = steps[steps.length - 1]!;
  return (
    <details className="tl-delivery">
      <summary>
        <span className="tl-delivery-label">Delivery</span>
        <span className="sr-only">: </span>
        <span className="tl-delivery-state">
          {last.tick === 'warn' ? <Warn>{last.label}</Warn> : last.label}
        </span>
      </summary>
      <ol className="tl-steps" aria-label="Delivery milestones">
        {steps.map((s) => (
          <li key={s.label} data-tick={s.tick}>
            {s.tick === 'warn' ? (
              <span className="tl-glyph warn" aria-hidden="true">
                <WarningIcon size={14} />
              </span>
            ) : s.tick === 'done' ? (
              <span className="tl-glyph done" aria-hidden="true">
                <SuccessIcon size={14} />
              </span>
            ) : (
              <span className="tl-tick" aria-hidden="true" />
            )}
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
  /** Said or done by the person (a follow-up), so its mark is filled. */
  mine?: boolean;
}

function messageEntry(v: QuestionView, m: ThreadMessage): Entry {
  const by = followUpBy(m);
  const mine = !!by;
  const photos = m.images.length;
  return {
    key: `m-${m.messageId}`,
    kind: 'message',
    mine,
    at: m.createdAt,
    title: by
      ? by.computer
        ? `You sent a follow-up on ${by.computer}`
        : 'You sent a follow-up'
      : `${agentName(v)} replied`,
    body: (
      <>
        {m.text.trim() && <SafeText text={m.text} className="tl-message" />}
        {photos > 0 && (
          <p className="tl-sub">{photos === 1 ? 'With a photo' : `With ${photos} photos`}</p>
        )}
        {mine && <Delivery steps={messageSteps(m)} />}
      </>
    ),
  };
}

/** This device's answer that the relay has accepted, though the thread hasn't read it back yet. */
const answerAccepted = (v: QuestionView): boolean =>
  (app.outbox?.forQuestion(v.id) ?? []).some(
    (e) =>
      e.kind !== 'message' &&
      e.kind !== 'decline' &&
      e.state === 'committed' &&
      !v.actions.some((a) => a.actionId === e.recordId),
  );

function entries(v: QuestionView, now: number): Entry[] {
  const out: Entry[] = [
    {
      key: 'asked',
      kind: 'asked',
      at: v.createdAt,
      title: 'Asked by your agent',
      // Only a verified question's requirement is known: an unreadable one has a placeholder, and saying it waits for
      // a person would be a claim nothing signed. An advisory question never waits for one (docs/protocol.md section
      // 21): it says what its agent planned to do without an answer instead.
      body: !v.verification.ok ? undefined : v.replyMode === 'advisory' &&
        v.content?.planned_fallback ? (
        <>
          <p className="tl-sub">If no answer came in time, your agent planned to:</p>
          <SafeText text={v.content.planned_fallback} className="tl-note" />
        </>
      ) : v.requirement === 'human-required' ? (
        <p className="tl-sub">Human decision required</p>
      ) : undefined,
    },
  ];
  const current = currentAnswer(v);
  let prev: ActionView | null = null;
  let answers = 0;
  // Actions and messages share the ledger's order; a message lands between the decisions it came between. A human
  // message is listed only as the person's (`followUpBy`), never as anything else.
  const messages = v.messages.filter(
    (m) => m.verified && (m.side === 'agent' || followUpBy(m) !== null),
  );
  let mi = 0;
  let ei = 0;
  // Messages, and the rounds the relay expired, that came before `beforeSeq`, in ledger order.
  const flushMessages = (beforeSeq: number) => {
    for (;;) {
      const m = messages[mi];
      const e = v.expiries[ei];
      const next = Math.min(m?.seq ?? Infinity, e?.seq ?? Infinity);
      if (next >= beforeSeq) return;
      if (m && m.seq === next) out.push(messageEntry(v, messages[mi++]!));
      else if (e) {
        out.push({
          key: `expiry:${e.seq}`,
          kind: 'expired',
          at: e.at,
          title: pastExpiryTitle(v, e),
        });
        ei++;
      }
    }
  };
  for (const a of v.actions) {
    flushMessages(a.seq);
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
        const before = prev ? previewText(actionLine(v, prev), 400) : 'Earlier answer';
        out.push({
          key: a.actionId,
          kind: 'correction',
          at: a.createdAt,
          revision,
          title: 'You changed the answer',
          body: (
            <>
              <p className="tl-change">
                <span className="sr-only">Changed from </span>
                <del className="tl-old">{before}</del>{' '}
                <span className="tl-to">
                  <span className="tl-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="sr-only"> to </span>
                  <ins className="tl-new">{previewText(actionLine(v, a), 400)}</ins>
                </span>
              </p>
              {a.content?.reason && (
                <div className="tl-reason">
                  <span className="tl-reason-label">Reason</span>
                  <SafeText text={a.content.reason} />
                </div>
              )}
              <Delivery steps={deliverySteps(v, a)} />
            </>
          ),
        });
      } else {
        const model = a.action === 'proxy-answer';
        const conf = model && a.content && 'confidence' in a.content ? a.content.confidence : null;
        const computer = answerBy(a).computer;
        out.push({
          key: a.actionId,
          kind: model ? 'model' : 'answer',
          at: a.createdAt,
          revision,
          title: model ? 'Model answer' : computer ? `You answered on ${computer}` : 'You answered',
          body: (
            <>
              <Answer v={v} a={a} />
              {conf !== null && (
                <p className="tl-sub">Model-reported confidence {Math.round(conf * 100)}%</p>
              )}
              <Delivery steps={deliverySteps(v, a)} />
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
    else if (a.action === 'cancel') {
      const declined = declineBy(a);
      out.push({
        key: a.actionId,
        kind: declined ? 'declined' : 'withdrawn',
        at: a.createdAt,
        title: declined ? declined.label : withdrawnLabel(v),
      });
    } else if (a.action === 'reopen')
      out.push({
        key: a.actionId,
        kind: 'reopen',
        at: a.createdAt,
        title: 'Reopened by your agent',
      });
  }
  flushMessages(Number.POSITIVE_INFINITY);
  // Passed by this device's clock only: the relay hasn't said how the round ended, so this is no outcome yet. Nothing
  // is said once the relay has accepted this device's answer: it refuses a late one.
  if (
    effectiveStatus(v, now) === 'expired' &&
    deadlinePhase(v, now) === 'passed-here' &&
    !answerAccepted(v) &&
    v.expiresAt
  )
    out.push({
      key: 'deadline:here',
      kind: 'expired',
      at: v.expiresAt,
      title: 'The deadline passed on this phone',
    });
  return out;
}

function Summary({ v, now }: { v: QuestionView; now: number }) {
  const s = effectiveStatus(v, now);
  const a = currentAnswer(v);
  const sum = answerSummary(v);
  const changes = correctionCount(v);
  if (!a || !sum) {
    // This device's answer the relay has accepted, not yet read back: before or after this phone's deadline, it won.
    const accepted =
      (s === 'open' || (s === 'expired' && deadlinePhase(v, now) === 'passed-here')) &&
      answerAccepted(v);
    const closed = accepted
      ? 'Your relay accepted your answer. It shows here once this device reads it back.'
      : s === 'expired'
        ? (deadlineWords(v, now)?.title ?? 'Expired without an answer')
        : s === 'cancelled'
          ? (declinedLabel(v) ?? withdrawnLabel(v))
          : s === 'open'
            ? 'Not answered yet'
            : 'No answer this device can show';
    const at = !accepted && (s === 'expired' || s === 'cancelled') ? decidedAt(v, now) : null;
    return (
      <div className="activity-summary">
        <h3 className="eyebrow summary-h">Outcome</h3>
        <p className="summary-closed">{closed}</p>
        {at && (
          <p className="summary-meta">
            <span>{when(at, now)}</span>
          </p>
        )}
      </div>
    );
  }
  const model = sum.model;
  const author = !model
    ? answerBy(a).subject
    : sum.confirmed
      ? 'Model answer, confirmed by you'
      : 'Model answer, not yet reviewed';
  // When it was decided: a person's answer or correction when it was given, a confirmed model answer when it was
  // confirmed (the model's own time stays on its timeline event).
  const at = decidedAt(v, now);
  const steps = deliverySteps(v, a);
  const issue = steps?.find((st) => st.tick === 'warn');
  return (
    <div className="activity-summary">
      <h3 className="eyebrow summary-h">Current answer</h3>
      <Answer v={v} a={a} />
      <p className="summary-meta">
        <span className={model ? 'by model' : 'by'}>{author}</span> <span>{when(at, now)}</span>{' '}
        {changes > 0 && <span>Changed {changes === 1 ? 'once' : `${changes} times`}</span>}
      </p>
      {issue && (
        <p className="summary-issue">
          <Warn>{issue.label}</Warn>
        </p>
      )}
    </div>
  );
}

export function ActivityTimeline({ view, now = Date.now() }: { view: QuestionView; now?: number }) {
  const list = entries(view, now);
  return (
    <section className="activity">
      <Summary v={view} now={now} />
      <h3 className="eyebrow activity-h">Activity</h3>
      <ol className="timeline">
        {list.map((e) => (
          <li
            key={e.key}
            className="tl-item"
            data-kind={e.kind}
            data-revision={e.revision ? '' : undefined}
            data-mine={e.mine ? '' : undefined}
          >
            {e.revision && <p className="tl-rev">{e.revision}</p>}
            <div className="tl-row">
              <span className="tl-dot" aria-hidden="true" />
              <div className="tl-body">
                <p className="tl-title">
                  <span>{e.title}</span> <time dateTime={e.at}>{when(e.at, now)}</time>
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
