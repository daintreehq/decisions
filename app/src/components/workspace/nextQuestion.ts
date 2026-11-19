import { app } from '../../app/controller.js';
import type { QuestionView } from '../../domain/model.js';
import { needsYou, sortNeedsYou } from '../../domain/selectors.js';

/**
 * The next question in Needs you order (soonest deadline, then oldest), skipping this one and any with an answer or
 * a dismissal already on its way from this device. Null when nothing else needs you.
 */
export function nextQuestion(
  all: QuestionView[],
  currentId: string,
  now: number,
): QuestionView | null {
  const open = all.filter(
    (v) =>
      v.id !== currentId &&
      needsYou(v, now) &&
      !app.outbox?.pendingState(v.id) &&
      // A dismissal the relay has answered is still on its way until the thread shows how it settled.
      !app.outbox?.declineInFlight(v.id),
  );
  return sortNeedsYou(open, false, now)[0] ?? null;
}
