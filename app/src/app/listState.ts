import { useLayoutEffect, useSyncExternalStore, type RefObject } from 'react';
import type { HistoryMode, NeedsSort, Scope } from '../domain/lists.js';
import { goBackPast } from './layers.js';
import { matchRoute, navigate } from './router.js';

/**
 * Where every list was left, and where Back from a question goes.
 *
 * - Scope, project and computer filters, sort and History's mode persist per device (labels are never stored in
 *   the clear: a filter is kept as a salted digest and resolved against the labels on screen).
 * - Search text, the scroll anchor, the row to refocus and History's open record last for the session, in memory.
 * - A question opened from a list records its origin in its own history entry (`history.state.decisionsBack`),
 *   so Back returns to that list with its query, filters and row, even after a reload. A direct link goes Back to
 *   Questions.
 */

export type ListKey = 'questions' | 'history';

export interface Anchor {
  id: string;
  /** Row top minus its scroll container's top, in px, when it was left. */
  offset: number;
}

interface ListMemory {
  /** What the search field holds (the list filters on its debounced value). */
  query: string;
  anchor: Anchor | null;
  /** Focus returns to this row once, the next time the list mounts. */
  focusId: string | null;
}

export interface QuestionsState extends ListMemory {
  scope: Scope;
  sort: NeedsSort;
  project: string | null;
  computer: string | null;
}

export interface HistoryState extends ListMemory {
  mode: HistoryMode;
  /** The record open beside (or over) the History list. */
  record: string | null;
}

export interface NavState {
  questions: QuestionsState;
  history: HistoryState;
}

const STORAGE_KEY = 'decisions:lists:v1';

interface Persisted {
  salt: string;
  scope: Scope;
  sort: NeedsSort;
  mode: HistoryMode;
  project: string | null;
  computer: string | null;
}

const blank = (): ListMemory => ({ query: '', anchor: null, focusId: null });

const initial = (): NavState => ({
  questions: { ...blank(), scope: 'needs', sort: 'due', project: null, computer: null },
  history: { ...blank(), mode: 'decisions', record: null },
});

let state: NavState = initial();
/** Digests of the persisted filters, waiting for the labels they stand for to appear. */
let pending: { project: string | null; computer: string | null } = {
  project: null,
  computer: null,
};
let salt = '';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

/** FNV-1a over the salted label: a filter survives a restart without its label being stored in the clear. */
export function digest(label: string, s = salt): string {
  let h = 0x811c9dc5;
  const str = `${s}\u0000${label}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function load(): void {
  const s = storage();
  let p: Partial<Persisted> = {};
  try {
    p = JSON.parse(s?.getItem(STORAGE_KEY) ?? '{}') as Partial<Persisted>;
  } catch {
    p = {};
  }
  salt = typeof p.salt === 'string' && p.salt ? p.salt : Math.random().toString(36).slice(2, 12);
  const scope: Scope = p.scope === 'model' || p.scope === 'all' ? p.scope : 'needs';
  const sort: NeedsSort = p.sort === 'newest' ? 'newest' : 'due';
  const mode: HistoryMode = p.mode === 'all' ? 'all' : 'decisions';
  state = {
    questions: { ...state.questions, scope, sort },
    history: { ...state.history, mode },
  };
  pending = {
    project: typeof p.project === 'string' ? p.project : null,
    computer: typeof p.computer === 'string' ? p.computer : null,
  };
}

function save(): void {
  const q = state.questions;
  const p: Persisted = {
    salt,
    scope: q.scope,
    sort: q.sort,
    mode: state.history.mode,
    project: q.project ? digest(q.project) : pending.project,
    computer: q.computer ? digest(q.computer) : pending.computer,
  };
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* private mode or quota: the preference just does not persist */
  }
}

load();

export function getNavState(): NavState {
  return state;
}

export function subscribeNav(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useNavState(): NavState {
  return useSyncExternalStore(subscribeNav, getNavState, getNavState);
}

const PERSISTED_Q: (keyof QuestionsState)[] = ['scope', 'sort', 'project', 'computer'];

export function setQuestions(patch: Partial<QuestionsState>): void {
  // Choosing a filter (or clearing one) replaces whatever was waiting to be restored.
  if ('project' in patch) pending.project = null;
  if ('computer' in patch) pending.computer = null;
  state = { ...state, questions: { ...state.questions, ...patch } };
  if (PERSISTED_Q.some((k) => k in patch)) save();
  emit();
}

export function setHistory(patch: Partial<HistoryState>): void {
  state = { ...state, history: { ...state.history, ...patch } };
  if ('mode' in patch) save();
  emit();
}

/** Restore persisted filters once the labels they were saved for are on this device again. */
export function resolvePersistedFilters(projects: string[], computers: string[]): void {
  const patch: Partial<QuestionsState> = {};
  if (pending.project && !state.questions.project) {
    const hit = projects.find((p) => digest(p) === pending.project);
    if (hit) patch.project = hit;
  }
  if (pending.computer && !state.questions.computer) {
    const hit = computers.find((c) => digest(c) === pending.computer);
    if (hit) patch.computer = hit;
  }
  if (!Object.keys(patch).length) return;
  state = { ...state, questions: { ...state.questions, ...patch } };
  emit();
}

/** Unpairing or revocation erases everything this device kept about its lists. */
export function resetNavState(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
  pending = { project: null, computer: null };
  backById.clear();
  state = initial();
  load();
  emit();
}

/* ---------------- origin and Back ---------------- */

export interface BackInfo {
  /** The page Back returns to. */
  path: string;
  /** True when that page is the history entry directly below the question, so Back can pop to it. */
  prev: boolean;
}

const backById = new Map<string, BackInfo>();

function stateBack(): BackInfo | null {
  const s = (typeof history === 'undefined' ? null : history.state) as {
    decisionsBack?: BackInfo;
  } | null;
  const b = s?.decisionsBack;
  return b && typeof b.path === 'string' ? b : null;
}

function currentBack(): BackInfo | null {
  const r = matchRoute(location.pathname);
  if (r.name !== 'question') return null;
  return stateBack() ?? backById.get(r.id) ?? null;
}

const LABELS: Record<string, string> = {
  '/': 'Questions',
  '/history': 'History',
  '/settings': 'Settings',
  '/devices': 'Devices',
};

/** Where Back from the open question goes: `/` (Questions) unless it was opened from another page. */
export function backTarget(): string {
  return currentBack()?.path ?? '/';
}

/** The name of that place, for the Back button's label: "Questions", "History"… */
export function backLabel(): string {
  const p = backTarget();
  return LABELS[p] ?? (p.startsWith('/settings') ? 'Settings' : 'Questions');
}

/**
 * Leave the open question for its origin. When the origin is the entry below, pop to it (closing any open layers
 * on the way), so the list comes back exactly as it was left; otherwise go there. A direct link replaces itself
 * with Questions.
 */
export function goBack(): void {
  const r = matchRoute(location.pathname);
  const info = currentBack();
  if (info?.prev) {
    // A tracked traversal, once any in flight has landed: later navigation waits for this one to land.
    goBackPast(1);
    return;
  }
  if (r.name === 'question' && !info) {
    navigate('/', true);
    return;
  }
  navigate(info?.path ?? '/');
}

function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

function topOf(sc: HTMLElement | null): number {
  return sc ? sc.getBoundingClientRect().top : 0;
}

/** Remember a row as the place to come back to in its list. */
export function rememberRow(list: ListKey, id: string, row: Element | null, focus = true): void {
  const prev = state[list].anchor;
  // Without a row (opened from a record or a button), keep the position already remembered for it.
  const offset = row
    ? row.getBoundingClientRect().top - topOf(scrollParent(row))
    : prev?.id === id
      ? prev.offset
      : 0;
  const patch = { anchor: { id, offset }, focusId: focus ? id : null };
  if (list === 'questions') setQuestions(patch);
  else setHistory(patch);
}

/**
 * Open a question from a list (or from anywhere), remembering where it came from. `row` is the element that was
 * activated; it becomes the list's anchor and gets focus back on return.
 */
export function openQuestion(
  id: string,
  from: ListKey,
  row?: Element | null,
  opts: { refocus?: boolean } = {},
): void {
  const to = `/q/${id}`;
  if (location.pathname === to) return;
  rememberRow(from, id, row ?? null, opts.refocus ?? true);
  const cur = matchRoute(location.pathname);
  let info: BackInfo;
  if (cur.name === 'question') {
    // A lateral move between questions keeps the first question's origin.
    const inherited = stateBack() ?? backById.get(cur.id) ?? null;
    info = { path: inherited?.path ?? (from === 'history' ? '/history' : '/'), prev: false };
  } else if (cur.name === 'not-found') {
    info = { path: '/', prev: false };
  } else {
    info = { path: location.pathname, prev: true };
  }
  backById.set(id, info);
  // The origin travels in the question's own entry, written when that entry is (navigation can wait on layers).
  navigate(to, false, { decisionsBack: info });
}

/** Activate a row link the way `Link` does: modified clicks keep the browser's own behaviour. */
export function rowClick(
  e: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey?: boolean;
    preventDefault(): void;
    currentTarget: Element;
  },
  id: string,
  from: ListKey,
  opts?: { refocus?: boolean },
): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openQuestion(id, from, e.currentTarget, opts);
}

/**
 * Put a list back where it was left: scroll so the anchor row sits where it was, and (once) give it focus.
 * Runs as a layout effect, so it lands after the router's scroll-to-top and before paint.
 */
export function useRestoreList(
  list: ListKey,
  container: RefObject<HTMLElement | null>,
  ready: boolean,
): void {
  useLayoutEffect(() => {
    if (!ready) return;
    const m = state[list];
    const el = container.current;
    if (!m.anchor || !el) return;
    const row = el.querySelector<HTMLElement>(`[data-row-id="${cssEscape(m.anchor.id)}"]`);
    if (!row) return;
    const sc = scrollParent(row);
    const delta = row.getBoundingClientRect().top - topOf(sc) - m.anchor.offset;
    if (sc) sc.scrollTop += delta;
    else window.scrollBy(0, delta);
    if (m.focusId === m.anchor.id) {
      row.focus({ preventScroll: true });
      if (list === 'questions')
        state = { ...state, questions: { ...state.questions, focusId: null } };
      else state = { ...state, history: { ...state.history, focusId: null } };
    }
    // Restoration is a one-off per mount; deliberately not re-run as the list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

// Lists restore their own position; the browser's restoration would fight it.
if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
  try {
    history.scrollRestoration = 'manual';
  } catch {
    /* read-only in some embedders */
  }
}
