import type { ActionView, QuestionView } from './model.js';
import {
  agentName,
  answerable,
  awaitingReply,
  currentAnswer,
  deliveryNeedsAttention,
  effectiveStatus,
  hiddenQuestionText,
  needsYou,
  pendingAsk,
  originParts,
  proxyNeedsReview,
  sortNeedsYou,
  unreadableHere,
} from './selectors.js';

/**
 * The list model behind Home's list (and the navigator sheet) and History: sections, filters, local search, sorting,
 * stable ordering and day grouping. Pure functions over question views, so every presentation (the page, the sheet,
 * History) answers the same way and all of it is unit-tested.
 */

export type NeedsSort = 'due' | 'newest';
export type HistoryMode = 'decisions' | 'all';

/** One principal status per question (guide 4.2). */
export type RowStatus =
  | 'needs'
  | 'review'
  | 'answered'
  | 'expired'
  | 'withdrawn'
  | 'delivery'
  | 'unverified'
  | 'unreadable'
  /** Local only: an answer or follow-up from this device still in its outbox. Never a relay status. */
  | 'sending';

export const STATUS_LABEL: Record<RowStatus, string> = {
  needs: 'Needs you',
  review: 'Model answer · review',
  answered: 'Answered',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
  delivery: 'Delivery needs attention',
  unverified: 'Could not verify',
  unreadable: 'Not readable here',
  sending: 'Waiting to send',
};

export function principalStatus(v: QuestionView, now: number): RowStatus {
  const s = effectiveStatus(v, now);
  if (s === 'unverified') return unreadableHere(v) ? 'unreadable' : 'unverified';
  if (s === 'open') return 'needs';
  if (deliveryNeedsAttention(v)) return 'delivery';
  // The agent asked something in the thread after the answer: it is the person's turn again.
  if (awaitingReply(v, now)) return 'needs';
  if (s === 'proxy-answered') return proxyNeedsReview(v, now) ? 'review' : 'answered';
  if (s === 'human-answered') return 'answered';
  if (s === 'expired') return 'expired';
  return 'withdrawn';
}

/** What a row says in place of an answer when a question closed without one (Home and History). */
export function closedLine(status: RowStatus): string | null {
  if (status === 'expired') return 'Expired before anyone answered';
  if (status === 'withdrawn') return 'Withdrawn by your agent';
  if (status === 'unreadable') return 'This device holds no key for it';
  if (status === 'unverified') return 'Could not be verified';
  return null;
}

/* ---------------- origin ---------------- */

export const projectOf = (v: QuestionView): string => originParts(v).project;
export const computerOf = (v: QuestionView): string => originParts(v).machine;

/** Distinct project and computer labels, for the filter menus. Computers with no label are not offered. */
export function filterOptions(list: QuestionView[]): { projects: string[]; computers: string[] } {
  const projects = new Set<string>();
  const computers = new Set<string>();
  for (const v of list) {
    if (!v.content) continue;
    projects.add(projectOf(v));
    const c = computerOf(v);
    if (c) computers.add(c);
  }
  const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { projects: sort(projects), computers: sort(computers) };
}

export interface Filters {
  project: string | null;
  computer: string | null;
}

export const matchesFilters = (v: QuestionView, f: Filters): boolean =>
  (!f.project || (!!v.content && projectOf(v) === f.project)) &&
  (!f.computer || (!!v.content && computerOf(v) === f.computer));

/* ---------------- search ---------------- */

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function queryTerms(q: string): string[] {
  return fold(q).split(/\s+/).filter(Boolean);
}

const ANSWERS = new Set(['answer', 'override', 'proxy-answer']);

function answerWords(v: QuestionView, a: ActionView): string[] {
  const c = a.content;
  if (!c) return [];
  const labels = (c.selected_option_ids ?? []).map(
    (id) => v.content?.options.find((o) => o.id === id)?.label ?? '',
  );
  return [...labels, c.text ?? '', c.reason ?? ''];
}

/**
 * What a search can see: the question as it stands, everything decided about it earlier (earlier answers and
 * reasons), and the thread's messages, which never change the answer in force.
 */
export function haystacks(v: QuestionView): { current: string; earlier: string; thread: string } {
  const c = v.content;
  const cur = currentAnswer(v);
  const current = [
    c ? c.question : hiddenQuestionText(v),
    c?.context ?? '',
    projectOf(v),
    computerOf(v),
    c?.origin_summary ?? '',
    ...(c?.options ?? []).flatMap((o) => [o.label, o.description ?? '']),
    ...(cur ? answerWords(v, cur) : []),
  ];
  // Earlier answers, and every reason given along the way (a correction's reason, a confirmation's note).
  const earlier: string[] = [];
  for (const a of v.actions) {
    if (!a.verified || a === cur) continue;
    if (ANSWERS.has(a.action)) earlier.push(...answerWords(v, a));
    else if (a.content?.reason) earlier.push(a.content.reason);
  }
  const thread = v.messages.filter((m) => m.verified).map((m) => m.text);
  return {
    current: fold(current.join('\n')),
    earlier: fold(earlier.join('\n')),
    thread: fold(thread.join('\n')),
  };
}

export type SearchHit = 'current' | 'earlier' | 'thread';

/**
 * Every term must appear somewhere. A hit that needs an earlier answer or reason to complete it is labelled
 * "earlier", so History can say "Matched an earlier answer"; one that needs the thread's messages is "thread"
 * ("Matched a message"), so a follow-up is never presented as an answer.
 */
export function searchQuestion(v: QuestionView, query: string): SearchHit | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return 'current';
  const h = haystacks(v);
  if (terms.every((t) => h.current.includes(t))) return 'current';
  const decided = h.current + '\n' + h.earlier;
  if (terms.every((t) => decided.includes(t))) return 'earlier';
  const all = decided + '\n' + h.thread;
  return terms.every((t) => all.includes(t)) ? 'thread' : null;
}

/* ---------------- Home's list ---------------- */

export interface ListQuery extends Filters {
  sort: NeedsSort;
  query: string;
  /** Questions with an answer from this device still in its outbox. */
  pending?: ReadonlySet<string>;
  /** Questions with a follow-up from this device the relay refused: it was not sent, and the words wait there. */
  refused?: ReadonlySet<string>;
}

export type SectionKind = 'needs' | 'sending' | 'review' | 'day';

export interface ListSection {
  /** Stable per section: `needs`, `sending`, `review`, or `day:<local date>`. */
  key: string;
  kind: SectionKind;
  title: string;
  items: QuestionView[];
}

const byActivity = (a: QuestionView, b: QuestionView) =>
  b.lastSeq - a.lastSeq || Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * Every question in one list, in the order a person deals with them. Needs you: answers whose delivery needs
 * attention on a computer (they are stuck, so they lead), then the questions waiting for a decision (soonest
 * deadline, then oldest, or newest first); the same set the sidebar counts. Then answers from this device still
 * waiting to send, model answers still to review, and everything else by most recent activity, grouped by day.
 * Needs you is always present, even when empty, so the list can say so in its place; the others appear only when
 * they hold something. Filters and search apply to every section.
 */
export function homeSections(
  list: QuestionView[],
  q: ListQuery,
  now: number,
  locale?: string,
): ListSection[] {
  const rows = list.filter((v) => matchesFilters(v, q) && searchQuestion(v, q.query) !== null);
  const needs: QuestionView[] = [];
  const delivery: QuestionView[] = [];
  const sending: QuestionView[] = [];
  const review: QuestionView[] = [];
  const rest: QuestionView[] = [];
  for (const v of rows) {
    if (q.pending?.has(v.id)) sending.push(v);
    else if (needsYou(v, now)) needs.push(v);
    else if (deliveryNeedsAttention(v) || q.refused?.has(v.id)) delivery.push(v);
    else if (proxyNeedsReview(v, now)) review.push(v);
    else rest.push(v);
  }
  const sections: ListSection[] = [
    {
      key: 'needs',
      kind: 'needs',
      title: 'Needs you',
      items: [...delivery.sort(byActivity), ...sortNeedsYou(needs, q.sort === 'newest', now)],
    },
  ];
  if (sending.length)
    sections.push({
      key: 'sending',
      kind: 'sending',
      title: 'Waiting to send',
      items: sending.sort(byActivity),
    });
  if (review.length)
    sections.push({
      key: 'review',
      kind: 'review',
      title: 'Model answers to review',
      items: review.sort(byActivity),
    });
  for (const g of groupByDay(rest.sort(byActivity), (v) => v.lastEventAt, now, locale))
    sections.push({ key: `day:${g.key}`, kind: 'day', title: g.label, items: g.items });
  return sections;
}

/**
 * Rows never reshuffle under the finger. Given the order on screen and a freshly sorted list, keep the screen's
 * order (dropping rows that left) and hold back the newcomers until the person asks for them.
 */
export function stableOrder(
  shown: readonly string[] | null,
  next: readonly string[],
): { ids: string[]; added: string[] } {
  if (!shown) return { ids: [...next], added: [] };
  const inNext = new Set(next);
  const onScreen = new Set(shown);
  return {
    ids: shown.filter((id) => inNext.has(id)),
    added: next.filter((id) => !onScreen.has(id)),
  };
}

/* ---------------- row summaries ---------------- */

export interface AnswerSummary {
  author: string;
  /** The agent is asking the person something: this line is what needs them. */
  ask?: boolean;
  /** Option labels and the note, as one plain line. */
  text: string;
  confirmed: boolean;
}

export function optionLabels(v: QuestionView, a: ActionView | null): string[] {
  return (a?.content?.selected_option_ids ?? [])
    .map((id) => v.content?.options.find((o) => o.id === id)?.label)
    .filter((l): l is string => !!l);
}

/** Chosen options and a note as one plain line: "Keep Canopy — Canopy is the brand name". */
export function choiceLine(v: QuestionView, selected: readonly string[], note: string): string {
  const labels = selected
    .map((id) => v.content?.options.find((o) => o.id === id)?.label)
    .filter((l): l is string => !!l);
  return [labels.join(', '), note.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' — ');
}

/**
 * The line under a row's question. Normally the answer in force ("You: Keep Canopy — …"); when the agent has asked
 * something in the thread since, its message instead ("Claude Code: Which branch?"), since that is what needs you.
 */
export function rowSummary(v: QuestionView, now: number): AnswerSummary | null {
  const ask = pendingAsk(v, now);
  if (ask)
    return {
      author: agentName(v),
      text: ask.text.replace(/\s+/g, ' ').trim(),
      confirmed: false,
      ask: true,
    };
  return answerSummary(v);
}

/** The answer in force as one line, for list rows: "Keep Canopy — Canopy is the brand name". */
export function answerSummary(v: QuestionView): AnswerSummary | null {
  const a = currentAnswer(v);
  if (!a) return null;
  // Photos are part of what was said, and short: they come before the note, so a truncated row still shows them.
  // "Keep Canopy · 2 photos — Canopy is the brand name", "2 photos — The serial is on the second".
  const photos = (a.content as { images?: unknown[] } | null)?.images?.length ?? 0;
  const counted = photos ? `${photos} ${photos === 1 ? 'photo' : 'photos'}` : '';
  const head = [choiceLine(v, a.content?.selected_option_ids ?? [], ''), counted]
    .filter(Boolean)
    .join(' · ');
  const note = (a.content?.text ?? '').replace(/\s+/g, ' ').trim();
  const text = [head, note].filter(Boolean).join(' — ');
  const confirmed =
    a.provenance === 'proxy' &&
    v.actions.some((x) => x.verified && x.action === 'confirm-proxy' && x.seq > a.seq);
  return { author: a.provenance === 'proxy' ? 'Model' : 'You', text, confirmed };
}

export const correctionCount = (v: QuestionView): number =>
  v.actions.filter((a) => a.verified && a.action === 'override').length;

const DAY = 24 * 3_600_000;

/** "Due in 2 h" — in the warning hue only inside 24 hours. Only for questions that can still be answered. */
export function dueLabel(v: QuestionView, now: number): { label: string; urgent: boolean } | null {
  if (!v.expiresAt || !answerable(v, now)) return null;
  const ms = Date.parse(v.expiresAt) - now;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  let label: string;
  if (m < 60) label = `Due in ${Math.max(1, m)} min`;
  else if (m < 48 * 60) label = `Due in ${Math.floor(m / 60)} h`;
  else label = `Due in ${Math.floor(m / (24 * 60))} d`;
  return { label, urgent: ms < DAY };
}

/* ---------------- History ---------------- */

export interface HistoryEntry {
  v: QuestionView;
  status: RowStatus;
  /** When it was decided (or closed): the time the row is filed under. */
  at: string;
  answer: AnswerSummary | null;
  changes: number;
  delivery: boolean;
  hit: SearchHit | null;
}

const DECIDING = new Set(['answer', 'override', 'proxy-answer', 'confirm-proxy', 'cancel']);

export function decidedAt(v: QuestionView, now: number): string {
  if (effectiveStatus(v, now) === 'expired' && v.expiresAt) return v.expiresAt;
  for (let i = v.actions.length - 1; i >= 0; i--) {
    const a = v.actions[i]!;
    if (a.verified && DECIDING.has(a.action)) return a.createdAt;
  }
  return v.lastEventAt;
}

/**
 * History answers "what did I decide". Decisions: human answers, confirmed model answers, expired and withdrawn.
 * All activity adds model answers still awaiting review, and anything this device could not read or verify.
 */
export function historyEntries(
  list: QuestionView[],
  mode: HistoryMode,
  query: string,
  now: number,
): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const v of list) {
    // History is what was decided: a question still to answer is not in it (one the agent has since asked more
    // about was still decided, and stays).
    if (answerable(v, now)) continue;
    const status = principalStatus(v, now);
    if (
      mode === 'decisions' &&
      (status === 'review' || status === 'unverified' || status === 'unreadable')
    )
      continue;
    const hit = query.trim() ? searchQuestion(v, query) : null;
    if (query.trim() && !hit) continue;
    out.push({
      v,
      status,
      at: decidedAt(v, now),
      answer: answerSummary(v),
      changes: correctionCount(v),
      delivery: deliveryNeedsAttention(v),
      hit,
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.v.lastSeq - a.v.lastSeq);
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** "Today", "Yesterday", then dates ("Mon 27 Oct", with the year once it is not this year). Local time. */
export function dayLabel(iso: string, now: number, locale?: string): string {
  const d = new Date(iso);
  const today = new Date(now);
  if (dayKey(d) === dayKey(today)) return 'Today';
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return 'Yesterday';
  return d.toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Group items (already sorted newest first) by the local day of `at`, keeping their order. */
export function groupByDay<T>(
  items: T[],
  at: (t: T) => string,
  now: number,
  locale?: string,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const it of items) {
    const iso = at(it);
    const key = dayKey(new Date(iso));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(it);
    else groups.push({ key, label: dayLabel(iso, now, locale), items: [it] });
  }
  return groups;
}
