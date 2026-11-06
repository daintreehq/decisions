import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import {
  DELIVERY_LABELS,
  type DeliveryProgress,
  type DeliveryStep,
} from '../../domain/selectors.js';
import { CheckIcon, ChevronDown, ClockIcon, WarningIcon } from '../Icons.js';

/** A step from the phone: queued here, sent, saved on the relay, received by the computer, typed into the terminal. */
const PHONE_ORDER: DeliveryStep[] = ['queued', 'sending', 'confirmed', 'desktop', 'terminal'];
/** An answer made on the computer (the decision model's) never passed through this phone. */
const RELAY_ORDER: DeliveryStep[] = ['confirmed', 'desktop', 'terminal'];
const DONE_LABEL: Partial<Record<DeliveryStep, string>> = {
  queued: 'Queued on this device',
  sending: 'Sent',
};

/** What the computer reported, in words: why an answer it holds was not typed into the terminal. */
const CAUSES: Record<string, string> = {
  pane_gone: 'The terminal it was asked from has closed.',
  relaunched: 'The agent in that terminal has restarted since it asked.',
  generation_mismatch: 'The agent in that terminal has restarted since it asked.',
  session_mismatch: 'That terminal is running a different agent session now.',
  inject_rejected: 'The terminal refused the text.',
  no_target: 'Your computer couldn’t find the terminal it was asked from.',
  target_mismatch: 'Your computer couldn’t find the terminal it was asked from.',
  answer_unreadable: 'Your computer couldn’t open the answer.',
  message_unreadable: 'Your computer couldn’t open the message.',
};

export function stageTone(p: DeliveryProgress): 'done' | 'progress' | 'attention' {
  if (p.step === 'attention') return 'attention';
  return p.step === 'terminal' ? 'done' : 'progress';
}

/**
 * The receipt's words: short, and only what the evidence supports. "Sending…" stays until the relay has the
 * answer; a problem keeps the stage's own words.
 */
const RECEIPT_LABELS: Record<Exclude<DeliveryStep, 'attention'>, string> = {
  queued: 'Queued on this device',
  sending: 'Sending…',
  confirmed: 'Saved on your relay',
  desktop: 'Received by your computer',
  terminal: DELIVERY_LABELS.terminal,
};

export const receiptLabel = (p: DeliveryProgress): string =>
  p.step === 'attention' ? p.label : RECEIPT_LABELS[p.step];

/**
 * The small receipt under an answer: a glyph and the one short label the evidence supports. The glyph says only
 * whether delivery is still under way (a clock), finished (the success mark) or stopped (the warning mark); the
 * words say how far it has got. Tapping it opens the full stepper underneath. A delivery problem keeps the same line
 * (time, warning mark, its label) and is never hidden behind the tap: its explanation shows beneath at once.
 * `steps={false}` is for replies that are not typed anywhere (a confirmation): no stepper.
 */
export function Receipt({
  progress,
  fromPhone,
  note,
  steps = true,
  subject,
  label: words,
}: {
  progress: DeliveryProgress;
  fromPhone: boolean;
  /** A quiet extra after the label, e.g. that a queued answer sends once back online. */
  note?: string;
  steps?: boolean;
  /** What is being delivered, for the words of a problem: "Your answer" (default), "Your follow-up". */
  subject?: string;
  /** Words for a stage the steps don't name, such as photos still uploading before the answer can go. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const tone = stageTone(progress);
  // A problem replaces the receipt's button with a plain line. If the button had focus, hand it to that line
  // rather than letting it fall to the page; otherwise leave focus where the person put it.
  const focused = useRef(false);
  const summaryRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (tone === 'attention' && focused.current) summaryRef.current?.focus({ preventScroll: true });
  }, [tone]);
  const track = {
    onFocus: () => (focused.current = true),
    onBlur: (e: FocusEvent) => {
      if (e.relatedTarget) focused.current = false;
    },
  };
  const label = words ?? receiptLabel(progress);
  // The receipt itself stays quiet; this one status says the milestones that matter (saved, typed, a problem) when
  // they change, never the steps in between. It is mounted with the receipt, so an old reply announces nothing.
  const milestone =
    tone !== 'progress' || progress.step === 'confirmed'
      ? `${subject ?? (fromPhone ? 'Your answer' : 'The model answer')}: ${label}`
      : '';
  const spoken = (
    <span className="sr-only" role="status">
      {milestone}
    </span>
  );
  if (tone === 'attention')
    return (
      <div className="receipt attention" aria-live="off" {...track}>
        {spoken}
        <span className="receipt-button static" ref={summaryRef} tabIndex={-1}>
          <WarningIcon size={14} />
          <span className="receipt-label">
            <span className="sr-only">Delivery: </span>
            {label}
          </span>
        </span>
        <DeliveryStepper progress={progress} fromPhone={fromPhone} subject={subject} untitled />
      </div>
    );
  const face = (
    <>
      {tone === 'done' ? (
        <span className="receipt-glyph done" aria-hidden="true">
          <CheckIcon size={10} />
        </span>
      ) : (
        <ClockIcon size={13} />
      )}
      <span className="receipt-label">
        <span className="sr-only">Delivery: </span>
        {label}
      </span>
    </>
  );
  // A note is its own quiet line under the receipt, so a long one never pushes the receipt past its bubble.
  const noted = note && <span className="receipt-note">{note}</span>;
  if (!steps)
    return (
      <div className={`receipt ${tone}`} aria-live="off">
        {spoken}
        <span className="receipt-button static">{face}</span>
        {noted}
      </div>
    );
  return (
    <div className={`receipt ${tone}`} aria-live="off" {...track}>
      {spoken}
      <button
        type="button"
        className="receipt-button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {face}
        <ChevronDown size={14} />
      </button>
      {noted}
      <div id={id} className="receipt-steps" hidden={!open}>
        {open && <DeliveryStepper progress={progress} fromPhone={fromPhone} subject={subject} />}
      </div>
    </div>
  );
}

/**
 * The full stepper. Reached steps carry a check and their words, the step being waited on a clock, steps not
 * reached an empty ring. It never claims the agent finished or acted, only where the answer has reached.
 */
export function DeliveryStepper({
  progress,
  fromPhone,
  subject: named,
  untitled,
}: {
  progress: DeliveryProgress;
  fromPhone: boolean;
  subject?: string;
  /** The problem's label is already on the receipt line above: the callout carries only the explanation. */
  untitled?: boolean;
}) {
  if (progress.step === 'attention') {
    const subject = named ?? (fromPhone ? 'Your answer' : 'The model answer');
    const uncertain = progress.detail === undefined && progress.label !== DELIVERY_LABELS.attention;
    const cause = progress.detail ? CAUSES[progress.detail] : undefined;
    return (
      // Under a receipt, the receipt's own status announces the problem; the explanation is there to be read.
      <div
        className={`callout warn${untitled ? ' bare' : ''}`}
        role={untitled ? undefined : 'status'}
      >
        {!untitled && <WarningIcon size={16} />}
        <div>
          {/* Under a receipt the label is already on the line above (and said by its status). */}
          {!untitled && <strong className="callout-title">{progress.label}</strong>}
          <p className="callout-text">
            {uncertain
              ? `${subject} is saved on your relay. Your computer can’t tell whether it was typed into the terminal, so it won’t type it again.`
              : `${cause ? `${cause} ` : ''}${subject} is saved on your relay, but it wasn’t typed into the terminal.`}{' '}
            {/* The cause, when known, already says what happened; what's left is where to act on it. */}
            {cause
              ? 'Open Daintree on your computer to decide what to do with it.'
              : 'Open Daintree on your computer to see what happened.'}
          </p>
          {progress.detail && !cause && (
            <p className="callout-code">
              Code <span className="mono">{progress.detail}</span>
            </p>
          )}
        </div>
      </div>
    );
  }
  const order = fromPhone ? PHONE_ORDER : RELAY_ORDER;
  const idx = order.indexOf(progress.step);
  // A step that has been reached is done, except "Sending…", which is still in flight. The step being waited on
  // (the one in flight, or the next one) carries a clock; steps beyond it are empty.
  const inFlight = progress.step === 'sending';
  const waitingAt = inFlight ? idx : progress.step === 'terminal' ? -1 : idx + 1;
  return (
    <ol className="stepper" aria-label="Delivery progress">
      {order.map((s, i) => {
        const done = i < idx || (i === idx && !inFlight);
        const waiting = i === waitingAt;
        const current = i === idx;
        return (
          <li
            key={s}
            className={
              [done && 'done', waiting && 'waiting', current && 'current']
                .filter(Boolean)
                .join(' ') || undefined
            }
            aria-current={current ? 'step' : undefined}
          >
            <span className="step-mark" aria-hidden="true">
              {done ? <CheckIcon size={11} /> : waiting ? <ClockIcon size={14} /> : null}
            </span>
            <span>
              {done
                ? (DONE_LABEL[s] ?? DELIVERY_LABELS[s])
                : // Queued here and offline, nothing is being sent yet: the next step is waiting, not in flight.
                  s === 'sending' && progress.step === 'queued'
                  ? 'Waiting to send'
                  : DELIVERY_LABELS[s]}
              <span className="sr-only">
                {done ? ' (done)' : waiting ? ' (waiting)' : ' (not yet)'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
