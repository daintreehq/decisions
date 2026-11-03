import type { ActionView, QuestionView } from './model.js';
import {
  currentAnswer,
  deliveryNeedsAttention,
  effectiveStatus,
  hiddenQuestionText,
  needsAction,
  needsYou,
  originParts,
  proxyNeedsReview,
  sortNeedsYou,
  unreadableHere,
} from './selectors.js';

/**
 * The list model behind the Questions & answers navigator and History: scopes, filters, local search, sorting,
 * stable ordering and day grouping. Pure functions over question views, so every presentation (phone sheet, page,
 * desktop rail, History) answers the same way and all of it is unit-tested.
 */

export type Scope = 'needs' | 'model' | 'all';
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
  | 'unreadable';

export const STATUS_LABEL: Record<RowStatus, string> = {
  needs: 'Needs you',
  review: 'Model answer · review',
  answered: 'Answered',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
  delivery: 'Delivery needs attention',
  unverified: 'Could not verify',
  unreadable: 'Not readable here',
};

export function principalStatus(v: QuestionView, now: number): RowStatus {
  const s = effectiveStatus(v, now);
  if (s === 'unverified') return unreadableHere(v) ? 'unreadable' : 'unverified';
  if (s === 'open') return 'needs';
  if (deliveryNeedsAttention(v)) return 'delivery';
  if (s === 'proxy-answered') return proxyNeedsReview(v, now) ? 'review' : 'answered';
  if (s === 'human-answered') return 'answered';
  if (s === 'expired') return 'expired';
  return 'withdrawn';
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

/** What a search can see: the question as it stands, and everything said about it earlier. */
export function haystacks(v: QuestionView): { current: string; earlier: string } {
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
  return { current: fold(current.join('\n')), earlier: fold(earlier.join('\n')) };
}

export type SearchHit = 'current' | 'earlier';

/**
 * Every term must appear somewhere. A hit that needs an earlier answer or reason to complete it is labelled
 * "earlier", so History can say "Matched an earlier answer".
 */
export function searchQuestion(v: QuestionView, query: string): SearchHit | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return 'current';
  const h = haystacks(v);
  if (terms.every((t) => h.current.includes(t))) return 'current';
  const all = h.current + '\n' + h.earlier;
  return terms.every((t) => all.includes(t)) ? 'earlier' : null;
}

/* ---------------- the navigator ---------------- */

export function inScope(v: QuestionView, scope: Scope, now: number): boolean {
  if (scope === 'needs') return needsAction(v, now);
  if (scope === 'model') return proxyNeedsReview(v, now);
  return true;
}

export interface ScopeCounts {
  needs: number;
  model: number;
  all: number;
}

/** Counts follow the project and computer filters (never the search), so a count never promises hidden rows. */
export function scopeCounts(list: QuestionView[], f: Filters, now: number): ScopeCounts {
  const base = list.filter((v) => matchesFilters(v, f));
  return {
    needs: base.filter((v) => needsAction(v, now)).length,
    model: base.filter((v) => proxyNeedsReview(v, now)).length,
    all: base.length,
  };
}

const byActivity = (a: QuestionView, b: QuestionView) =>
  b.lastSeq - a.lastSeq || Date.parse(b.createdAt) - Date.parse(a.createdAt);

export interface NavGroup {
  key: 'main' | 'delivery';
  title: string | null;
  items: QuestionView[];
}

export interface NavQuery extends Filters {
  scope: Scope;
  sort: NeedsSort;
  query: string;
}

/**
 * The navigator's rows in display order. Needs you: answerable questions by soonest deadline then oldest (or
 * newest first), with answered questions whose delivery needs attention in their own group below. Model answers
 * and All: most recent activity first.
 */
export function navigatorGroups(list: QuestionView[], q: NavQuery, now: number): NavGroup[] {
  const rows = list.filter(
    (v) => inScope(v, q.scope, now) && matchesFilters(v, q) && searchQuestion(v, q.query) !== null,
  );
  if (q.scope !== 'needs') return [{ key: 'main', title: null, items: rows.sort(byActivity) }];
  const open = sortNeedsYou(
    rows.filter((v) => needsYou(v, now)),
    q.sort === 'newest',
    now,
  );
  const delivery = rows.filter((v) => !needsYou(v, now)).sort(byActivity);
  const groups: NavGroup[] = [{ key: 'main', title: null, items: open }];
  if (delivery.length)
    groups.push({ key: 'delivery', title: 'Delivery needs attention', items: delivery });
  return groups;
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
  author: 'You' | 'Model';
  /** Option labels and the note, as one plain line. */
  text: string;
  confirmed: boolean;
}

export function optionLabels(v: QuestionView, a: ActionView | null): string[] {
  return (a?.content?.selected_option_ids ?? [])
    .map((id) => v.content?.options.find((o) => o.id === id)?.label)
    .filter((l): l is string => !!l);
}

/** The answer in force as one line, for list rows: "Keep Canopy — Canopy is the brand name". */
export function answerSummary(v: QuestionView): AnswerSummary | null {
  const a = currentAnswer(v);
  if (!a) return null;
  const labels = optionLabels(v, a);
  const note = (a.content?.text ?? '').replace(/\s+/g, ' ').trim();
  const text = [labels.join(', '), note].filter(Boolean).join(' — ');
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
  if (!v.expiresAt || !needsYou(v, now)) return null;
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
    if (needsYou(v, now)) continue;
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
