import type { ActionKind } from '@daintreehq/decisions-protocol';
import type { ActionView, QuestionStore, QuestionView } from './model.js';
import { NO_EPOCH_KEY } from './verify.js';

export type EffectiveStatus =
  'open' | 'proxy-answered' | 'human-answered' | 'cancelled' | 'expired' | 'unverified';

const ANSWER_KINDS: ActionKind[] = ['answer', 'override', 'proxy-answer'];

export function effectiveStatus(v: QuestionView, now = Date.now()): EffectiveStatus {
  if (!v.verification.ok) return 'unverified';
  // A forged or tampered answer must never be presented as a real decision.
  if (v.actions.some((a) => !a.verified && ANSWER_KINDS.includes(a.action))) return 'unverified';
  if (v.status === 'open' && v.expiresAt && now >= Date.parse(v.expiresAt)) return 'expired';
  return v.status;
}

/** The answer currently in force (last verified answer-bearing action). */
export function currentAnswer(v: QuestionView): ActionView | null {
  for (let i = v.actions.length - 1; i >= 0; i--) {
    const a = v.actions[i]!;
    if (a.verified && ANSWER_KINDS.includes(a.action) && a.content) return a;
  }
  return null;
}

export function lastProxyAction(v: QuestionView): ActionView | null {
  for (let i = v.actions.length - 1; i >= 0; i--) {
    const a = v.actions[i]!;
    if (a.verified && a.action === 'proxy-answer') return a;
  }
  return null;
}

export const needsYou = (v: QuestionView, now = Date.now()): boolean =>
  effectiveStatus(v, now) === 'open';

/** Open questions, plus answered ones whose delivery needs the owner to look at their computer. */
export const needsAction = (v: QuestionView, now = Date.now()): boolean =>
  needsYou(v, now) || deliveryNeedsAttention(v);

/** One display vocabulary for every status, shared by the inbox, the detail page and History. */
/**
 * A correctly signed question this phone holds no key for (typically asked before it was paired): it cannot be
 * shown or answered here, but nothing about it is suspect, so it is never labelled as failing verification.
 */
export const unreadableHere = (v: QuestionView): boolean =>
  !v.verification.ok && v.verification.reason === NO_EPOCH_KEY;

/** What a list row shows in place of a question it cannot display. */
export const hiddenQuestionText = (v: QuestionView): string =>
  unreadableHere(v)
    ? 'Sealed with a key this phone was not given'
    : 'Could not verify this question';

/** The badge's style class: an unreadable question gets the plain neutral chip, never the danger colours. */
export const badgeClass = (s: EffectiveStatus, v: QuestionView): string =>
  s === 'unverified' && unreadableHere(v) ? 'unreadable' : s;

export function statusLabel(s: EffectiveStatus, v?: QuestionView): string {
  if (s === 'unverified' && v && unreadableHere(v)) return 'Not readable here';
  switch (s) {
    case 'open':
      return 'Needs you';
    case 'proxy-answered':
      return 'Answered by decision model';
    case 'human-answered':
      return 'Answered by you';
    case 'cancelled':
      return 'Withdrawn';
    case 'expired':
      return 'Expired';
    default:
      return 'Could not verify';
  }
}

/** Project and machine kept apart, so the row can lead with the project and still always show the machine. */
export function originParts(v: QuestionView): { project: string; machine: string } {
  const c = v.content;
  if (!c)
    return { project: unreadableHere(v) ? 'Earlier question' : 'Unverified question', machine: '' };
  return { project: c.project_label || 'Daintree', machine: c.machine_label || '' };
}
export const proxyNeedsReview = (v: QuestionView, now = Date.now()): boolean => {
  if (effectiveStatus(v, now) !== 'proxy-answered') return false;
  return !v.actions.some(
    (a) => a.verified && (a.action === 'confirm-proxy' || a.action === 'override'),
  );
};

/** Which action a human tap maps to for this question right now (null = nothing can be submitted). */
export function submitKind(v: QuestionView, now = Date.now()): 'answer' | 'override' | null {
  const s = effectiveStatus(v, now);
  if (s === 'open') return 'answer';
  if (s === 'human-answered' || s === 'proxy-answered') return 'override';
  return null;
}

export type DeliveryStep =
  'queued' | 'sending' | 'confirmed' | 'desktop' | 'terminal' | 'attention';

export interface DeliveryProgress {
  step: DeliveryStep;
  label: string;
  detail?: string;
}

export const DELIVERY_LABELS: Record<DeliveryStep, string> = {
  queued: 'Queued on this device',
  sending: 'Sending…',
  confirmed: 'Saved on your relay',
  desktop: 'Received by your computer',
  terminal: 'Typed into the terminal',
  attention: 'Needs attention on your computer',
};

/** How a step reads once it is behind us (no ellipsis on something that has finished). */
export const DELIVERY_DONE_LABELS: Partial<Record<DeliveryStep, string>> = {
  sending: 'Sent',
};

/** True when the answer in force could not be confirmed as delivered and the owner should look at it. */
export function deliveryNeedsAttention(v: QuestionView): boolean {
  const a = currentAnswer(v);
  if (!a) return false;
  const d = v.deliveries[a.revision];
  return d?.status === 'needs-attention' || d?.status === 'delivery-uncertain';
}

/** Progress of the answer in force. `pending` is the local outbox state for this question, if any. */
export function deliveryProgress(
  v: QuestionView,
  store: Pick<QuestionStore, 'desktopAckSeq'>,
  pending?: 'queued' | 'sending',
): DeliveryProgress | null {
  if (pending) return { step: pending, label: DELIVERY_LABELS[pending] };
  const a = currentAnswer(v);
  if (!a) return null;
  const d = v.deliveries[a.revision];
  if (d?.status === 'terminal-delivered')
    return { step: 'terminal', label: DELIVERY_LABELS.terminal };
  if (d?.status === 'needs-attention' || d?.status === 'delivery-uncertain') {
    return {
      step: 'attention',
      label:
        d.status === 'delivery-uncertain'
          ? 'Delivery couldn’t be confirmed'
          : DELIVERY_LABELS.attention,
      detail: d.status === 'delivery-uncertain' ? undefined : d.errorCode,
    };
  }
  if (store.desktopAckSeq >= a.seq) return { step: 'desktop', label: DELIVERY_LABELS.desktop };
  return { step: 'confirmed', label: DELIVERY_LABELS.confirmed };
}

/** Plain label for the project/machine filter: decrypted labels only, never raw ids. */
export function originLabel(v: QuestionView): string {
  const c = v.content;
  if (!c) return unreadableHere(v) ? 'Earlier question' : 'Unverified question';
  return [c.project_label, c.machine_label].filter(Boolean).join(' · ') || 'Daintree';
}

/** Needs-you ordering: items expiring within 24h first (soonest deadline first), then oldest first; or newest first on request. */
export function sortNeedsYou(
  list: QuestionView[],
  newestFirst: boolean,
  now: number,
): QuestionView[] {
  // Only a question that can still be answered is urgent; an answered one with an old deadline is not.
  const urgent = (v: QuestionView) =>
    needsYou(v, now) && v.expiresAt !== null && Date.parse(v.expiresAt) - now < 24 * 3_600_000;
  return [...list].sort((a, b) => {
    if (newestFirst) return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    const ua = urgent(a);
    const ub = urgent(b);
    if (ua !== ub) return ua ? -1 : 1;
    if (ua && ub) return Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!);
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}
