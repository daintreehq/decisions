import { useEffect, useRef, useState, type ReactNode } from 'react';
import { app } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import { Link, usePath, useRoute } from '../app/router.js';
import { announce, onAnnounce } from '../lib/announce.js';
import { isIos, isStandalone } from '../features/push.js';
import { useNow, useQuestions } from '../app/hooks.js';
import { needsAction } from '../domain/selectors.js';

/** Three destinations (Devices lives inside Settings). Glyphs follow Lucide's geometry: inbox, history, settings-2. */
const NAV: [string, string, string][] = [
  [
    '/',
    'Questions',
    'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  ],
  ['/history', 'History', 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2'],
  [
    '/settings',
    'Settings',
    'M20 7h-9M14 17H5M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
];

const isOn = (to: string, path: string) =>
  to === '/'
    ? path === '/' || path.startsWith('/q/')
    : to === '/settings'
      ? path.startsWith('/settings') || path.startsWith('/devices')
      : path.startsWith(to);

/** The Decisions mark (public/icons/mark.svg), inline so it takes the tile's colour. */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M222.059 23.059A48 48 0 0 1 289.941 23.059L488.941 222.059A48 48 0 0 1 488.941 289.941L289.941 488.941A48 48 0 0 1 222.059 488.941L23.059 289.941A48 48 0 0 1 23.059 222.059Z M282.2 304.4C282.2 300.8 282.3 298.7 283.3 293.7C287.4 274.5 308.3 268.5 323.5 255.8C340.4 241.7 350.8 224.2 350.2 198.6C350 190.4 347.6 178.2 342.8 168.7C319.9 123.5 259.2 112.7 214.3 130C181.2 142.8 158.9 172.4 160.7 208.3L220 208.3C220 204.5 220.3 201.6 221.4 198.4C224.1 190.6 228.3 184.1 235.7 179.5C253 168.8 282.2 174.2 284.5 197.8C286.9 221.7 264.2 230.3 249.9 239.8C229.9 253.2 219.7 270.4 219.4 295.5C219.4 298.5 219.4 301.5 219.4 304.4H282.2ZM290.4 361.7C289.9 340.3 271.9 323.3 250.7 323.6C228.3 324 211.3 342.4 211.9 363.7C212.5 384.8 230.7 402.3 252.9 401.4C273.9 400.6 290.9 382.4 290.4 361.7Z"
      />
    </svg>
  );
}

export function ConnectionPill() {
  const { connection, online, syncing, lastSyncedAt } = useApp();
  const label = !online
    ? 'Offline'
    : connection === 'live'
      ? 'Live'
      : connection === 'polling'
        ? 'Checking now and then'
        : syncing
          ? 'Syncing…'
          : connection === 'connecting'
            ? 'Connecting…'
            : 'Reconnecting…';
  const cls = !online ? 'off' : connection === 'live' || connection === 'polling' ? 'live' : 'wait';
  // Announce only the transitions that matter (lost, and back), never each reconnect attempt.
  const wasOff = useRef(false);
  useEffect(() => {
    if (cls === 'off' && !wasOff.current) {
      wasOff.current = true;
      announce('You are offline.');
    } else if ((connection === 'live' || connection === 'polling') && online && wasOff.current) {
      wasOff.current = false;
      announce('Back online.');
    }
  }, [cls, connection, online]);
  return (
    <span
      className={`conn ${cls}`}
      title={
        lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleTimeString()}` : undefined
      }
    >
      <span className="dot" aria-hidden="true" />
      {/* Healthy is a quiet dot; words appear only when something is off. */}
      <span className={cls === 'live' ? 'sr-only' : undefined}>{label}</span>
    </span>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const snap = useApp();
  const path = usePath();
  const route = useRoute();
  const all = useQuestions();
  const now = useNow();
  const [msg, setMsg] = useState('');
  useEffect(() => onAnnounce((m) => setMsg((p) => (p === m ? m + ' ' : m))), []);
  const waiting = all.filter((v) => needsAction(v, now)).length;
  const showInstall = isIos() && !isStandalone() && !snap.prefs.dismissedInstall;

  return (
    // data-route lets area styles adapt the frame (the question workspace replaces the tab bar on phones).
    <div className="shell" data-route={route.name}>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Daintree Decisions, questions">
          <span className="brand-mark">
            <Mark size={16} />
          </span>
          <span>Decisions</span>
        </Link>
        <ConnectionPill />
      </header>
      {snap.updateAvailable && (
        <div className="banner" role="status">
          <span>A new version is ready.</span>
          <button type="button" className="btn small" onClick={() => void app.applyUpdate()}>
            Update
          </button>
        </div>
      )}
      {!snap.online && (
        <div className="banner warn" role="status">
          You are offline. You can still read saved questions, and answers will send when you
          reconnect.
        </div>
      )}
      {showInstall && (
        <div className="banner" role="note">
          <span>Add to Home Screen to get notifications.</span>
          <Link to="/install" className="btn small">
            How
          </Link>
          <button
            type="button"
            className="link-btn"
            onClick={() => void app.setPrefs({ dismissedInstall: true })}
          >
            Hide
          </button>
        </div>
      )}
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <nav className="tabbar" aria-label="Main">
        <div className="tabbar-inner">
          {NAV.map(([to, label, d]) => {
            const on = isOn(to, path);
            return (
              <Link
                key={to}
                to={to}
                className={on ? 'on' : ''}
                aria-current={on ? 'page' : undefined}
              >
                <span className="tab-icon">
                  <svg
                    viewBox="0 0 24 24"
                    width="22"
                    height="22"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={on ? 2 : 1.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d={d} />
                  </svg>
                </span>
                <span>{label}</span>
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
        </div>
      </nav>
      <div className="sr-only" aria-live="polite" role="status">
        {msg}
      </div>
    </div>
  );
}
