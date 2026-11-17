import {
  HUMAN_MESSAGE_ROLES,
  humanMessageSentOn,
  isPersonDecline,
  threadAwaitsHuman,
  type ActionKind,
} from '@daintreehq/decisions-protocol';
import type { ActionView, QuestionStore, QuestionView, ThreadMessage } from './model.js';
import { sanitizeText } from '../lib/safe-text.js';
import { computerName } from './computer-name.js';
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

/**
 * The person dismissed this question from a phone or tablet: it is cancelled, and the cancel in force was signed by
 * a human device (its certificate checked when the event was verified). A desktop's cancel is a withdrawal instead.
 */
export function declinedByPerson(v: QuestionView): boolean {
  if (v.status !== 'cancelled' || !v.verification.ok) return false;
  for (let i = v.actions.length - 1; i >= 0; i--) {
    const a = v.actions[i]!;
    if (a.verified && a.action === 'cancel')
      return a.signerRole !== null && isPersonDecline(a.action, a.signerRole);
  }
  return false;
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
      return v && declinedByPerson(v) ? 'Declined' : 'Withdrawn';
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
/**
 * What the phone can observe of a cancelled question: it was withdrawn on the named computer. The cancel is signed by
 * the computer's key whether an agent or the person at the keyboard asked for it, so this never says who did.
 */
export function withdrawnLabel(v: QuestionView): string {
  // The name comes from the signing computer: drop control and escape characters, and fold line breaks to spaces.
  const machine = sanitizeText(originParts(v).machine).replace(/\s+/g, ' ').trim();
  if (!machine) return 'Withdrawn on the computer';
  return machine === 'Unnamed computer'
    ? 'Withdrawn on an unnamed computer'
    : `Withdrawn on ${machine}`;
}

/**
 * Who made an answer, in the words every surface uses: the decision model, the person on a phone or tablet, or the
 * person on the computer (the owner desktop signed it, `human-desktop` provenance), named from its certificate. Decide
 * by `model` and `computer`, never by the words.
 */
export interface AnswerBy {
  model: boolean;
  /** The computer the person answered on, or null when they answered on a phone or tablet (or the model did). */
  computer: string | null;
  /** Short, for rows and the header: "Model", "You", "You on Studio Mac". */
  author: string;
  /** As a sentence's subject: "The model answer", "Your answer", "Your answer on Studio Mac". */
  subject: string;
}

export function answerBy(a: Pick<ActionView, 'provenance' | 'signerLabel'>): AnswerBy {
  if (a.provenance === 'proxy')
    return { model: true, computer: null, author: 'Model', subject: 'The model answer' };
  if (a.provenance !== 'human-desktop')
    return { model: false, computer: null, author: 'You', subject: 'Your answer' };
  const computer = computerName(a.signerLabel);
  return {
    model: false,
    computer,
    author: `You on ${computer}`,
    subject: `Your answer on ${computer}`,
  };
}

/**
 * Where the person sent a follow-up from, in the words every surface uses: a phone or tablet, or the computer (the
 * owner desktop signed it), named from its certificate. Decided by the signer's verified role
 * (`humanMessageSentOn`), never by anything the relay says. Null for anything that is not the person's: an agent
 * message, one that could not be verified, or a signer that never sends a human message.
 */
export interface FollowUpBy {
  /** The computer the person sent it on, or null when they sent it on a phone or tablet. */
  computer: string | null;
  /** The bubble's label: "Follow-up", "Follow-up on Studio Mac". */
  label: string;
  /** As a sentence's subject: "Your follow-up", "Your follow-up on Studio Mac". */
  subject: string;
}

/** A follow-up sent on a phone or tablet: this device's own, or another one's. */
export const PHONE_FOLLOW_UP: FollowUpBy = {
  computer: null,
  label: 'Follow-up',
  subject: 'Your follow-up',
};

export function followUpBy(
  m: Pick<ThreadMessage, 'side' | 'verified' | 'signerRole' | 'signerLabel'>,
): FollowUpBy | null {
  if (m.side !== 'human' || !m.verified || !m.signerRole) return null;
  if (!HUMAN_MESSAGE_ROLES.includes(m.signerRole)) return null;
  if (humanMessageSentOn(m.signerRole) === 'phone') return PHONE_FOLLOW_UP;
  const computer = computerName(m.signerLabel);
  return {
    computer,
    label: `Follow-up on ${computer}`,
    subject: `Your follow-up on ${computer}`,
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
  // The person declined it: nothing about it waits on them, an old delivery failure included.
  if (declinedByPerson(v)) return null;
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
