import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useActionCount, useAgentStates, useNow, useQuestions } from '../app/hooks.js';
import { useLayer } from '../app/layers.js';
import { Link, usePath, useRoute } from '../app/router.js';
import { closeSidebar, openSidebar, useSidebarOpen } from '../app/sidebar.js';
import type { AgentStateView } from '../domain/agentState.js';
import type { QuestionView } from '../domain/model.js';
import { hiddenQuestionText, needsYou, originParts } from '../domain/selectors.js';
import { previewText } from '../lib/safe-text.js';
import {
  ConnectionLine,
  InstallNudge,
  Mark,
  UpdateAffordance,
  useShellAttention,
} from './AppStatus.js';
import { AgentStateMark } from './AgentState.js';
import { CloseIcon, MenuIcon } from './Icons.js';
import { NavGlyph, type Destination } from './NavGlyphs.js';
import { useSwipeClose } from './useSwipeClose.js';

/** Three destinations; Devices lives inside Settings. */
const NAV: { to: string; label: string; glyph: Destination }[] = [
  { to: '/', label: 'Home', glyph: 'questions' },
  { to: '/history', label: 'History', glyph: 'history' },
  { to: '/settings', label: 'Settings', glyph: 'settings' },
];

const isOn = (to: string, path: string) =>
  to === '/'
    ? path === '/'
    : to === '/settings'
      ? path.startsWith('/settings') || path.startsWith('/devices')
      : path.startsWith(to);

/** How many questions Recent lists: enough to fill a phone's sidebar, never a second inbox. */
const RECENT = 12;
const SHEET_ID = 'sidebar';
const BUTTON_ID = 'menu-button';

/**
 * The most recently asked questions, newest first, always including the open question (it takes the last place
 * when it is older than the rest). While the sidebar is in use (`hold`) the rows stay exactly where they are: a
 * question that arrives meanwhile joins the next time it opens, so nothing moves under a finger. Each held row
 * still shows its question's latest state.
 */
function useRecent(currentId: string | undefined, hold: boolean): QuestionView[] {
  const all = useQuestions();
  const fresh = useMemo(() => {
    // Times can tie at the relay's resolution; the ledger sequence keeps the order the questions were asked in.
    const top = [...all]
      .sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.createdSeq - a.createdSeq,
      )
      .slice(0, RECENT);
    if (currentId && !top.some((v) => v.id === currentId)) {
      const current = all.find((v) => v.id === currentId);
      if (current) top.splice(Math.min(top.length, RECENT - 1), 1, current);
    }
    return top;
  }, [all, currentId]);
  const held = useRef<string[] | null>(null);
  if (!hold) held.current = null;
  else if (!held.current) held.current = fresh.map((v) => v.id);
  const ids = held.current;
  return useMemo(() => {
    if (!ids) return fresh;
    const byId = new Map(all.map((v) => [v.id, v]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }, [ids, all, fresh]);
}

/**
 * Which Recent rows give room to an agent state. Only a fresh observation earns room in a one-line row (an old one
 * is left to Home, which can say how old). Like the rows' order, the room is held while the sidebar is in use: a
 * state that goes stale leaves its slot empty, and one that arrives in a row without a slot waits for the next
 * time the sidebar opens, so no question re-truncates under a finger.
 */
function useStateSlots(
  recent: QuestionView[],
  agentOf: (v: QuestionView) => AgentStateView | null,
  hold: boolean,
): ReadonlySet<string> {
  const live = new Set(recent.filter((v) => agentOf(v)?.fresh === 'fresh').map((v) => v.id));
  const held = useRef<Set<string> | null>(null);
  if (!hold) held.current = null;
  else if (!held.current) held.current = live;
  return held.current ?? live;
}

function RecentRow({
  v,
  now,
  current,
  agent,
  slot,
}: {
  v: QuestionView;
  now: number;
  current: boolean;
  agent: AgentStateView | null;
  /** The row has room for a state (see `useStateSlots`). */
  slot: boolean;
}) {
  const { project } = originParts(v);
  const waiting = needsYou(v, now);
  const shown = slot && agent?.fresh === 'fresh' ? agent : null;
  // The whole question as plain text: the CSS clamp shortens what is seen, never what is read out.
  const text = v.content
    ? previewText(v.content.question, Number.POSITIVE_INFINITY)
    : hiddenQuestionText(v);
  return (
    <li>
      <Link
        to={`/q/${v.id}`}
        className="side-q"
        data-row-id={v.id}
        aria-current={current ? 'page' : undefined}
      >
        <span className="side-q-dot" data-on={waiting || undefined} aria-hidden="true" />
        {waiting && <span className="sr-only">Needs you: </span>}
        <span className="side-q-body">
          <span className="side-q-text">{text}</span>
          <span className="side-q-meta">
            <span className="side-q-project">
              <span className="sr-only">, </span>
              {project}
            </span>
            {slot && (
              <span className="side-q-state">
                {shown && <AgentStateMark a={shown} age={false} />}
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * The sidebar's contents, the same in the overlay and in the persistent column: the mark and name, the three
 * destinations, Recent, and the app's own state (connection, update, install) at the foot.
 */
function SidebarContent({
  currentId,
  titleId,
  install,
  hold,
  onClose,
}: {
  currentId?: string;
  titleId: string;
  install: boolean;
  /** The sidebar is in use: hold Recent still. */
  hold: boolean;
  /** The overlay's Close button; the column has none. */
  onClose?: () => void;
}) {
  const path = usePath();
  const now = useNow();
  const recent = useRecent(currentId, hold);
  const agentOf = useAgentStates();
  const slots = useStateSlots(recent, agentOf, hold);
  const recentId = useId();
  const waiting = useActionCount(now);
  return (
    <>
      <div className="side-head">
        <span className="brand-mark side-mark">
          <Mark size={22} />
        </span>
        <h2 className="side-name" id={titleId} tabIndex={-1}>
          Daintree
        </h2>
        {onClose && (
          <button
            type="button"
            className="btn ghost icon side-close"
            aria-label="Close sidebar"
            title="Close (Esc)"
            onClick={onClose}
          >
            <CloseIcon size={20} />
          </button>
        )}
      </div>
      <div className="side-scroll">
        <nav className="side-nav" aria-label="Main">
          {NAV.map(({ to, label, glyph }) => {
            const on = isOn(to, path);
            return (
              <Link
                key={to}
                to={to}
                className={on ? 'side-row on' : 'side-row'}
                aria-current={on ? 'page' : undefined}
              >
                <NavGlyph name={glyph} size={20} strong={on} />
                <span className="side-row-label">{label}</span>
                {to === '/' && waiting > 0 && (
                  <span className="count waiting">
                    <span className="sr-only">, </span>
                    {waiting}
                    <span className="sr-only"> waiting</span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <section className="side-recent" aria-labelledby={recentId}>
          <h3 className="side-eyebrow" id={recentId}>
            Recent
          </h3>
          {recent.length > 0 ? (
            <ul className="side-qlist">
              {recent.map((v) => (
                <RecentRow
                  key={v.id}
                  v={v}
                  now={now}
                  current={v.id === currentId}
                  agent={agentOf(v)}
                  slot={slots.has(v.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="side-empty">Questions from your agents appear here.</p>
          )}
        </section>
      </div>
      <div className="side-foot">
        {install && <InstallNudge />}
        <UpdateAffordance />
        <ConnectionLine />
      </div>
    </>
  );
}

/**
 * The floating menu button (below 1100px): a round 48px button over the content, top-left inside the safe area.
 * When the closed sidebar is hiding app state that needs attention (no network, a relay that has stopped answering,
 * an update to restart into) it carries a small dot on its lower shoulder; on pages that do not count waiting work
 * themselves (a question, History, Settings) it carries the waiting count on its upper one. Its name says both.
 */
export function MenuButton() {
  const open = useSidebarOpen();
  const attention = useShellAttention();
  const route = useRoute();
  const now = useNow();
  // Waiting work, where the page itself does not already count it (Home's scopes do).
  const counted = useActionCount(now);
  const waiting = route.name === 'inbox' ? 0 : counted;
  // Both can be true: the count is what needs the person, the dot what the app needs. Neither hides the other.
  const state =
    attention === 'offline'
      ? 'offline'
      : attention === 'reconnecting'
        ? 'reconnecting'
        : attention === 'update'
          ? 'update available'
          : null;
  const name = ['Menu', waiting > 0 ? `${waiting} waiting` : null, state]
    .filter(Boolean)
    .join(', ');
  return (
    <button
      type="button"
      id={BUTTON_ID}
      className="menu-fab"
      aria-label={name}
      title="Menu"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={SHEET_ID}
      data-attention={attention ?? undefined}
      onClick={openSidebar}
    >
      <MenuIcon size={22} />
      {attention && <span className="menu-fab-dot" aria-hidden="true" />}
      {waiting > 0 && (
        <span className="count waiting menu-fab-count" aria-hidden="true">
          {waiting}
        </span>
      )}
    </button>
  );
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The sidebar under the foreground canvas (below 1100px), revealed as the page moves right. A transparent
 * modal dialog keeps the revealed navigation accessible and the displaced page inert. It is a layer
 * (focus stays inside, Escape closes it). Tapping the dimmed edge or swiping it left closes it too. Focus returns
 * to the menu button, or to the new page when a row navigated.
 */
export function SidebarSheet({ currentId, install }: { currentId?: string; install: boolean }) {
  const open = useSidebarOpen();
  const dismiss = useLayer(open, closeSidebar);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const openedAt = useRef<string>('');

  useEffect(
    () => () => {
      delete document.documentElement.dataset.sidebarDragging;
      document.documentElement.style.removeProperty('--sidebar-offset');
    },
    [],
  );

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.removeAttribute('data-closing');
      d.style.transform = '';
      openedAt.current = location.pathname;
      d.showModal();
      const target =
        d.querySelector<HTMLElement>('.side-q[aria-current="page"]') ||
        d.querySelector<HTMLElement>('.side-row[aria-current="page"]') ||
        d.querySelector<HTMLElement>('.side-row');
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (!open && d.open) {
      const finish = () => {
        d.removeAttribute('data-closing');
        d.style.transform = '';
        d.close();
        // A row that navigated hands focus to the new page; anything else returns it to the button.
        if (location.pathname !== openedAt.current)
          document.getElementById('main')?.focus({ preventScroll: true });
        else document.getElementById(BUTTON_ID)?.focus({ preventScroll: true });
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
  }, [open]);

  // A left swipe on the panel follows the finger and closes it past a third of its width (or on a flick).
  const sidebarWidth = () => ref.current?.querySelector<HTMLElement>('.side')?.offsetWidth ?? 0;
  const swipe = useSwipeClose(ref, 'left', dismiss, {
    width: sidebarWidth,
    move: (distance) => {
      const root = document.documentElement;
      if (distance === null) {
        delete root.dataset.sidebarDragging;
        root.style.removeProperty('--sidebar-offset');
      } else {
        root.dataset.sidebarDragging = '';
        root.style.setProperty('--sidebar-offset', `${Math.max(0, sidebarWidth() - distance)}px`);
      }
    },
  });

  return (
    <dialog
      ref={ref}
      id={SHEET_ID}
      className="sidebar-sheet"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onClick={(e) => {
        // The panel fills the dialog's box, so a click that lands on the dialog itself is on the dimmed edge.
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="side side-sheet-body" {...swipe}>
        <SidebarContent
          currentId={currentId}
          titleId={titleId}
          install={install}
          hold={open}
          onClose={dismiss}
        />
      </div>
    </dialog>
  );
}

/** The sidebar as a persistent column at 1100px and up, in the same style as the overlay. */
export function SidebarColumn({ currentId, install }: { currentId?: string; install: boolean }) {
  const titleId = useId();
  // In use while a pointer is over it or focus is inside it; Recent holds still until it is left.
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  return (
    <aside
      className="side sidebar"
      aria-labelledby={titleId}
      onPointerEnter={() => setPointer(true)}
      onPointerLeave={() => setPointer(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
      }}
    >
      <SidebarContent
        currentId={currentId}
        titleId={titleId}
        install={install}
        hold={pointer || focus}
      />
    </aside>
  );
}
