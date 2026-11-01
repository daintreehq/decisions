import { useEffect, useRef, useState, type ReactNode } from 'react';
import { app } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import { Link, usePath } from '../app/router.js';
import { announce, onAnnounce } from '../lib/announce.js';
import { isIos, isStandalone } from '../features/push.js';
import { useNow, useQuestions } from '../app/hooks.js';
import { needsAction } from '../domain/selectors.js';

const NAV: [string, string, string][] = [
  ['/', 'Inbox', 'M4 6h16v12H4zM4 14h5l1 2h4l1-2h5'],
  ['/history', 'History', 'M12 7v5l3 2M4 12a8 8 0 1 0 3-6.2M4 4v4h4'],
  ['/devices', 'Devices', 'M7 3h10v18H7zM11 18h2'],
  ['/settings', 'Settings', 'M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4'],
];

function ConnectionPill() {
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
  const cls = !online ? 'off' : connection === 'live' ? 'live' : 'wait';
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
      className={`pill ${cls}`}
      title={
        lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleTimeString()}` : undefined
      }
    >
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const snap = useApp();
  const path = usePath();
  const all = useQuestions();
  const now = useNow();
  const [msg, setMsg] = useState('');
  useEffect(() => onAnnounce((m) => setMsg((p) => (p === m ? m + ' ' : m))), []);
  const waiting = all.filter((v) => needsAction(v, now)).length;
  const showInstall = isIos() && !isStandalone() && !snap.prefs.dismissedInstall;

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Daintree Decisions, inbox">
          <img src="/icons/icon-192.png" alt="" width="28" height="28" />
          <span>Decisions</span>
        </Link>
        <ConnectionPill />
      </header>
      {snap.updateAvailable && (
        <div className="banner" role="status">
          <span>A new version is ready.</span>
          <button type="button" className="btn small" onClick={() => app.applyUpdate()}>
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
            const on = to === '/' ? path === '/' || path.startsWith('/q/') : path.startsWith(to);
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
                    strokeWidth={on ? 2.2 : 1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d={d} />
                  </svg>
                </span>
                <span>{label}</span>
                {to === '/' && waiting > 0 && (
                  <span className="count">
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
