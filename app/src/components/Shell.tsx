import { useEffect, useRef, useState, type ReactNode } from 'react';
import { app } from '../app/controller.js';
import { useApp, useNow, useQuestions } from '../app/hooks.js';
import { abandonLayers } from '../app/layers.js';
import { resetNavState } from '../app/listState.js';
import { useWide } from '../app/media.js';
import { closeNavigator, useNavigatorOpen } from '../app/navigator.js';
import { Link, usePath, useRoute } from '../app/router.js';
import { needsAction } from '../domain/selectors.js';
import { isIos, isStandalone } from '../features/push.js';
import { announce, onAnnounce } from '../lib/announce.js';
import { CloseIcon, OfflineIcon, RefreshIcon } from './Icons.js';
import { NavGlyph, type Destination } from './NavGlyphs.js';
import { focusNavigatorSearch, NavigatorPanel } from './navigator/Navigator.js';
import { NavigatorSheet, openNavigatorWithSearch } from './navigator/NavigatorSheet.js';

/** Three destinations (Devices lives inside Settings). */
const NAV: { to: string; label: string; glyph: Destination }[] = [
  { to: '/', label: 'Questions', glyph: 'questions' },
  { to: '/history', label: 'History', glyph: 'history' },
  { to: '/settings', label: 'Settings', glyph: 'settings' },
];

const isOn = (to: string, path: string) =>
  to === '/'
    ? path === '/' || path.startsWith('/q/')
    : to === '/settings'
      ? path.startsWith('/settings') || path.startsWith('/devices')
      : path.startsWith(to);

/** The Daintree mark (public/icons/mark.svg; Daintree's own DaintreeIcon), inline so it takes the tile's colour. `size` is its width; it sits at 70% of its tile, as on the app icon. */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 177.31 132.85"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M95.92,132.85h-14.52c-.59,0-1.07-.48-1.07-1.07V36.42c0-.74.27-1.46.77-1.99,2.04-2.17,4.79-3.25,7.55-3.25s5.52,1.09,7.55,3.26c.5.54.77,1.26.77,1.99v95.35c0,.59-.47,1.07-1.07,1.07Z" />
      <path d="M177.31,70.43v19.64c0,.59-.48,1.07-1.07,1.07h-14.52c-.59,0-1.07-.48-1.07-1.07v-19.67c0-10.29-5.49-19.81-14.41-24.95l-43.18-24.93c-8.92-5.15-19.9-5.15-28.82,0l-43.18,24.93c-8.92,5.15-14.41,14.66-14.41,24.95v17.75c0,.06,0,.13,0,2.14,0,.59-.48,1.07-1.07,1.07H1.07c-.59,0-1.07-.48-1.07-1.07v-19.86c0-16.27,8.68-31.3,22.76-39.43L65.89,6.1c14.09-8.13,31.44-8.13,45.53,0l43.12,24.89c14.09,8.13,22.77,23.17,22.77,39.44Z" />
      <path d="M63.66,90.05v27.19c0,.59-.48,1.07-1.07,1.07h-14.52c-.59,0-1.07-.48-1.07-1.07v-27.17c0-5.9-3.15-11.34-8.26-14.3l-5.83-3.37c-.66-.38-1.15-1-1.36-1.73s-.41-1.76-.41-2.89c0-4.68,3.21-8.98,7.99-10.11.72-.17,1.48-.05,2.13.32l5.84,3.36c10.25,5.92,16.56,16.85,16.56,28.69Z" />
      <path d="M113.65,90.05v27.19c0,.59.48,1.07,1.07,1.07h14.52c.59,0,1.07-.48,1.07-1.07v-27.17c0-5.9,3.15-11.34,8.26-14.3l5.83-3.37c.66-.38,1.15-1,1.36-1.73s.41-1.76.41-2.89c0-4.68-3.21-8.98-7.99-10.11-.72-.17-1.48-.05-2.13.32l-5.84,3.36c-10.25,5.92-16.56,16.85-16.56,28.69Z" />
    </svg>
  );
}

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Daintree Decisions, questions">
      <span className="brand-mark">
        <Mark size={20} />
      </span>
      <span className="brand-name">Decisions</span>
    </Link>
  );
}

const syncedLabel = (at: number | null) =>
  at
    ? `Synced ${new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : 'Not synced yet';

/**
 * Connection, quietly: a small neutral dot in normal operation (live or polling: polling is not a failure), words
 * only when something is off. Exported: the question workspace's header shows the same indicator.
 */
export function ConnectionPill({ quiet = false }: { quiet?: boolean } = {}) {
  const { connection, online, syncing, lastSyncedAt } = useApp();
  // Offline means this device has no network. The sync engine also reports 'offline' between socket retries while
  // the device is online; that is reconnecting, not offline, and must not claim the network is gone.
  const cls = !online ? 'off' : connection === 'live' || connection === 'polling' ? 'live' : 'wait';
  const label =
    cls === 'off'
      ? 'Offline'
      : cls === 'live'
        ? 'Connected'
        : syncing
          ? 'Syncing…'
          : connection === 'connecting'
            ? 'Connecting…'
            : 'Reconnecting…';
  // Announce only the transitions that matter (lost, and back), never each reconnect attempt.
  const wasOff = useRef(false);
  useEffect(() => {
    if (cls === 'off' && !wasOff.current) {
      wasOff.current = true;
      announce('You are offline.');
    } else if (cls === 'live' && wasOff.current) {
      wasOff.current = false;
      announce('Back online.');
    }
  }, [cls]);
  return (
    // State as a data attribute: a bare `.live` class collides with the dictation styles.
    <span
      className="conn"
      data-state={cls}
      data-quiet={quiet || undefined}
      title={`${label} · ${syncedLabel(lastSyncedAt)}`}
    >
      <span className="dot" aria-hidden="true" />
      {/* Quiet (the shell's header and rail): the strip below says it in words, so the pill never repeats it. */}
      <span className={cls === 'live' || quiet ? 'sr-only' : 'conn-label'}>{label}</span>
    </span>
  );
}

/** One compact strip, only when offline or when reconnecting has taken a while. */
function ConnectionStrip() {
  const { online, connection } = useApp();
  const offline = !online;
  const reconnecting =
    !offline && (connection === 'connecting' || connection === 'idle' || connection === 'offline');
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!reconnecting) {
      setLong(false);
      return;
    }
    const t = setTimeout(() => setLong(true), 12_000);
    return () => clearTimeout(t);
  }, [reconnecting]);
  if (offline)
    return (
      <div className="conn-strip off" role="status">
        <OfflineIcon size={16} />
        <span>
          <strong>Offline.</strong> Saved questions and drafts stay here; answers send when you
          reconnect.
        </span>
      </div>
    );
  if (reconnecting && long)
    return (
      <div className="conn-strip" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>Reconnecting to your relay… Showing what is saved on this device.</span>
        <button type="button" className="strip-action" onClick={() => app.sync?.kick()}>
          Retry
        </button>
      </div>
    );
  return null;
}

/** "Update available · Restart": quiet, in the header or rail. Explains itself when the restart has to wait. */
function UpdateAffordance() {
  const { updateAvailable } = useApp();
  const [state, setState] = useState<'idle' | 'busy' | 'refused'>('idle');
  useEffect(() => {
    if (state !== 'refused') return;
    const t = setTimeout(() => setState('idle'), 8_000);
    return () => clearTimeout(t);
  }, [state]);
  if (!updateAvailable) return null;
  const restart = async () => {
    setState('busy');
    const ok = await app.applyUpdate().catch(() => false);
    if (!ok) {
      setState('refused');
      announce('The update is waiting until your work is saved.');
    }
  };
  return (
    <span className="update">
      <button
        type="button"
        className="update-btn"
        onClick={() => void restart()}
        disabled={state === 'busy'}
        aria-describedby={state === 'refused' ? 'update-note' : undefined}
      >
        <RefreshIcon size={14} />
        <span className="update-long">Update available ·</span>
        <span className="update-act">{state === 'busy' ? 'Restarting…' : 'Restart'}</span>
      </button>
      {state === 'refused' && (
        <span className="update-note" id="update-note" role="status">
          Not yet: something is still being saved (a dictation, a draft or an answer). Try again in
          a moment.
        </span>
      )}
    </span>
  );
}

/** The iOS install nudge: one small row, dismissed for good. */
function InstallNudge() {
  return (
    <div className="nudge" role="note">
      <span>Add Decisions to your Home Screen to get notifications.</span>
      <Link to="/install" className="nudge-link">
        How
      </Link>
      <button
        type="button"
        className="nudge-close"
        aria-label="Dismiss"
        onClick={() => void app.setPrefs({ dismissedInstall: true })}
      >
        <CloseIcon size={16} />
      </button>
    </div>
  );
}

function WaitingCount({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="count waiting">
      <span className="sr-only">, </span>
      {n}
      <span className="sr-only"> waiting</span>
    </span>
  );
}

function TopNav({ path, waiting }: { path: string; waiting: number }) {
  return (
    <nav className="topnav" aria-label="Main">
      {NAV.map(({ to, label, glyph }) => {
        const on = isOn(to, path);
        return (
          <Link key={to} to={to} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
            <NavGlyph name={glyph} size={17} />
            <span>{label}</span>
            {to === '/' && <WaitingCount n={waiting} />}
          </Link>
        );
      })}
    </nav>
  );
}

function TabBar({ path, waiting }: { path: string; waiting: number }) {
  return (
    <nav className="tabbar" aria-label="Main">
      <div className="tabbar-inner">
        {NAV.map(({ to, label, glyph }) => {
          const on = isOn(to, path);
          return (
            <Link
              key={to}
              to={to}
              className={on ? 'on' : ''}
              aria-current={on ? 'page' : undefined}
            >
              <span className="tab-icon">
                <NavGlyph name={glyph} size={22} strong={on} />
                {to === '/' && <WaitingCount n={waiting} />}
              </span>
              <span className="tab-label">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** The desktop rail: brand, the three destinations, connection, and the navigator (Daintree's sidebar). */
function Rail({ path, waiting, currentId }: { path: string; waiting: number; currentId?: string }) {
  return (
    <aside className="rail" aria-label="Decisions">
      <div className="rail-head">
        <Brand />
        <span className="rail-head-end">
          <UpdateAffordance />
          <ConnectionPill quiet />
        </span>
      </div>
      <nav className="rail-nav" aria-label="Main">
        {NAV.map(({ to, label, glyph }) => {
          const on = isOn(to, path);
          return (
            <Link
              key={to}
              to={to}
              className={on ? 'on' : ''}
              aria-current={on ? 'page' : undefined}
            >
              <NavGlyph name={glyph} size={17} />
              <span>{label}</span>
              {to === '/' && <WaitingCount n={waiting} />}
            </Link>
          );
        })}
      </nav>
      <ConnectionStrip />
      <NavigatorPanel presentation="rail" currentId={currentId} />
    </aside>
  );
}

/**
 * The app frame.
 * - Under 720px: a header (brand, update, connection), the page, and a bottom tab bar. Inside a question the
 *   workspace owns the whole frame (no header, no tab bar; see `.shell[data-route='question']`).
 * - 720–1099px: one centred surface with a compact top navigation in the header; the navigator is a sheet from
 *   the left.
 * - 1100px and up: a persistent rail on the left (brand, destinations, connection, navigator) and a right column
 *   of definite height (`.frame`, 100dvh) holding the page or the question workspace. No global header.
 */
export function Shell({ children }: { children: ReactNode }) {
  const snap = useApp();
  const path = usePath();
  const route = useRoute();
  const wide = useWide();
  const all = useQuestions();
  const now = useNow();
  const navOpen = useNavigatorOpen();
  const [msg, setMsg] = useState('');
  useEffect(() => onAnnounce((m) => setMsg((p) => (p === m ? m + ' ' : m))), []);
  const waiting = all.filter((v) => needsAction(v, now)).length;
  const inQuestion = route.name === 'question';
  const currentId = route.name === 'question' ? route.id : undefined;
  const showInstall = isIos() && !isStandalone() && !snap.prefs.dismissedInstall && !inQuestion;

  // On wide screens the navigator is the rail: "open the navigator" means "go to its search".
  useEffect(() => {
    if (navOpen && wide) {
      closeNavigator();
      focusNavigatorSearch();
    }
  }, [navOpen, wide]);

  // Ctrl/⌘+K opens the navigator and focuses its search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k')
        return;
      e.preventDefault();
      if (focusNavigatorSearch()) return;
      openNavigatorWithSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    // data-route lets area styles adapt the frame (the question workspace replaces the header and tab bar).
    <div className="shell" data-route={route.name} data-layout={wide ? 'rail' : 'single'}>
      {wide && <Rail path={path} waiting={waiting} currentId={currentId} />}
      <div className="frame">
        {!wide && (
          <header className="topbar">
            <Brand />
            <TopNav path={path} waiting={waiting} />
            <span className="topbar-end">
              <UpdateAffordance />
              <ConnectionPill quiet />
            </span>
          </header>
        )}
        {!wide && !inQuestion && <ConnectionStrip />}
        {showInstall && !wide && <InstallNudge />}
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
      {!wide && <TabBar path={path} waiting={waiting} />}
      {!wide && <NavigatorSheet currentId={currentId} />}
      <div className="sr-only" aria-live="polite" role="status">
        {msg}
      </div>
    </div>
  );
}

// Unpairing or revocation forgets how this device's lists were left, and closes whatever layer was open without
// stepping history back under the lock screen.
let lastPhase = app.getSnapshot().phase;
app.subscribe(() => {
  const p = app.getSnapshot().phase;
  if (p !== lastPhase && (p === 'unpaired' || p === 'revoked') && lastPhase === 'ready') {
    abandonLayers();
    resetNavState();
  }
  lastPhase = p;
});
