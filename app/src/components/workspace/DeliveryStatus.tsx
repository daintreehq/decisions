import {
  DELIVERY_LABELS,
  type DeliveryProgress,
  type DeliveryStep,
} from '../../domain/selectors.js';
import { CheckIcon, WarningIcon } from '../Icons.js';

/** A step from the phone: queued here, sent, saved on the relay, received by the computer, typed into the terminal. */
const PHONE_ORDER: DeliveryStep[] = ['queued', 'sending', 'confirmed', 'desktop', 'terminal'];
/** An answer made on the computer (the decision model's) never passed through this phone. */
const RELAY_ORDER: DeliveryStep[] = ['confirmed', 'desktop', 'terminal'];
const DONE_LABEL: Partial<Record<DeliveryStep, string>> = {
  queued: 'Queued on this device',
  sending: 'Sent',
};

export function stageTone(p: DeliveryProgress): 'done' | 'progress' | 'attention' {
  if (p.step === 'attention') return 'attention';
  return p.step === 'terminal' ? 'done' : 'progress';
}

/** The compact stage the dock shows: a glyph and the one label the evidence supports. */
export function DeliveryStage({ progress }: { progress: DeliveryProgress }) {
  const tone = stageTone(progress);
  return (
    <span className={`stage ${tone}`}>
      {tone === 'attention' ? (
        <WarningIcon size={16} />
      ) : tone === 'done' ? (
        <span className="stage-glyph done" aria-hidden="true">
          <CheckIcon size={12} />
        </span>
      ) : (
        <span className="stage-glyph" aria-hidden="true" />
      )}
      <span className="stage-label">{progress.label}</span>
    </span>
  );
}

/**
 * The full stepper. Done steps carry a check and their words, the live step a filled ring, steps not reached an
 * empty one. It never claims the agent finished or acted, only where the answer has reached.
 */
export function DeliveryStepper({
  progress,
  fromPhone,
}: {
  progress: DeliveryProgress;
  fromPhone: boolean;
}) {
  if (progress.step === 'attention') {
    return (
      <div className="callout warn" role="status">
        <WarningIcon size={16} />
        <div>
          <strong>{progress.label}</strong>
          <p className="callout-text">
            Your answer is saved on your relay, but your computer could not confirm it reached the
            agent{progress.detail ? ` (${progress.detail})` : ''}. Open Daintree on your computer to
            see what happened.
          </p>
        </div>
      </div>
    );
  }
  const order = fromPhone ? PHONE_ORDER : RELAY_ORDER;
  const idx = order.indexOf(progress.step);
  const finished = progress.step === 'terminal';
  return (
    <ol className="stepper" aria-label="Delivery progress">
      {order.map((s, i) => {
        const done = i < idx || (finished && i === idx);
        const current = i === idx;
        return (
          <li
            key={s}
            className={`${done ? 'done' : ''} ${current ? 'current' : ''}`.trim() || undefined}
            aria-current={current ? 'step' : undefined}
          >
            <span className="step-mark" aria-hidden="true">
              {done && <CheckIcon size={11} />}
            </span>
            <span>
              {i < idx ? (DONE_LABEL[s] ?? DELIVERY_LABELS[s]) : DELIVERY_LABELS[s]}
              {done && <span className="sr-only"> (done)</span>}
              {i > idx && <span className="sr-only"> (not yet)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
