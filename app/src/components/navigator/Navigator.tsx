import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { app } from '../../app/controller.js';
import {
  refusedFollowUps,
  useAgentStates,
  useApp,
  useInteracting,
  useNow,
  useQuestions,
} from '../../app/hooks.js';
import {
  resolvePersistedFilters,
  rowClick,
  setQuestions,
  useNavState,
  useRestoreList,
} from '../../app/listState.js';
import { useWide } from '../../app/media.js';
import { Link } from '../../app/router.js';
import {
  computerOf,
  filterOptions,
  homeSections,
  projectOf,
  searchQuestion,
  stableOrder,
  type NeedsSort,
} from '../../domain/lists.js';
import type { AgentStateView } from '../../domain/agentState.js';
import type { QuestionView } from '../../domain/model.js';
import { currentSubscription, isIos, isStandalone, pushSupport } from '../../features/push.js';
import { ArrowDown, CloseIcon, FilterIcon, OfflineIcon, SearchIcon } from '../Icons.js';
import { FilterChips, FilterSheet, type FacetValue } from './Filters.js';
import { QuestionRow, type PendingAnswer } from './QuestionRow.js';
import { StatusGlyph } from './StatusGlyph.js';
import { SearchField, useDebounced } from './SearchField.js';

export type Presentation = 'page' | 'sheet';

/* ---------------- search focus (Ctrl/⌘+K) ---------------- */

const searchInputs = new Set<HTMLInputElement>();
/** Opens Home's search when it is folded behind its round button (phones and tablets). */
let openHomeSearch: (() => void) | null = null;

/** Focus Home's own search if it is on screen, opening it if it is folded away. Returns false when there is none. */
export function focusNavigatorSearch(): boolean {
  for (const el of searchInputs) {
    if (el.isConnected && el.offsetParent !== null) {
      el.focus();
      el.select();
      return true;
    }
  }
  if (openHomeSearch) {
    openHomeSearch();
    return true;
  }
  return false;
}

export const isMac = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/* ---------------- empty and edge states ---------------- */

function useNotificationsReady(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pushSupport().ok) {
      setReady(false);
      return;
    }
    void currentSubscription()
      .then((s) => setReady(!!s && Notification.permission === 'granted'))
      .catch(() => setReady(false));
  }, []);
  return ready;
}

/**
 * A quiet offer of notifications, when this device would not hear about a new question: a sentence of its own
 * after another (`inline`), or a line on its own.
 */
function NotifyNudge({ inline = false }: { inline?: boolean }) {
  const ready = useNotificationsReady();
  if (ready !== false) return null;
  const needsInstall = isIos() && !isStandalone();
  const link = (
    <Link to={needsInstall ? '/install' : '/settings'} className="list-note-link">
      {needsInstall
        ? 'Add Decisions to your Home Screen to hear about new ones'
        : 'Turn on notifications to hear about new ones'}
    </Link>
  );
  return inline ? <> {link}.</> : link;
}

function Empty({
  icon,
  title,
  children,
  busy,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="nav-empty" role="status" aria-busy={busy || undefined}>
      {icon && <div className="nav-empty-icon">{icon}</div>}
      <p className="nav-empty-title">{title}</p>
      {children}
    </div>
  );
}

/* ---------------- filters ---------------- */

function facetCounts(
  all: QuestionView[],
  values: string[],
  pick: (v: QuestionView) => string,
  keep: (v: QuestionView) => boolean,
): FacetValue[] {
  const n = new Map(values.map((x) => [x, 0]));
  for (const v of all) {
    if (!v.content || !keep(v)) continue;
    const k = pick(v);
    const c = n.get(k);
    if (c !== undefined) n.set(k, c + 1);
  }
  return values.map((value) => ({ value, count: n.get(value) ?? 0 }));
}

/* ---------------- the panel ---------------- */

/**
 * Every question in one list: Home's list (`page`, at `/`) and a sheet over a question (`sheet`, opened by Ctrl/⌘+K).
 * Needs you comes first, then delivery problems and model answers to review, then everything else by day; one search
 * and one filter (computer and project, in a sheet) apply to all of it. On phones and tablets Home's tools are round
 * buttons floating top-right, beside the menu button, so the list starts at the top of the screen; in the wide column
 * and the sheet they sit above the list.
 */
export function NavigatorPanel({
  presentation,
  currentId,
}: {
  presentation: Presentation;
  currentId?: string;
}) {
  const snap = useApp();
  const all = useQuestions();
  const now = useNow();
  const agentOf = useAgentStates();
  const interacting = useInteracting();
  // What each row last showed of its agent. A mark that would appear or disappear changes the row's height, so it
  // waits while the person is touching or scrolling; a mark already on a row updates at once.
  const placed = useRef(new Map<string, AgentStateView | null>());
  const agentFor = (v: QuestionView): AgentStateView | null => {
    const next = agentOf(v);
    const had = placed.current.get(v.id);
    const shown = interacting && placed.current.has(v.id) && !had !== !next ? (had ?? null) : next;
    placed.current.set(v.id, shown);
    return shown;
  };
  const nav = useNavState().questions;
  const query = useDebounced(nav.query, 200);
  const wide = useWide();
  const floating = presentation === 'page' && !wide;
  const listRef = useRef<HTMLDivElement | null>(null);
  const uid = useId();
  const searchId = `${uid}-search`;
  const page = presentation === 'page';
  const Heading = page ? 'h2' : 'h3';

  /* ---- search: always open in the column and the sheet; behind a round button on phones ---- */
  const [searchOpen, setSearchOpen] = useState(() => nav.query !== '');
  const searchInput = useRef<HTMLInputElement | null>(null);
  const searchButton = useRef<HTMLButtonElement | null>(null);
  const focusSearch = useRef(false);
  const registerSearch = useCallback(
    (el: HTMLInputElement | null) => {
      if (searchInput.current) searchInputs.delete(searchInput.current);
      searchInput.current = el;
      if (el && page) searchInputs.add(el);
    },
    [page],
  );
  const openSearch = useCallback(() => {
    focusSearch.current = true;
    setSearchOpen(true);
    searchInput.current?.focus();
  }, []);
  const closeSearch = useCallback(() => {
    setQuestions({ query: '' });
    setSearchOpen(false);
    requestAnimationFrame(() => searchButton.current?.focus());
  }, []);
  // Opening by hand moves focus into the field; coming back to a list that still holds a query does not (it would
  // raise the keyboard over the list).
  useEffect(() => {
    if (searchOpen && focusSearch.current) {
      focusSearch.current = false;
      searchInput.current?.focus();
    }
  }, [searchOpen]);
  useEffect(() => {
    if (!floating) return;
    openHomeSearch = openSearch;
    return () => {
      if (openHomeSearch === openSearch) openHomeSearch = null;
    };
  }, [floating, openSearch]);

  /* ---- filters ---- */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const opts = useMemo(() => filterOptions(all), [all]);
  useEffect(() => resolvePersistedFilters(opts.projects, opts.computers), [opts]);
  const filters = useMemo(
    () => ({ project: nav.project, computer: nav.computer }),
    [nav.project, nav.computer],
  );
  const filtered = !!(nav.project || nav.computer);
  const activeFilters = (nav.project ? 1 : 0) + (nav.computer ? 1 : 0);
  const showFilter = opts.projects.length > 1 || opts.computers.length > 1 || filtered;
  // Each count says what choosing that value would show: under the search and the other facet. The options stay
  // the same whatever the counts.
  const facets = useMemo(() => {
    const matching = query.trim() ? all.filter((v) => searchQuestion(v, query) !== null) : all;
    return {
      computers: facetCounts(
        matching,
        opts.computers,
        computerOf,
        (v) => !nav.project || projectOf(v) === nav.project,
      ),
      projects: facetCounts(
        matching,
        opts.projects,
        projectOf,
        (v) => !nav.computer || computerOf(v) === nav.computer,
      ),
    };
  }, [all, opts, nav.project, nav.computer, query]);
  const filterLabel =
    activeFilters > 0 ? `Filter questions, ${activeFilters} active` : 'Filter questions';

  /* ---- answers and follow-ups from this device still in its outbox ---- */
  void snap.rev; // re-read outbox state on every app change
  const pendingById = new Map<string, PendingAnswer>();
  for (const e of app.outbox?.list() ?? []) {
    if (e.state !== 'queued' && e.state !== 'sending') continue;
    const kind = e.kind === 'message' ? 'message' : 'answer';
    const had = pendingById.get(e.questionId);
    // An answer on its way says more about the row than a follow-up behind it.
    if (!had || (had.kind === 'message' && kind === 'answer'))
      pendingById.set(e.questionId, { kind, state: e.state, selected: e.selected, text: e.text });
  }
  const refusedIds = refusedFollowUps();
  const refusedKey = [...refusedIds].sort().join(',');
  const refused = useMemo(() => new Set(refusedKey ? refusedKey.split(',') : []), [refusedKey]);
  const pendingKey = [...pendingById.keys()].sort().join(',');
  const pendingIds = useMemo(() => new Set(pendingKey ? pendingKey.split(',') : []), [pendingKey]);

  /* ---- sections, held still under the finger ---- */
  const sections = useMemo(
    () =>
      homeSections(all, { ...filters, sort: nav.sort, query, pending: pendingIds, refused }, now),
    [all, filters, nav.sort, query, pendingIds, refused, now],
  );
  const byId = useMemo(() => {
    const m = new Map<string, { v: QuestionView; section: number }>();
    sections.forEach((s, si) => s.items.forEach((v) => m.set(v.id, { v, section: si })));
    return m;
  }, [sections]);
  const fresh = useMemo(() => sections.flatMap((s) => s.items.map((v) => v.id)), [sections]);

  // Rows never reshuffle under the finger: hold the order on screen, offer newcomers deliberately.
  const firstSync = snap.syncing && !snap.lastSyncedAt;
  const viewKey = `${nav.sort}|${nav.project}|${nav.computer}|${query}`;
  const frozen = useRef<{ key: string; ids: string[] } | null>(null);
  const [, refresh] = useReducer((x: number) => x + 1, 0);
  let order: { ids: string[]; added: string[] };
  const f = frozen.current;
  if (!f || f.key !== viewKey || f.ids.length === 0 || firstSync) {
    order = { ids: fresh, added: [] };
  } else {
    order = stableOrder(f.ids, fresh);
    // The question you are on always belongs in the list you are looking at.
    if (currentId && order.added.includes(currentId)) order = { ids: fresh, added: [] };
  }
  frozen.current = { key: viewKey, ids: order.ids };
  const showNew = useCallback(() => {
    frozen.current = null;
    refresh();
    // Back to the top of whatever scrolls the list: the sheet's own list, the wide column, or the page.
    let sc: HTMLElement | null = listRef.current;
    while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    if (sc) sc.scrollTo?.({ top: 0 });
    else window.scrollTo?.({ top: 0 });
  }, []);

  const loading =
    snap.phase === 'loading' || (snap.syncing && all.length === 0 && !snap.lastSyncedAt);
  // Offline is the device's network; a socket between retries is reconnecting, not offline.
  const offline = !snap.online;
  const connected = snap.connection === 'live' || snap.connection === 'polling';
  const checking = !offline && (snap.syncing || !connected);
  const searching = query.trim().length > 0;

  useRestoreList('questions', listRef, page && !loading);

  // The current question is highlighted and kept in view.
  useEffect(() => {
    if (!currentId) return;
    const row = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [currentId, loading]);

  const onOpen = useCallback(
    (e: MouseEvent<HTMLAnchorElement>, id: string) =>
      rowClick(e, id, 'questions', { refocus: page }),
    [page],
  );

  const visible = order.ids.filter((id) => byId.has(id));
  const shown = sections.map((s, si) => ({
    s,
    ids: visible.filter((id) => byId.get(id)!.section === si),
  }));
  // Under load what follows Needs you falls below the fold: a long Needs you (more rows than a phone shows at once)
  // points to answers still waiting to leave this device and to model answers waiting for review.
  const countOf = (kind: string) => shown.find((x) => x.s.kind === kind)?.ids.length ?? 0;
  const needsCount = countOf('needs');
  const jumps =
    needsCount >= 8 && !searching
      ? [
          {
            key: 'sending',
            glyph: 'sending' as const,
            n: countOf('sending'),
            label: (n: number) => `${n} ${n === 1 ? 'answer' : 'answers'} waiting to send`,
          },
          {
            key: 'review',
            glyph: 'review' as const,
            n: countOf('review'),
            label: (n: number) => `${n} model ${n === 1 ? 'answer' : 'answers'} to review`,
          },
        ].filter((j) => j.n > 0)
      : [];
  const jumpTo = (key: string) => {
    const h = document.getElementById(`${uid}-${key}`);
    if (!h) return;
    const reduce = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    h.closest('section')?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    h.focus({ preventScroll: true });
  };

  let body: ReactNode;
  if (loading) {
    body = (
      <ul className="qlist" aria-busy="true" aria-label="Loading questions">
        {[0, 1, 2].map((i) => (
          <li key={i} className="qrow-item">
            <span className="qrow skeleton-row" />
          </li>
        ))}
      </ul>
    );
  } else if (all.length === 0) {
    body = offline ? (
      <Empty icon={<OfflineIcon size={20} />} title="You’re offline.">
        <p>Questions will appear here when you reconnect.</p>
      </Empty>
    ) : checking ? (
      <Empty busy title="Checking for questions…" />
    ) : (
      <Empty title="No questions yet.">
        <p>Questions your agents ask will appear here.</p>
        {page && <NotifyNudge />}
      </Empty>
    );
  } else if (visible.length === 0 && searching) {
    body = (
      <Empty icon={<SearchIcon size={20} />} title="No matches in questions saved on this device.">
        <p>Search covers the question, its context, project, computer and answers.</p>
      </Empty>
    );
  } else if (visible.length === 0 && filtered) {
    body = (
      <Empty title="No questions match these filters.">
        <button
          type="button"
          className="btn"
          onClick={() => setQuestions({ project: null, computer: null })}
        >
          Clear filters
        </button>
      </Empty>
    );
  } else {
    body = shown.map(({ s, ids }) => {
      const needs = s.kind === 'needs';
      // Searching shows only what matched; otherwise Needs you keeps its place and says when it is empty.
      if (ids.length === 0 && (!needs || searching || offline)) return null;
      const headId = `${uid}-${s.key}`;
      return (
        <section
          key={s.key}
          className="qgroup"
          data-section={s.kind === 'day' ? 'day' : s.kind}
          aria-labelledby={headId}
        >
          <div className="qgroup-head">
            <Heading className="qgroup-title" id={headId} tabIndex={-1}>
              {s.title}
              {s.kind !== 'day' && ids.length > 0 && (
                <span className={needs ? 'count waiting' : 'count'}>
                  <span className="sr-only">, </span>
                  {ids.length}
                </span>
              )}
            </Heading>
            {needs && ids.length > 1 && <SortSelect sort={nav.sort} />}
          </div>
          {needs &&
            jumps.map((j) => (
              <button key={j.key} type="button" className="jump-link" onClick={() => jumpTo(j.key)}>
                <StatusGlyph status={j.glyph} label={false} />
                {j.label(j.n)}
                {/* It moves down the list, so an arrow: the chevron beside it opens the sort picker. */}
                <ArrowDown size={14} />
              </button>
            ))}
          {ids.length > 0 ? (
            <ul className="qlist" aria-labelledby={headId}>
              {ids.map((id) => {
                const v = byId.get(id)!.v;
                return (
                  <QuestionRow
                    key={id}
                    v={v}
                    now={now}
                    selected={id === currentId}
                    extras={{ pending: pendingById.get(id), refused: refused.has(id) }}
                    agent={agentFor(v)}
                    onOpen={onOpen}
                  />
                );
              })}
            </ul>
          ) : checking ? (
            <p className="list-note" role="status" aria-busy="true">
              <span className="list-note-spin" aria-hidden="true" />
              Checking for questions…
            </p>
          ) : (
            <p className="list-note list-note-clear" role="status">
              {filtered ? 'Nothing in these filters needs you.' : 'Nothing needs you right now.'}
              {page && !filtered && <NotifyNudge inline />}
            </p>
          )}
        </section>
      );
    });
  }

  const count = visible.length;
  // Search and filter changes start the new results from the top and say how many questions now show (clearing the
  // last filter included); arrivals and other background changes do neither. Coming back to a list keeps its key,
  // so Back's restored position stands.
  const [said, setSaid] = useState('');
  const resultKey = `${query.trim()}|${nav.project ?? ''}|${nav.computer ?? ''}`;
  const lastKey = useRef(resultKey);
  useEffect(() => {
    if (lastKey.current === resultKey) return;
    lastKey.current = resultKey;
    let sc: HTMLElement | null = listRef.current;
    while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    if (sc) sc.scrollTo?.({ top: 0 });
    else window.scrollTo?.({ top: 0 });
    setSaid(
      searching
        ? `${count} ${count === 1 ? 'match' : 'matches'}`
        : `${count} ${count === 1 ? 'question' : 'questions'}`,
    );
    // Announce on a change of query or filters only, with the count as it stands then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultKey]);
  const tools = floating ? (
    <>
      {searchOpen && (
        <div className="float-search" role="search">
          <SearchField
            id={searchId}
            inputRef={registerSearch}
            value={nav.query}
            onChange={(q) => setQuestions({ query: q })}
            label="Search questions"
            placeholder="Search questions"
            clearable={false}
            onEscapeEmpty={closeSearch}
          />
        </div>
      )}
      <div className="float-tools">
        {showFilter && (
          <button
            type="button"
            className="float-btn"
            data-active={activeFilters > 0 || undefined}
            aria-label={filterLabel}
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(true)}
          >
            <FilterIcon size={20} />
            {activeFilters > 0 && (
              <span className="float-btn-badge" aria-hidden="true">
                {activeFilters}
              </span>
            )}
          </button>
        )}
        <button
          ref={searchButton}
          type="button"
          className="float-btn"
          aria-label={searchOpen ? 'Close search' : 'Search questions'}
          aria-expanded={searchOpen}
          aria-controls={searchOpen ? searchId : undefined}
          onClick={searchOpen ? closeSearch : openSearch}
        >
          {searchOpen ? <CloseIcon size={20} /> : <SearchIcon size={20} />}
        </button>
      </div>
    </>
  ) : (
    <div className="nav-tools">
      <div className="nav-tools-row" role="search">
        <SearchField
          id={searchId}
          inputRef={registerSearch}
          value={nav.query}
          onChange={(q) => setQuestions({ query: q })}
          label="Search questions"
          placeholder="Search questions"
          shortcut={page && wide ? (isMac() ? 'Meta+K' : 'Control+K') : undefined}
        />
        {showFilter && (
          <button
            type="button"
            className="btn icon nav-filter"
            data-active={activeFilters > 0 || undefined}
            aria-label={filterLabel}
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            title="Filter by computer or project"
            onClick={() => setFiltersOpen(true)}
          >
            <FilterIcon size={18} />
            {activeFilters > 0 && (
              <span className="float-btn-badge" aria-hidden="true">
                {activeFilters}
              </span>
            )}
          </button>
        )}
      </div>
      <FilterChips project={nav.project} computer={nav.computer} />
    </div>
  );

  return (
    <section
      className="navigator"
      data-presentation={presentation}
      data-tools={floating ? 'floating' : 'inline'}
      data-filter={showFilter || undefined}
      aria-labelledby={page ? 'questions-h' : undefined}
      aria-label={page ? undefined : 'Questions and answers'}
    >
      {page && (
        <h1 className="sr-only" id="questions-h" tabIndex={-1}>
          Questions
        </h1>
      )}
      {/* With nothing saved yet there is nothing to search or filter, so no tools that would do nothing. */}
      {(all.length > 0 || searching || filtered) && tools}
      <div className="nav-scroll" ref={listRef}>
        {floating && <FilterChips project={nav.project} computer={nav.computer} />}
        {offline && all.length > 0 && !loading && (
          <p className="list-note home-offline" role="status">
            <OfflineIcon size={16} />
            You’re offline. New questions will appear when you reconnect.
          </p>
        )}
        {order.added.length > 0 && (
          <button type="button" className="nav-new" onClick={showNew}>
            {order.added.length} new {order.added.length === 1 ? 'question' : 'questions'}
            <span className="sr-only">. Show them.</span>
          </button>
        )}
        {body}
        {!loading && count > 0 && snap.syncing && (
          <p className="nav-foot" role="status">
            Checking for more questions…
          </p>
        )}
      </div>
      <p className="sr-only" role="status">
        {said}
      </p>
      {showFilter && (
        <FilterSheet
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          computers={facets.computers}
          projects={facets.projects}
          computer={nav.computer}
          project={nav.project}
          resultCount={visible.length}
        />
      )}
    </section>
  );
}

/** The order of Needs you: soonest deadline (then oldest), or newest first. The platform's own picker. */
function SortSelect({ sort }: { sort: NeedsSort }) {
  return (
    <label className="qgroup-sort">
      <span aria-hidden="true">{sort === 'due' ? 'Due soonest' : 'Newest first'}</span>
      <select
        aria-label="Order of questions that need you"
        value={sort}
        onChange={(e) => setQuestions({ sort: e.target.value as NeedsSort })}
      >
        <option value="due">Due soonest</option>
        <option value="newest">Newest first</option>
      </select>
    </label>
  );
}
