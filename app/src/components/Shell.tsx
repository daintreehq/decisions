import { useEffect, useState, type ReactNode } from 'react';
import { app } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import { Link, usePath } from '../app/router.js';
import { onAnnounce } from '../lib/announce.js';
import { isIos, isStandalone } from '../features/push.js';
import { useQuestions } from '../app/hooks.js';
import { needsYou } from '../domain/selectors.js';

const NAV: [string, string, string][] = [
  ['/', 'Inbox', 'M4 6h16v12H4zM4 14h5l1 2h4l1-2h5'],
  ['/history', 'History', 'M12 7v5l3 2M4 12a8 8 0 1 0 3-6.2M4 4v4h4'],
  ['/devices', 'Devices', 'M7 3h10v18H7zM11 18h2'],
  ['/settings', 'Settings', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3'],
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
  return (
    <span
      className={`pill ${cls}`}
      role="status"
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
  const [msg, setMsg] = useState('');
  useEffect(() => onAnnounce((m) => setMsg((p) => (p === m ? m + ' ' : m))), []);
  const waiting = all.filter((v) => needsYou(v)).length;
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
        {NAV.map(([to, label, d]) => {
          const on = to === '/' ? path === '/' || path.startsWith('/q/') : path.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              className={on ? 'on' : ''}
              aria-current={on ? 'page' : undefined}
            >
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={d} />
              </svg>
              <span>{label}</span>
              {to === '/' && waiting > 0 && (
                <span className="count" aria-label={`${waiting} waiting`}>
                  {waiting}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="sr-only" aria-live="polite" role="status">
        {msg}
      </div>
    </div>
  );
}
