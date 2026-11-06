import { useEffect, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
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
import { useSwipeClose } from '../components/useSwipeClose.js';
import { useDialogMotion } from '../components/useDialogMotion.js';
import {
  closedLine,
  groupByDay,
  historyEntries,
  optionLabels,
  projectOf,
  computerOf,
  queryTerms,
  STATUS_LABEL,
  type HistoryEntry,
  type HistoryMode,
} from '../domain/lists.js';
import type { QuestionView } from '../domain/model.js';
import { currentAnswer, hiddenQuestionText } from '../domain/selectors.js';
import { previewText } from '../lib/safe-text.js';

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Sets the matched words in a passage in bold, so the eye finds why it matched. */
function emphasise(text: string, terms: string[]): ReactNode[] {
  const folded = fold(text);
  const marks: [number, number][] = [];
  for (const term of terms)
    for (let i = folded.indexOf(term); i >= 0; i = folded.indexOf(term, i + term.length))
      marks.push([i, i + term.length]);
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    if (a > pos) out.push(text.slice(pos, a));
    out.push(<b key={a}>{text.slice(a, b)}</b>);
    pos = b;
  }
  out.push(text.slice(pos));
  return out;
}

interface Match {
  label: string;
  excerpt: ReactNode | null;
}

/**
 * Why a row matched when the reason is not on the row itself: a message, an earlier answer, or something about the
 * current answer the row does not show (its reason, the agent's context, an option). The passage holding the most of
 * the terms is quoted, cut to a short window around the first of them. Null when the row already shows every term.
 */
function searchMatch(e: HistoryEntry, query: string): Match | null {
  const terms = queryTerms(query);
  const { v, answer } = e;
  if (!terms.length || !e.hit) return null;
  const current = currentAnswer(v);
  let passages: { label: string; text: string }[];
  if (e.hit === 'thread')
    passages = v.messages
      .filter((m) => m.verified)
      .map((m) => ({ label: 'Matched a message', text: m.text }));
  else if (e.hit === 'earlier')
    passages = v.actions
      .filter((a) => a.verified && a.content && a !== current)
      .flatMap((a) =>
        [optionLabels(v, a).join(', '), a.content?.text ?? '', a.content?.reason ?? ''].map(
          (text) => ({ label: 'Matched an earlier answer', text }),
        ),
      );
  else {
    const c = v.content;
    // What the row actually shows: the question and the answer are clamped to two lines, so only their openings
    // count as visible; a term further in is explained like any other hidden match.
    const opening = (t: string) => t.replace(/\s+/g, ' ').slice(0, 80);
    const shown = fold(
      [opening(c?.question ?? ''), opening(answer?.text ?? ''), projectOf(v), computerOf(v)].join(
        ' ',
      ),
    );
    if (terms.every((t) => shown.includes(t))) return null;
    passages = [
      { label: 'Matched the question', text: c?.question ?? '' },
      { label: 'Matched the answer', text: answer?.text ?? '' },
      { label: 'Matched the reason', text: current?.content?.reason ?? '' },
      { label: 'Matched the context', text: c?.context ?? '' },
      ...(c?.options ?? []).map((o) => ({
        label: 'Matched an option',
        text: [o.label, o.description ?? ''].filter(Boolean).join(' — '),
      })),
      { label: 'Matched the summary', text: c?.origin_summary ?? '' },
    ];
  }
  let best: { label: string; t: string; f: string; n: number } | null = null;
  for (const p of passages) {
    const t = p.text.replace(/\s+/g, ' ').trim();
    const f = fold(t);
    const n = terms.filter((term) => f.includes(term)).length;
    if (n > 0 && (!best || n > best.n)) best = { label: p.label, t, f, n };
  }
  if (!best) return e.hit === 'current' ? null : { label: passages[0]?.label ?? '', excerpt: null };
  const { t, f } = best;
  const at = Math.min(...terms.map((term) => f.indexOf(term)).filter((i) => i >= 0));
  const start = at > 32 ? t.lastIndexOf(' ', at - 24) + 1 : 0;
  const text = (start > 0 ? '…' : '') + previewText(t.slice(start), 96);
  return { label: best.label, excerpt: emphasise(text, terms) };
}

function HistoryRow({
  e,
  query,
  selected,
  onOpen,
}: {
  e: HistoryEntry;
  query: string;
  selected: boolean;
  onOpen: (id: string, el: HTMLElement, keyboard: boolean) => void;
}) {
  const { v, answer } = e;
  const meta: ReactNode[] = [];
  if (e.status === 'review')
    meta.push(
      <span key="r" className="m">
        Not yet reviewed
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
      <span key="d" className="m warn" aria-hidden="true">
        Delivery issue
      </span>,
    );
  const match = searchMatch(e, query);
  const closed = closedLine(e.status);
  const model = answer && answer.author !== 'You';
  return (
    <li className="qrow-item">
      <button
        type="button"
        className="qrow hrow"
        data-row-id={v.id}
        data-status={e.status}
        aria-current={selected ? 'true' : undefined}
        // A keyboard activation (no pointer, detail 0) takes focus into the record; a tap or click leaves it here.
        onClick={(ev) => onOpen(v.id, ev.currentTarget, ev.detail === 0)}
      >
        <span className="qrow-glyph">
          <StatusGlyph status={e.status} label={false} />
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
            <span className={model ? 'who model' : 'who'}>
              {!model ? 'You' : answer.confirmed ? 'Model answer, confirmed' : 'Model answer'}:
            </span>{' '}
            {answer.text || 'No note'}
          </span>
        ) : (
          closed && <span className="qrow-a closed">{closed}</span>
        )}
        {meta.length > 0 && <span className="qrow-meta">{meta}</span>}
        {match && (
          <span className="hrow-hit">
            <span className="hrow-hit-label">
              {match.label}
              {match.excerpt && <span aria-hidden="true">:</span>}
            </span>
            {match.excerpt && <span className="hrow-hit-text"> {match.excerpt}</span>}
          </span>
        )}
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
  const previous = useRef(v);
  if (v) previous.current = v;
  const present = useDialogMotion(ref, open);
  const shown = present ? (v ?? previous.current) : undefined;
  const swipe = useSwipeClose(ref, 'right', onClose);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      d.querySelector<HTMLElement>('.record-q')?.focus({ preventScroll: true });
    }
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
      <div style={{ height: '100%' }} {...swipe}>
        {shown && <Record v={shown} now={now} sheet onClose={onClose} />}
      </div>
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

  const paneRef = useRef<HTMLDivElement | null>(null);
  const focusPane = useRef(false);
  const onOpen = (id: string, el: HTMLElement, keyboard: boolean) => {
    rememberRow('history', id, el);
    focusPane.current = keyboard && wide;
    setHistory({ record: id });
  };
  // Each record opens at its top (the pane stays mounted between records, so it would keep the last one's scroll),
  // and a record opened from the keyboard takes focus at its question.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane || !h.record) return;
    pane.scrollTop = 0;
    if (focusPane.current) {
      focusPane.current = false;
      pane.querySelector<HTMLElement>('.record-q')?.focus({ preventScroll: true });
    }
  }, [h.record]);

  // Closing the wide pane from inside it hands focus back to the row it came from (the sheet's dialog does this
  // itself), so focus never falls to the page when the pane empties.
  const closePane = () => {
    const id = h.record;
    const inside = !!document.activeElement?.closest('.history-record');
    dismiss();
    if (!inside || !id) return;
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true }),
    );
  };
  const closePaneRef = useRef(closePane);
  closePaneRef.current = closePane;

  // Escape closes the record on wide screens too (the sheet handles its own).
  useEffect(() => {
    if (!wide || !h.record) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closePaneRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide, h.record]);

  const searching = query.trim().length > 0;
  // Offline is the device's network; a socket between retries is reconnecting, not offline.
  const offline = !snap.online;
  const coverage = [
    searching ? 'Searching questions saved on this device' : 'Saved on this device',
    offline
      ? snap.lastSyncedAt
        ? `Offline · Synced ${clock(new Date(snap.lastSyncedAt).toISOString())}`
        : 'Offline'
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
      <div className="nav-empty">
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
        <p>
          {h.mode === 'decisions'
            ? 'Questions you answer, and ones that expire or are withdrawn, appear here.'
            : 'Everything decided, and model answers still to review, appears here.'}
        </p>
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
            <HistoryRow
              key={e.v.id}
              e={e}
              query={query}
              selected={e.v.id === h.record}
              onOpen={onOpen}
            />
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
        <div className="history-record" ref={paneRef}>
          {record ? (
            <Record key={record.id} v={record} now={now} sheet={false} onClose={closePane} />
          ) : loading || entries.length === 0 ? null : (
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
