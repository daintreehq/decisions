import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { useApp, useNow, useQuestions } from '../app/hooks.js';
import { useLayer } from '../app/layers.js';
import {
  openQuestion,
  rememberRow,
  setHistory,
  useNavState,
  useRestoreList,
} from '../app/listState.js';
import { useWide } from '../app/media.js';
import { ActivityTimeline } from '../components/history/ActivityTimeline.js';
import { ChevronLeft, CloseIcon, Origin, SearchIcon } from '../components/Icons.js';
import { NavGlyph } from '../components/NavGlyphs.js';
import { SearchField, useDebounced } from '../components/navigator/SearchField.js';
import { StatusGlyph } from '../components/navigator/StatusGlyph.js';
import { SafeText } from '../components/SafeText.js';
import {
  groupByDay,
  historyEntries,
  STATUS_LABEL,
  type HistoryEntry,
  type HistoryMode,
} from '../domain/lists.js';
import type { QuestionView } from '../domain/model.js';
import { hiddenQuestionText } from '../domain/selectors.js';
import { previewText } from '../lib/safe-text.js';

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function closedLine(e: HistoryEntry): string | null {
  if (e.status === 'expired') return 'Expired before anyone answered';
  if (e.status === 'withdrawn') return 'Withdrawn by your agent';
  if (e.status === 'unreadable') return 'This device holds no key for it';
  if (e.status === 'unverified') return 'Could not be verified';
  return null;
}

function HistoryRow({
  e,
  selected,
  onOpen,
}: {
  e: HistoryEntry;
  selected: boolean;
  onOpen: (id: string, el: HTMLElement) => void;
}) {
  const { v, answer } = e;
  const meta: ReactNode[] = [];
  if (e.status === 'review')
    meta.push(
      <span key="r" className="m">
        Model answer · review
      </span>,
    );
  if (e.changes > 0)
    meta.push(
      <span key="c" className="m">
        Changed {e.changes === 1 ? 'once' : `${e.changes} times`}
      </span>,
    );
  if (e.delivery)
    meta.push(
      <span key="d" className="m warn">
        Delivery issue
      </span>,
    );
  if (e.hit === 'earlier')
    meta.push(
      <span key="h" className="m hit">
        Matched an earlier answer
      </span>,
    );
  const closed = closedLine(e);
  return (
    <li className="qrow-item">
      <button
        type="button"
        className="qrow hrow"
        data-row-id={v.id}
        data-status={e.status}
        aria-current={selected ? 'true' : undefined}
        onClick={(ev) => onOpen(v.id, ev.currentTarget)}
      >
        <span className="qrow-glyph">
          <StatusGlyph status={e.status} />
        </span>
        <span className="qrow-top">
          <Origin v={v} />
          <time className="qrow-time" dateTime={e.at}>
            {clock(e.at)}
          </time>
        </span>
        <span className="qrow-q">
          {v.content ? previewText(v.content.question, 200) : hiddenQuestionText(v)}
        </span>
        {answer ? (
          <span className="qrow-a">
            <span className="who">
              {answer.author === 'You' ? 'You' : answer.confirmed ? 'Model, confirmed' : 'Model'}:
            </span>{' '}
            {answer.text || 'No note'}
          </span>
        ) : (
          closed && <span className="qrow-a closed">{closed}</span>
        )}
        {meta.length > 0 && <span className="qrow-meta">{meta}</span>}
        <span className="sr-only">, {STATUS_LABEL[e.status]}</span>
      </button>
    </li>
  );
}

/** A decision, read-only: the question, its context, and everything that happened to it. */
function Record({
  v,
  now,
  sheet,
  onClose,
}: {
  v: QuestionView;
  now: number;
  sheet: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const c = v.content;
  return (
    <article className="hist-record" aria-labelledby={titleId}>
      <header className="record-head">
        {sheet ? (
          <button type="button" className="btn ghost record-back" onClick={onClose}>
            <ChevronLeft size={20} />
            History
          </button>
        ) : (
          <button
            type="button"
            className="btn ghost icon"
            aria-label="Close record"
            title="Close (Esc)"
            onClick={onClose}
          >
            <CloseIcon size={18} />
          </button>
        )}
        <span className="record-head-fill" />
        <button
          type="button"
          className="btn small"
          onClick={() => openQuestion(v.id, 'history', null)}
        >
          Open question
        </button>
      </header>
      <div className="record-body">
        <p className="record-origin">
          <Origin v={v} />
        </p>
        <h2 className="record-q" id={titleId} tabIndex={-1}>
          {c ? <SafeText text={c.question} className="inline" /> : hiddenQuestionText(v)}
        </h2>
        {c?.context && (
          <details className="record-context">
            <summary>Context from the agent</summary>
            <SafeText text={c.context} />
          </details>
        )}
        <ActivityTimeline view={v} now={now} />
      </div>
    </article>
  );
}

/** Below 1100px the record is a full-height sheet over the list, so the list keeps its place underneath. */
function RecordSheet({
  v,
  now,
  onClose,
}: {
  v: QuestionView | undefined;
  now: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = !!v;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector<HTMLElement>('.record-q')?.focus({ preventScroll: true });
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="record-sheet"
      aria-label="Decision record"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {v && <Record v={v} now={now} sheet onClose={onClose} />}
    </dialog>
  );
}

const MODES: { id: HistoryMode; label: string }[] = [
  { id: 'decisions', label: 'Decisions' },
  { id: 'all', label: 'All activity' },
];

/**
 * History answers "what did I decide, why, and what changed?". Decisions or All activity, grouped by day, searched
 * locally over everything said (earlier answers and correction reasons included). A row opens its record beside
 * the list on wide screens and as a sheet on narrow ones; Back closes it with the list exactly as it was.
 */
export function HistoryPage() {
  const snap = useApp();
  const all = useQuestions();
  const now = useNow();
  const wide = useWide();
  const h = useNavState().history;
  const query = useDebounced(h.query, 200);
  const listRef = useRef<HTMLDivElement | null>(null);

  const entries = useMemo(() => historyEntries(all, h.mode, query, now), [all, h.mode, query, now]);
  const groups = useMemo(() => groupByDay(entries, (e) => e.at, now), [entries, now]);
  const record = h.record ? all.find((v) => v.id === h.record) : undefined;

  const close = () => setHistory({ record: null });
  const dismiss = useLayer(!!h.record, close);
  // A record that disappeared (deleted on the relay) closes rather than leaving an empty pane.
  useEffect(() => {
    if (h.record && snap.phase === 'ready' && !snap.syncing && !record) dismiss();
  }, [h.record, record, snap.phase, snap.syncing, dismiss]);

  const loading =
    snap.phase === 'loading' || (snap.syncing && all.length === 0 && !snap.lastSyncedAt);
  useRestoreList('history', listRef, !loading);

  const onOpen = (id: string, el: HTMLElement) => {
    rememberRow('history', id, el);
    setHistory({ record: id });
  };

  // Escape closes the record on wide screens too (the sheet handles its own).
  useEffect(() => {
    if (!wide || !h.record) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide, h.record, dismiss]);

  const searching = query.trim().length > 0;
  // Offline is the device's network; a socket between retries is reconnecting, not offline.
  const offline = !snap.online;
  const coverage = [
    searching ? 'Searching questions saved on this device' : 'Saved on this device',
    offline
      ? 'Offline'
      : snap.syncing
        ? 'Syncing…'
        : snap.lastSyncedAt
          ? `Synced ${clock(new Date(snap.lastSyncedAt).toISOString())}`
          : 'Not synced yet',
  ].join(' · ');

  let body: ReactNode;
  if (loading)
    body = (
      <ul className="qlist" aria-busy="true" aria-label="Loading history">
        {[0, 1, 2].map((i) => (
          <li key={i} className="qrow-item">
            <span className="qrow skeleton-row" />
          </li>
        ))}
      </ul>
    );
  else if (entries.length === 0)
    body = searching ? (
      <div className="nav-empty" role="status">
        <div className="nav-empty-icon">
          <SearchIcon size={20} />
        </div>
        <p className="nav-empty-title">No matches in questions saved on this device.</p>
        <button type="button" className="btn small" onClick={() => setHistory({ query: '' })}>
          Clear search
        </button>
      </div>
    ) : (
      <div className="nav-empty">
        <div className="nav-empty-icon">
          <NavGlyph name="history" size={20} />
        </div>
        <p className="nav-empty-title">
          {h.mode === 'decisions' ? 'No decisions yet.' : 'No activity yet.'}
        </p>
        <p>Questions you answer, and ones that expire or are withdrawn, appear here.</p>
      </div>
    );
  else
    body = groups.map((g) => (
      <section key={g.key} className="hgroup" aria-labelledby={`hg-${g.key}`}>
        <h2 className="hgroup-title" id={`hg-${g.key}`}>
          {g.label}
        </h2>
        <ul className="qlist">
          {g.items.map((e) => (
            <HistoryRow key={e.v.id} e={e} selected={e.v.id === h.record} onOpen={onOpen} />
          ))}
        </ul>
      </section>
    ));

  return (
    <div
      className="history"
      data-layout={wide ? 'split' : 'single'}
      data-record={record ? '' : undefined}
    >
      <div className="history-list" ref={listRef}>
        <div className="history-controls">
          <div className="page-head">
            <h1 className="page-title">History</h1>
            <div className="seg history-modes" role="group" aria-label="Show">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={h.mode === m.id}
                  onClick={() => setHistory({ mode: m.id, anchor: null })}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <SearchField
            value={h.query}
            onChange={(q) => setHistory({ query: q })}
            label="Search history"
            placeholder="Search questions and answers"
            describedBy="history-coverage"
          />
          <p className="coverage" id="history-coverage">
            {coverage}
          </p>
        </div>
        {body}
        <p className="sr-only" role="status">
          {searching ? `${entries.length} ${entries.length === 1 ? 'match' : 'matches'}` : ''}
        </p>
      </div>
      {wide ? (
        <div className="history-record">
          {record ? (
            <Record key={record.id} v={record} now={now} sheet={false} onClose={dismiss} />
          ) : (
            <div className="choose">
              <div className="choose-icon">
                <NavGlyph name="history" size={22} />
              </div>
              <h2>Choose a decision</h2>
              <p>See what was decided, by whom, and everything that changed since.</p>
            </div>
          )}
        </div>
      ) : (
        <RecordSheet v={record} now={now} onClose={dismiss} />
      )}
    </div>
  );
}
