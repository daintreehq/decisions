import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { ProtocolFeature } from '@daintreehq/decisions-protocol';
import { app } from '../../app/controller.js';
import { useApp, useNow } from '../../app/hooks.js';
import { useLayer } from '../../app/layers.js';
import type { RefreshOutcome } from '../../data/snapshots.js';
import type { QuestionView } from '../../domain/model.js';
import { originParts } from '../../domain/selectors.js';
import { terminalButtonName, terminalView, type TerminalView } from '../../domain/terminal.js';
import { CloseIcon, RefreshIcon, TerminalIcon } from '../Icons.js';
import { useSwipeClose } from '../useSwipeClose.js';

const SNAPSHOT_FEATURE: ProtocolFeature = 'pane-snapshots-v1';
const DRAWER_ID = 'terminal-drawer';
const BUTTON_ID = 'terminal-button';

const noSubscribe = () => () => undefined;
const noVersion = () => 0;

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Whether this relay serves pane snapshots at all. Until it says so, the chat shows no terminal button. */
export function useTerminalServed(): boolean {
  const snap = useApp();
  return snap.info?.features?.includes(SNAPSHOT_FEATURE) ?? false;
}

/** Whether the modal drawer is open: the chat behind it, dock included, takes no commands meanwhile. */
export const terminalModalOpen = (): boolean =>
  !!document.querySelector(`dialog#${DRAWER_ID}[open]`);

/**
 * The question's terminal as the drawer shows it, re-read on every change to its snapshot (new lines included) and,
 * while `ticking`, every second so "as of 12 s ago" counts up.
 */
function useTerminal(view: QuestionView, ticking: boolean) {
  useApp(); // the snapshot store appears when the app boots
  const store = app.snapshots;
  useSyncExternalStore(store?.subscribeDetail ?? noSubscribe, store?.getDetailVersion ?? noVersion);
  useNow(ticking ? 1000 : 30_000);
  const relayNow = store?.relayNow() ?? Date.now();
  const tv = terminalView(
    store?.get(view.id),
    view.status,
    relayNow,
    store?.isRequesting(view.id) ?? false,
  );
  const refusal = store?.refreshRefusal(view.id);
  const attempt = store?.lastAttempt(view.id);
  // Each finished request counts once, even when it ends the same way as the last one.
  const attemptKey = attempt?.outcome ? `${attempt.n}:${attempt.outcome}` : '';
  return { tv, refusal, attemptKey, store };
}

/**
 * The chat header's terminal button: the asking pane at a glance. A small dot on its shoulder carries the observed
 * state's colour (working green, waiting amber, neutral otherwise; a hollow ring once the observation is old), and
 * its name says the state in words, so the dot is never the only signal.
 */
export function TerminalButton({
  view,
  open,
  docked,
  onOpen,
}: {
  view: QuestionView;
  open: boolean;
  /** The drawer sits beside the chat (wide screens) rather than over it. */
  docked: boolean;
  onOpen: () => void;
}) {
  const { tv } = useTerminal(view, false);
  const dot = tv.kind === 'snapshot' && tv.state ? tv : null;
  return (
    <button
      type="button"
      id={BUTTON_ID}
      className="btn ghost icon ws-terminal"
      aria-label={terminalButtonName(tv)}
      title="Terminal"
      aria-haspopup={docked ? undefined : 'dialog'}
      aria-expanded={open}
      aria-controls={open ? DRAWER_ID : undefined}
      data-open={open || undefined}
      onClick={onOpen}
    >
      <TerminalIcon />
      {dot && (
        <span
          className="agent-state ws-terminal-dot"
          data-tone={dot.tone}
          data-fresh={dot.stale ? 'stale' : 'fresh'}
          aria-hidden="true"
        >
          <span className="agent-dot" />
        </span>
      )}
    </button>
  );
}

/**
 * The asking agent's terminal, as its desktop last published it: the pane's title, what Daintree observed there,
 * how fresh that is, and the newest lines. A snapshot, never a live or interactive terminal: nothing here sends
 * input. Opening it asks the desktop for a fresh one; if none arrives (the computer asleep or offline) the last one
 * stays, marked stale with its age.
 *
 * Below 1100px it is revealed beneath the chat as the canvas slides left (Back, Escape, a right swipe or a tap on the
 * chat close it). From 1100px it sits beside the chat as a column, and the chat stays usable.
 */
export function TerminalDrawer({
  view,
  open,
  docked,
  onClose,
}: {
  view: QuestionView;
  open: boolean;
  docked: boolean;
  onClose: () => void;
}) {
  const dismiss = useLayer(open, onClose);
  const { tv, refusal, attemptKey, store } = useTerminal(view, open);
  const titleId = useId();
  const descId = useId();
  const { machine } = originParts(view);
  const computer = machine || 'Your computer';

  // Opening asks for a fresh snapshot, and reads the current one again in case a hint was missed. A desktop that
  // does not share its panes refuses requests, so none is spent on it (the relay allows a phone six a minute).
  const askable = tv.kind === 'snapshot' || tv.kind === 'none';
  useEffect(() => {
    if (!open || !store) return;
    store.request(view.id);
    if (askable) void store.requestRefresh(view.id);
  }, [open, store, view.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [message, speak] = useOutcomeMessage(open, tv, refusal, attemptKey, computer);
  // A tap is confirmed at once; what came of it is said when it settles.
  const refresh = () => {
    speak(`Asking ${computer} for a newer snapshot.`);
    void store?.requestRefresh(view.id);
  };
  const content = (
    <TerminalContent
      tv={tv}
      refusal={refusal}
      computer={computer}
      titleId={titleId}
      descId={descId}
      message={message}
      onRefresh={refresh}
      onClose={dismiss}
    />
  );
  if (docked)
    return open ? (
      <DockedTerminal titleId={titleId} descId={descId} onClose={dismiss}>
        {content}
      </DockedTerminal>
    ) : null;
  return (
    <ModalTerminal open={open} titleId={titleId} descId={descId} onClose={dismiss}>
      {content}
    </ModalTerminal>
  );
}

/**
 * What the drawer says once when its picture changes while it is open: the outcome of a refresh (a newer snapshot,
 * no reply, a refusal), the first snapshot arriving, or the observed state changing. The ticking age, the lines and
 * a busy agent's routine republishing stay silent. It is spoken from inside the drawer, since a modal dialog leaves
 * the rest of the page (and its live region) inert.
 */
function useOutcomeMessage(
  open: boolean,
  tv: TerminalView,
  refusal: RefreshOutcome | undefined,
  attemptKey: string,
  computer: string,
): readonly [string, (say: string) => void] {
  const [message, setMessage] = useState('');
  // The same words twice in a row still count as news: a trailing space makes the region change.
  const speak = useCallback((say: string) => setMessage((m) => (m === say ? `${say} ` : say)), []);
  const prev = useRef<{ key: string; tv: TerminalView; attempt: string } | null>(null);
  const key =
    tv.kind === 'snapshot'
      ? `s|${tv.words}|${tv.snapshotId}|${tv.refreshing}|${tv.unanswered}|${tv.stale}`
      : tv.kind === 'none'
        ? `n|${tv.phase}`
        : tv.kind;
  useEffect(() => {
    if (!open) {
      prev.current = null;
      setMessage('');
      return;
    }
    const before = prev.current;
    prev.current = { key: `${key}|${attemptKey}`, tv, attempt: attemptKey };
    if (!before || before.key === prev.current.key) return;
    const was = before.tv;
    let say = '';
    if (refusal && attemptKey !== before.attempt)
      say = refusalLine(refusal, computer, tv.kind === 'snapshot');
    else if (tv.kind === 'snapshot' && was.kind === 'snapshot') {
      if (tv.words !== was.words && tv.words) say = `Now ${lower(tv.words)}.`;
      // News when it answers a request, or ends a stale spell (the computer woke up); routine republishing is not.
      else if (tv.snapshotId !== was.snapshotId && (was.refreshing || (was.stale && !tv.stale)))
        say = 'Terminal snapshot updated.';
      else if (tv.unanswered && !was.unanswered) say = `${computer} didn’t send a newer snapshot.`;
      else if (tv.stale && !was.stale && tv.snapshotId === was.snapshotId)
        say = 'This terminal snapshot is now stale.';
    } else if (tv.kind === 'snapshot') {
      say = `Terminal snapshot received${tv.words ? `: ${lower(tv.words)}` : ''}.`;
    } else if (tv.kind === 'none' && tv.phase === 'unanswered' && was.kind === 'none')
      say = `${computer} didn’t reply.`;
    else if (tv.kind === 'off') say = 'Terminal sharing is off on that computer.';
    if (say) speak(say);
  }, [open, key, attemptKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return [message, speak] as const;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Why a newer snapshot could not be asked for, as the note under the freshness line (or the empty state). */
function refusalLine(r: RefreshOutcome, computer: string, withSnapshot: boolean): string {
  const one = withSnapshot ? 'a newer snapshot' : 'one';
  switch (r) {
    case 'offline':
      return `You’re offline, so ${one} can’t be asked for.`;
    case 'limited':
      return `Asked several times in a row. Try again in a moment.`;
    case 'unavailable':
      return `${computer} isn’t taking requests for snapshots right now.`;
    default:
      return `Couldn’t ask ${computer} for ${one}. Try again in a moment.`;
  }
}

function ModalTerminal({
  open,
  titleId,
  descId,
  onClose,
  children,
}: {
  open: boolean;
  titleId: string;
  descId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // The contents stay through the exit slide, so what leaves is what was being read.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.terminalDragging;
      document.documentElement.style.removeProperty('--terminal-offset');
    },
    [],
  );
  const panelWidth = () =>
    ref.current?.querySelector<HTMLElement>('.term-panel-body')?.offsetWidth ?? 0;
  const swipe = useSwipeClose(ref, 'right', onClose, {
    width: panelWidth,
    move: (distance) => {
      const root = document.documentElement;
      if (distance === null) {
        delete root.dataset.terminalDragging;
        root.style.removeProperty('--terminal-offset');
      } else {
        root.dataset.terminalDragging = '';
        root.style.setProperty('--terminal-offset', `${Math.max(0, panelWidth() - distance)}px`);
      }
    },
  });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.removeAttribute('data-closing');
      d.style.transform = '';
      d.showModal();
      document.getElementById(titleId)?.focus({ preventScroll: true });
      return;
    }
    if (!open && d.open) {
      const finish = () => {
        d.removeAttribute('data-closing');
        d.style.transform = '';
        d.close();
        setMounted(false);
        document.getElementById(BUTTON_ID)?.focus({ preventScroll: true });
      };
      if (reducedMotion()) {
        finish();
        return;
      }
      d.setAttribute('data-closing', '');
      d.style.transform = '';
      const t = setTimeout(finish, 380);
      return () => clearTimeout(t);
    }
  }, [open, titleId]);
  return (
    <dialog
      ref={ref}
      id={DRAWER_ID}
      className="term-drawer"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // The panel occupies the right edge; a click on the transparent dialog is on the exposed chat.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {mounted && (
        <div className="term-panel-body" {...swipe}>
          {children}
        </div>
      )}
    </dialog>
  );
}

function DockedTerminal({
  titleId,
  descId,
  onClose,
  children,
}: {
  titleId: string;
  descId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    document.getElementById(titleId)?.focus({ preventScroll: true });
    return () => {
      // Closing hands focus back to the button, unless the person has already moved it elsewhere.
      if (document.activeElement === document.body || !document.activeElement)
        document.getElementById(BUTTON_ID)?.focus({ preventScroll: true });
    };
  }, [titleId]);
  return (
    <aside
      id={DRAWER_ID}
      className="term-dock"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
        document.getElementById(BUTTON_ID)?.focus({ preventScroll: true });
      }}
    >
      <div className="term-panel-body">{children}</div>
    </aside>
  );
}

function TerminalContent({
  tv,
  refusal,
  computer,
  titleId,
  descId,
  message,
  onRefresh,
  onClose,
}: {
  tv: TerminalView;
  refusal: RefreshOutcome | undefined;
  computer: string;
  titleId: string;
  descId: string;
  message: string;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const paneTitle = tv.kind === 'snapshot' ? tv.paneTitle : '';
  return (
    <>
      <header className="term-head">
        <div className="term-titles">
          {paneTitle && (
            <span className="term-eyebrow" aria-hidden="true">
              Terminal snapshot
            </span>
          )}
          <h2 id={titleId} className="term-title" tabIndex={-1}>
            {paneTitle ? (
              <>
                <span className="sr-only">Terminal snapshot: </span>
                {paneTitle}
              </>
            ) : (
              'Terminal'
            )}
          </h2>
        </div>
        <button
          type="button"
          className="btn ghost icon"
          aria-label="Close terminal"
          title="Close (Esc)"
          onClick={onClose}
        >
          <CloseIcon size={20} />
        </button>
      </header>
      <p id={descId} className="sr-only">
        A read-only snapshot. Nothing here reaches the terminal.
      </p>
      {tv.kind === 'snapshot' ? (
        <SnapshotBody tv={tv} refusal={refusal} computer={computer} onRefresh={onRefresh} />
      ) : (
        <EmptyBody tv={tv} refusal={refusal} computer={computer} onRefresh={onRefresh} />
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {message}
      </p>
    </>
  );
}

/** Asks again. While a request is under way it says so and spins (still under reduced motion: no spin, same words). */
function RefreshButton({
  busy,
  quiet,
  onRefresh,
}: {
  busy: boolean;
  /** In the status row it is quiet; under an empty state it is the one thing to do, so it has an edge. */
  quiet?: boolean;
  onRefresh: () => void;
}) {
  return (
    <button
      type="button"
      className={quiet ? 'btn ghost term-refresh' : 'btn term-refresh'}
      aria-disabled={busy || undefined}
      data-busy={busy || undefined}
      onClick={() => !busy && onRefresh()}
    >
      {/* Both faces share one cell, so the button keeps its size and place while it asks. */}
      <span className="term-refresh-label">
        <span aria-hidden={busy || undefined} data-on={!busy || undefined}>
          <RefreshIcon size={16} />
          Refresh
        </span>
        <span aria-hidden={!busy || undefined} data-on={busy || undefined}>
          <RefreshIcon size={16} />
          Asking…
        </span>
      </span>
    </button>
  );
}

/**
 * A line's leading marker: any single symbol (a bullet, a tool-output or tree corner, a tick, a prompt, a spinner
 * such as "✻") or a list number, followed by spaces.
 */
const MARKER = /^(\s*)(?:[^\p{L}\p{N}\s([{<"'`]|\d{1,3}[.)])\s+(?=\S)/u;
/** Where a line's continuation rows start, in columns: under its first word of text (at most 16 in). */
const hangOf = (line: string): number => {
  const m = MARKER.exec(line);
  const n = m ? m[0].length : line.length - line.trimStart().length;
  return Math.min(16, n);
};
/**
 * Symbols JetBrains Mono does not draw (Miscellaneous Technical such as "⎿" and "⏺", arrows, geometric shapes,
 * dingbats such as "✻"): the browser takes them from a fallback font of another width, which pushes the rest of the
 * line off the column grid. Each is held to one column, as a terminal cell would hold it.
 */
const FOREIGN = /([\u2190-\u21ff\u2300-\u23ff\u25a0-\u25ff\u2700-\u27bf])/;
function cells(text: string): ReactNode {
  if (!FOREIGN.test(text)) return text;
  return text.split(FOREIGN).map((part, k) =>
    k % 2 ? (
      <span key={k} className="term-cell">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
/**
 * A drawn frame line (a prompt box's top or bottom, a rule, an empty framed row such as "│ >   │"): it starts with a
 * box-drawing character and holds almost nothing else. It clips at the edge rather than wrapping into broken shapes.
 * A line with real content after a box character (a tree's "└── src/…", a framed row with text) still wraps, so
 * nothing meaningful is ever cut off.
 */
const BOX = /[\u2500-\u257f]/g;
const BOX_ONE = /^[\u2500-\u257f]$/;
const isFrame = (line: string): boolean =>
  /^\s*[\u2500-\u257f]/.test(line) && line.replace(BOX, '').replace(/\s+/g, '').length <= 2;

function SnapshotBody({
  tv,
  refusal,
  computer,
  onRefresh,
}: {
  tv: Extract<TerminalView, { kind: 'snapshot' }>;
  refusal: RefreshOutcome | undefined;
  computer: string;
  onRefresh: () => void;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const shown = useRef<string | null>(null);
  // Scrolled to the newest line on open, and kept there as new snapshots arrive, unless the person has scrolled up
  // to read: then the view stays where it is.
  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    const first = shown.current === null;
    shown.current = tv.snapshotId;
    if (first || atEnd.current) el.scrollTop = el.scrollHeight;
  }, [tv.snapshotId]);
  const observed = new Date(tv.observedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  // A new attempt under way speaks for itself; otherwise say why the picture is old.
  const note = tv.refreshing
    ? null
    : refusal
      ? refusalLine(refusal, computer, true)
      : tv.unanswered
        ? `${computer} didn’t send a newer snapshot. It may be asleep or offline.`
        : null;
  return (
    <>
      <div
        className="term-status"
        data-state={tv.state ?? 'unknown'}
        data-freshness={tv.refreshing ? 'refreshing' : tv.stale ? 'stale' : 'fresh'}
        data-stale={tv.stale || undefined}
      >
        <div className="term-status-text">
          {tv.words && (
            <p
              className="agent-state term-state"
              data-tone={tv.tone}
              data-fresh={tv.stale ? 'stale' : 'fresh'}
            >
              <span className="agent-dot" aria-hidden="true" />
              <span className="agent-label">{tv.words}</span>
            </p>
          )}
          <p className="term-fresh" title={`Observed at ${observed} on ${computer}`}>
            {tv.stale && <span className="term-stale">Stale · </span>}
            as of {tv.age}
          </p>
        </div>
        <RefreshButton busy={tv.refreshing} quiet onRefresh={onRefresh} />
        {note && <p className="term-note">{note}</p>}
      </div>
      <div
        ref={screen}
        className="term-screen"
        role="region"
        aria-label="Last terminal lines"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {tv.lines.length > 0 ? (
          <pre className="term-text">
            {tv.lines.map((line, i) => {
              if (isFrame(line)) {
                // A frame keeps its closing edge at the panel's edge, so a clipped box still reads as a box.
                const t = line.trimEnd();
                const end = t.slice(-1);
                const closes = t.length > 1 && BOX_ONE.test(end);
                return (
                  <span key={i} className="term-line term-frame">
                    <span className="term-frame-run">{closes ? t.slice(0, -1) : t}</span>
                    {closes && <span className="term-frame-end">{end}</span>}
                  </span>
                );
              }
              // Each line wraps under its own text: past its indent and any leading marker ("● ", "⎿  ", "✓ ",
              // "1. "), so a wrapped line reads as one and never zigzags back to the margin.
              return (
                <span
                  key={i}
                  className="term-line"
                  style={{ '--i': hangOf(line) } as CSSProperties}
                >
                  {cells(line)}
                </span>
              );
            })}
          </pre>
        ) : (
          <p className="term-blank">No terminal lines in this snapshot.</p>
        )}
      </div>
    </>
  );
}

function EmptyBody({
  tv,
  refusal,
  computer,
  onRefresh,
}: {
  tv: Exclude<TerminalView, { kind: 'snapshot' }>;
  refusal: RefreshOutcome | undefined;
  computer: string;
  onRefresh: () => void;
}) {
  let title = 'No snapshot yet';
  let text: string;
  let ask = true;
  if (tv.kind === 'off') {
    title = 'Not shared';
    text = `Terminal sharing is off on ${computer}. It can be turned on in Daintree’s settings on that computer.`;
    ask = false;
  } else if (tv.kind === 'closed') {
    title = 'Not available';
    text = 'This question has closed, so its terminal is no longer shared.';
    ask = false;
  } else if (tv.phase === 'asking') text = `Asking ${computer} for one…`;
  // The latest request's own outcome comes first: a refusal now outranks an earlier ask that ran out.
  else if (refusal === 'unavailable') {
    text = `${computer} isn’t sharing this agent’s terminal. Older versions of Daintree don’t share terminals.`;
    ask = false;
  } else if (refusal) text = refusalLine(refusal, computer, false);
  else if (tv.phase === 'unanswered')
    text = `${computer} didn’t reply. It may be asleep or offline.`;
  else text = `${computer} hasn’t shared this agent’s terminal yet.`;
  const phase = tv.kind === 'none' ? tv.phase : undefined;
  const titleId = useId();
  return (
    // Its own scroll region (a short window, larger text), so it takes focus to be scrolled from the keyboard.
    <div
      className="term-empty"
      data-kind={tv.kind}
      data-phase={phase}
      role="region"
      aria-labelledby={titleId}
      tabIndex={0}
    >
      <div className="term-empty-inner">
        <span className="term-empty-icon" aria-hidden="true">
          <TerminalIcon size={26} />
        </span>
        <h3 className="term-empty-title" id={titleId}>
          {title}
        </h3>
        <p className="term-empty-text">{text}</p>
        {ask && <RefreshButton busy={phase === 'asking'} onRefresh={onRefresh} />}
      </div>
    </div>
  );
}
