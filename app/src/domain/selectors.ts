import { threadAwaitsHuman, type ActionKind } from '@daintreehq/decisions-protocol';
import type { ActionView, QuestionStore, QuestionView, ThreadMessage } from './model.js';
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

/** A question that can still be answered: open, verified and not past its deadline. */
export const answerable = (v: QuestionView, now = Date.now()): boolean =>
  effectiveStatus(v, now) === 'open';

const HUMAN_TURNS: ActionKind[] = ['answer', 'override', 'confirm-proxy'];

/**
 * The agent asked the person something in the thread and nothing human has come after it (a follow-up, an answer,
 * an override or a confirmation): an answered question needs the person again (docs/protocol.md section 16.2).
 * Only verified messages count; a closed or expired thread waits on nobody.
 */
export function awaitingReply(v: QuestionView, now = Date.now()): boolean {
  const s = effectiveStatus(v, now);
  if (s === 'unverified' || s === 'expired' || s === 'cancelled') return false;
  let lastHumanActionSeq = 0;
  for (const a of v.actions)
    if (a.verified && HUMAN_TURNS.includes(a.action)) lastHumanActionSeq = a.seq;
  return threadAwaitsHuman({
    status: s,
    messages: v.messages
      .filter((m) => m.verified)
      .map((m) => ({ side: m.side, expects_reply: m.expectsReply, event_seq: m.seq })),
    lastHumanActionSeq,
  });
}

/** The agent message that is waiting on the person, when there is one. */
export function pendingAsk(v: QuestionView, now = Date.now()): ThreadMessage | null {
  if (!awaitingReply(v, now)) return null;
  for (let i = v.messages.length - 1; i >= 0; i--) {
    const m = v.messages[i]!;
    if (m.verified && m.side === 'agent') return m.expectsReply ? m : null;
  }
  return null;
}

/** Waiting on the person: a question to answer, or an agent message asking for a reply. */
export const needsYou = (v: QuestionView, now = Date.now()): boolean =>
  answerable(v, now) || awaitingReply(v, now);

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

const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  'gemini-cli': 'Gemini',
  cursor: 'Cursor',
  aider: 'Aider',
  opencode: 'OpenCode',
  copilot: 'Copilot',
};

/** The asking agent's kind, as people say it ("Claude Code"), from the signed origin summary ("kind · worktree"). */
export function agentName(v: QuestionView): string {
  const kind = (v.content?.origin_summary ?? '').split(' · ')[0]!.trim().toLowerCase().slice(0, 40);
  if (!kind) return 'Your agent';
  const known = AGENT_NAMES[kind];
  if (known) return known;
  const words = kind.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Your agent';
}

/** Project and machine kept apart, so the row can lead with the project and still always show the machine. */
export function originParts(v: QuestionView): { project: string; machine: string } {
  const c = v.content;
  if (!c)
    return { project: unreadableHere(v) ? 'Earlier question' : 'Unverified question', machine: '' };
  // A desktop with no name of its own sends its host id in the name's place (the client's fallback); an id is not a
  // name a person recognises, so it reads as what it is. The id itself stays in Question details.
  const machine = c.machine_label || '';
  const unnamed =
    !!machine &&
    ((!!v.targetHostId && machine === v.targetHostId) || /^host_[0-9a-z]{6,}$/i.test(machine));
  return {
    project: c.project_label || 'Daintree',
    machine: unnamed ? 'Unnamed computer' : machine,
  };
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

/**
 * A model answer in force that the person has neither confirmed nor overruled: the only answer this app offers to
 * replace. A person's own answer is final (docs/protocol.md section 16.1); saying more is a follow-up.
 */
export function canOverrule(v: QuestionView, now = Date.now()): boolean {
  const a = currentAnswer(v);
  return !!a && a.provenance === 'proxy' && proxyNeedsReview(v, now);
}

/** The thread takes messages: answered or still open, never expired or withdrawn (docs/protocol.md section 16). */
export function threadOpen(v: QuestionView, now = Date.now()): boolean {
  const s = effectiveStatus(v, now);
  return s === 'open' || s === 'human-answered' || s === 'proxy-answered';
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

/**
 * True when the answer in force, or one of the person's follow-ups, could not be confirmed as typed into the terminal
 * and the owner should look at their computer. The answer in force is untouched either way.
 */
export function deliveryNeedsAttention(v: QuestionView): boolean {
  return deliveryIssue(v) !== null;
}

/** Which delivery needs the owner: the answer in force (named first), a follow-up, or none. */
export function deliveryIssue(v: QuestionView): 'answer' | 'follow-up' | null {
  const stuck = (s: string | undefined) => s === 'needs-attention' || s === 'delivery-uncertain';
  const a = currentAnswer(v);
  if (a && stuck(v.deliveries[a.revision]?.status)) return 'answer';
  return v.messages.some((m) => m.verified && m.side === 'human' && stuck(m.delivery?.status))
    ? 'follow-up'
    : null;
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

/**
 * Where one of the person's follow-ups has reached. `pending` is its local outbox state while it has not left this
 * device; once the relay has it, the publishing desktop's explicit receipts move it on. A ledger acknowledgement
 * never marks a message received (docs/protocol.md section 16.4).
 */
export function messageProgress(
  m: Pick<ThreadMessage, 'delivery'> | null,
  pending?: 'queued' | 'sending',
): DeliveryProgress {
  if (pending) return { step: pending, label: DELIVERY_LABELS[pending] };
  const d = m?.delivery;
  if (d?.status === 'terminal-delivered')
    return { step: 'terminal', label: DELIVERY_LABELS.terminal };
  if (d?.status === 'needs-attention' || d?.status === 'delivery-uncertain')
    return {
      step: 'attention',
      label:
        d.status === 'delivery-uncertain'
          ? 'Delivery couldn’t be confirmed'
          : DELIVERY_LABELS.attention,
      detail: d.status === 'delivery-uncertain' ? undefined : (d.error_code ?? undefined),
    };
  if (d?.status === 'received') return { step: 'desktop', label: DELIVERY_LABELS.desktop };
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
    answerable(v, now) && v.expiresAt !== null && Date.parse(v.expiresAt) - now < 24 * 3_600_000;
  return [...list].sort((a, b) => {
    if (newestFirst) return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    const ua = urgent(a);
    const ub = urgent(b);
    if (ua !== ub) return ua ? -1 : 1;
    if (ua && ub) return Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!);
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}
