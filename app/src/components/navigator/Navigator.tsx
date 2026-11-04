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
import { useApp, useNow, useQuestions } from '../../app/hooks.js';
import {
  resolvePersistedFilters,
  rowClick,
  setQuestions,
  useNavState,
  useRestoreList,
} from '../../app/listState.js';
import { useWide } from '../../app/media.js';
import { Link, usePath } from '../../app/router.js';
import {
  filterOptions,
  navigatorGroups,
  scopeCounts,
  stableOrder,
  type NeedsSort,
  type Scope,
} from '../../domain/lists.js';
import type { QuestionView } from '../../domain/model.js';
import { currentSubscription, isIos, isStandalone, pushSupport } from '../../features/push.js';
import { CloseIcon, OfflineIcon, SearchIcon, SuccessIcon } from '../Icons.js';
import { QuestionRow } from './QuestionRow.js';
import { SearchField, useDebounced } from './SearchField.js';

export type Presentation = 'page' | 'sheet';

/* ---------------- search focus (Ctrl/⌘+K) ---------------- */

const searchInputs = new Set<HTMLInputElement>();

/** Focus the Home list's own search if it is on screen. Returns false when there is none. */
export function focusNavigatorSearch(): boolean {
  for (const el of searchInputs) {
    if (el.isConnected && el.offsetParent !== null) {
      el.focus();
      el.select();
      return true;
    }
  }
  return false;
}

export const isMac = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/* ---------------- drafts ---------------- */

const MAX_DRAFT_LOOKUPS = 60;

/** Which of these questions hold an unsent draft on this device (sealed at rest, so read through the store). */
function useDrafts(ids: string[]): Set<string> {
  const path = usePath();
  const [found, setFound] = useState<Set<string>>(() => new Set());
  const key = ids.slice(0, MAX_DRAFT_LOOKUPS).join(',');
  useEffect(() => {
    const drafts = app.drafts;
    if (!drafts || !key) {
      setFound(new Set());
      return;
    }
    let live = true;
    void Promise.all(
      key.split(',').map(async (id) => {
        try {
          const d = await drafts.load(id);
          return d && (d.text?.trim() || d.selected?.length || d.reason?.trim()) ? id : null;
        } catch {
          return null;
        }
      }),
    ).then((r) => {
      if (live) setFound(new Set(r.filter((x): x is string => !!x)));
    });
    return () => {
      live = false;
    };
    // Leaving a question flushes its draft, so look again whenever the route changes.
  }, [key, path]);
  return found;
}

/* ---------------- empty states ---------------- */

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

function AllClear({ compact }: { compact: boolean }) {
  const ready = useNotificationsReady();
  const needsInstall = isIos() && !isStandalone();
  return (
    <Empty icon={<SuccessIcon size={20} />} title="Nothing needs you right now.">
      {ready === false && !compact ? (
        <>
          <p>
            {needsInstall
              ? 'To hear when a question arrives, add Decisions to your Home Screen.'
              : 'Turn on notifications to hear when a question arrives.'}
          </p>
          <Link to={needsInstall ? '/install' : '/settings'} className="btn small">
            {needsInstall ? 'Add to Home Screen' : 'Turn on notifications'}
          </Link>
        </>
      ) : (
        <p>New questions from your agents appear here.</p>
      )}
    </Empty>
  );
}

/* ---------------- the panel ---------------- */

const SCOPES: { id: Scope; label: string; unit: string }[] = [
  { id: 'needs', label: 'Needs you', unit: ' waiting' },
  { id: 'model', label: 'Model answers', unit: ' to review' },
  { id: 'all', label: 'All', unit: '' },
];

/**
 * The Questions & answers navigator: one model, two presentations. Home's list (`page`, at `/`) and a sheet over a
 * question (`sheet`, opened by the dock's All Q&A or Ctrl/⌘+K). Same scopes, counts, filters, search and selection
 * in both.
 */
export function NavigatorPanel({
  presentation,
  currentId,
  title,
}: {
  presentation: Presentation;
  currentId?: string;
  /** Rendered above the controls (the page's heading). */
  title?: ReactNode;
}) {
  const snap = useApp();
  const all = useQuestions();
  const now = useNow();
  const nav = useNavState().questions;
  const query = useDebounced(nav.query, 200);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const wide = useWide();
  const listRef = useRef<HTMLDivElement | null>(null);
  const uid = useId();

  const opts = useMemo(() => filterOptions(all), [all]);
  useEffect(() => resolvePersistedFilters(opts.projects, opts.computers), [opts]);

  const filters = useMemo(
    () => ({ project: nav.project, computer: nav.computer }),
    [nav.project, nav.computer],
  );
  const counts = useMemo(() => scopeCounts(all, filters, now), [all, filters, now]);
  const groups = useMemo(
    () => navigatorGroups(all, { ...filters, scope: nav.scope, sort: nav.sort, query }, now),
    [all, filters, nav.scope, nav.sort, query, now],
  );
  const byId = useMemo(() => {
    const m = new Map<string, { v: QuestionView; group: number }>();
    groups.forEach((g, gi) => g.items.forEach((v) => m.set(v.id, { v, group: gi })));
    return m;
  }, [groups]);
  const fresh = useMemo(() => groups.flatMap((g) => g.items.map((v) => v.id)), [groups]);

  // Rows never reshuffle under the finger: hold the order on screen, offer newcomers deliberately.
  const firstSync = snap.syncing && !snap.lastSyncedAt;
  const viewKey = `${nav.scope}|${nav.sort}|${nav.project}|${nav.computer}|${query}`;
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
    listRef.current?.scrollTo?.({ top: 0 });
  }, []);

  const drafts = useDrafts(order.ids);
  void snap.rev; // re-read outbox state on every app change
  const pending = (id: string) => app.outbox?.pendingState(id);

  const loading =
    snap.phase === 'loading' || (snap.syncing && all.length === 0 && !snap.lastSyncedAt);
  // Offline is the device's network; a socket between retries is reconnecting, not offline.
  const offline = !snap.online;
  const connected = snap.connection === 'live' || snap.connection === 'polling';
  const filtered = !!(nav.project || nav.computer);
  const searching = query.trim().length > 0;

  useRestoreList('questions', listRef, presentation === 'page' && !loading);

  // The current question is highlighted and kept in view.
  useEffect(() => {
    if (presentation === 'page' || !currentId) return;
    const row = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [currentId, presentation, loading]);

  const registerSearch = useCallback(
    (el: HTMLInputElement | null) => {
      if (searchRef.current) searchInputs.delete(searchRef.current);
      searchRef.current = el;
      if (el && presentation === 'page') searchInputs.add(el);
    },
    [presentation],
  );

  const onOpen = useCallback(
    (e: MouseEvent<HTMLAnchorElement>, id: string) =>
      rowClick(e, id, 'questions', { refocus: presentation === 'page' }),
    [presentation],
  );

  const setScope = (scope: Scope) => {
    if (scope !== nav.scope) setQuestions({ scope, anchor: null });
  };

  const showFilters =
    opts.projects.length > 1 || opts.computers.length > 1 || filtered || nav.scope === 'needs';
  const visible = order.ids.filter((id) => byId.has(id));

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
  } else if (visible.length === 0) {
    if (searching)
      body = (
        <Empty
          icon={<SearchIcon size={20} />}
          title="No matches in questions saved on this device."
        >
          <p>Search covers the question, its context, project, computer and answers.</p>
        </Empty>
      );
    else if (filtered)
      body = (
        <Empty title="No questions match these filters.">
          <button
            type="button"
            className="btn small"
            onClick={() => setQuestions({ project: null, computer: null })}
          >
            Clear filters
          </button>
        </Empty>
      );
    else if (nav.scope === 'needs' && offline)
      body = (
        <Empty icon={<OfflineIcon size={20} />} title="You're offline.">
          <p>New questions will appear when you reconnect.</p>
        </Empty>
      );
    else if (nav.scope === 'needs' && (snap.syncing || !connected))
      // Never an all-clear while the relay has not been checked.
      body = <Empty busy title="Checking for more questions…" />;
    else if (nav.scope === 'needs') body = <AllClear compact={presentation !== 'page'} />;
    else if (nav.scope === 'model')
      body = (
        <Empty title="No model answers to review.">
          <p>When the decision model answers for you, you can confirm or change it here.</p>
        </Empty>
      );
    else
      body = (
        <Empty title="No questions yet.">
          <p>Questions your agents ask will be listed here.</p>
        </Empty>
      );
  } else {
    const shownGroups = groups
      .map((g, gi) => ({
        g,
        ids: visible.filter((id) => byId.get(id)!.group === gi),
      }))
      .filter((x) => x.ids.length > 0);
    body = shownGroups.map(({ g, ids }) => (
      <section
        key={g.key}
        className="qgroup"
        aria-labelledby={g.title ? `${uid}-${g.key}` : undefined}
      >
        {g.title && (
          <h3 className="qgroup-title" id={`${uid}-${g.key}`}>
            {g.title}
            <span className="count">{ids.length}</span>
          </h3>
        )}
        <ul className="qlist" aria-label={g.title ?? 'Questions'}>
          {ids.map((id) => {
            const v = byId.get(id)!.v;
            return (
              <QuestionRow
                key={id}
                v={v}
                now={now}
                selected={id === currentId}
                showStatusWord={nav.scope === 'all'}
                extras={{ draft: drafts.has(id), pending: pending(id) }}
                onOpen={onOpen}
              />
            );
          })}
        </ul>
      </section>
    ));
  }

  return (
    <section
      className="navigator"
      data-presentation={presentation}
      aria-label="Questions and answers"
    >
      <div className="nav-controls">
        {title}
        <div className="seg nav-scopes" role="group" aria-label="Show">
          {SCOPES.map(({ id, label, unit }) => {
            const n = id === 'needs' ? counts.needs : id === 'model' ? counts.model : 0;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={nav.scope === id}
                onClick={() => setScope(id)}
              >
                {label}
                {n > 0 && (
                  <span className={id === 'needs' ? 'count waiting' : 'count'}>
                    <span className="sr-only">, </span>
                    {n}
                    <span className="sr-only">{unit}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <SearchField
          inputRef={registerSearch}
          value={nav.query}
          onChange={(q) => setQuestions({ query: q })}
          label="Search questions"
          placeholder="Search questions"
          shortcut={
            presentation === 'page' && wide ? (isMac() ? 'Meta+K' : 'Control+K') : undefined
          }
        />
        {showFilters && (
          <FilterBar
            projects={opts.projects}
            computers={opts.computers}
            project={nav.project}
            computer={nav.computer}
            sort={nav.scope === 'needs' && visible.length > 1 ? nav.sort : null}
            showClear={visible.length > 0 || searching}
          />
        )}
      </div>
      <div className="nav-scroll" ref={listRef}>
        {order.added.length > 0 && (
          <button type="button" className="nav-new" onClick={showNew}>
            {order.added.length} new {order.added.length === 1 ? 'question' : 'questions'}
            <span className="sr-only">. Show them.</span>
          </button>
        )}
        {body}
        {!loading && visible.length > 0 && snap.syncing && (
          <p className="nav-foot" role="status">
            Checking for more questions…
          </p>
        )}
      </div>
      <p className="sr-only" role="status">
        {searching ? `${visible.length} ${visible.length === 1 ? 'match' : 'matches'}` : ''}
      </p>
    </section>
  );
}

/* ---------------- filters ---------------- */

function FilterSelect({
  label,
  values,
  onPick,
}: {
  label: string;
  values: string[];
  onPick: (v: string) => void;
}) {
  return (
    <label className="fchip select">
      <span aria-hidden="true">{label}</span>
      <select
        value=""
        aria-label={`Filter by ${label.toLowerCase()}`}
        onChange={(e) => e.target.value && onPick(e.target.value)}
      >
        <option value="">{`Any ${label.toLowerCase()}`}</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActiveChip({
  kind,
  value,
  onRemove,
}: {
  kind: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      className="fchip on"
      onClick={onRemove}
      aria-label={`${kind}: ${value}. Remove filter`}
      title={`${kind}: ${value}`}
    >
      <span className="fchip-label">{value}</span>
      <CloseIcon size={13} />
    </button>
  );
}

function FilterBar({
  projects,
  computers,
  project,
  computer,
  sort,
  showClear,
}: {
  showClear: boolean;
  projects: string[];
  computers: string[];
  project: string | null;
  computer: string | null;
  sort: NeedsSort | null;
}) {
  const any = !!(project || computer);
  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      {project ? (
        <ActiveChip
          kind="Project"
          value={project}
          onRemove={() => setQuestions({ project: null })}
        />
      ) : (
        projects.length > 1 && (
          <FilterSelect
            label="Project"
            values={projects}
            onPick={(p) => setQuestions({ project: p })}
          />
        )
      )}
      {computer ? (
        <ActiveChip
          kind="Computer"
          value={computer}
          onRemove={() => setQuestions({ computer: null })}
        />
      ) : (
        computers.length > 1 && (
          <FilterSelect
            label="Computer"
            values={computers}
            onPick={(c) => setQuestions({ computer: c })}
          />
        )
      )}
      {any && showClear && (
        <button
          type="button"
          className="fclear"
          onClick={() => setQuestions({ project: null, computer: null })}
        >
          Clear filters
        </button>
      )}
      {sort && (
        <label className="fchip select fsort">
          <span aria-hidden="true">{sort === 'due' ? 'Due soonest' : 'Newest first'}</span>
          <select
            aria-label="Order"
            value={sort}
            onChange={(e) => setQuestions({ sort: e.target.value as NeedsSort })}
          >
            <option value="due">Due soonest</option>
            <option value="newest">Newest first</option>
          </select>
        </label>
      )}
    </div>
  );
}
