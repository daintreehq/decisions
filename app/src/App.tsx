import { useEffect } from 'react';
import { useApp } from './app/hooks.js';
import { Link, useRoute } from './app/router.js';
import { Mark, Shell } from './components/Shell.js';
import { DevicesPage } from './routes/Devices.js';
import { HistoryPage } from './routes/History.js';
import { InboxLayout } from './routes/Inbox.js';
import { InstallPage } from './routes/Install.js';
import { PairPage } from './routes/Pair.js';
import { PrivacyPage } from './routes/Privacy.js';
import { SettingsPage } from './routes/Settings.js';
import { LockedPage } from './routes/Unpaired.js';

export function App() {
  const snap = useApp();
  const route = useRoute();

  // Move focus to the page when the route changes so screen-reader users land on new content, unless the page
  // already put it somewhere on purpose (a restored list row, a heading).
  useEffect(() => {
    const main = document.getElementById('main');
    const active = document.activeElement;
    if (main && active && active !== main && main.contains(active)) return;
    main?.focus({ preventScroll: true });
  }, [route.name, route.name === 'question' ? route.id : '']);

  if (snap.phase === 'loading') {
    // The mark on Daintree's tile, centred on the app field. It fades in only if loading is slow enough to notice.
    return (
      <div className="splash" role="status" aria-label="Loading Decisions">
        <span className="splash-tile">
          <Mark size={50} />
        </span>
      </div>
    );
  }

  if (snap.phase !== 'ready') {
    const open =
      route.name === 'pair' ? (
        <PairPage />
      ) : route.name === 'install' ? (
        <InstallPage />
      ) : route.name === 'privacy' ? (
        <PrivacyPage />
      ) : null;
    return (
      <main id="main" className="bare" tabIndex={-1}>
        {open ?? <LockedPage phase={snap.phase} />}
      </main>
    );
  }

  let body;
  switch (route.name) {
    case 'inbox':
      body = <InboxLayout />;
      break;
    case 'question':
      body = <InboxLayout selectedId={route.id} />;
      break;
    case 'history':
      body = <HistoryPage />;
      break;
    case 'devices':
      body = <DevicesPage />;
      break;
    case 'settings':
      body = <SettingsPage />;
      break;
    case 'pair':
      body = <PairPage />;
      break;
    case 'install':
      body = <InstallPage />;
      break;
    case 'privacy':
      body = <PrivacyPage />;
      break;
    default:
      body = (
        <div className="empty">
          <h2>Page not found</h2>
          <Link to="/" className="btn">
            Go to inbox
          </Link>
        </div>
      );
  }
  return <Shell>{body}</Shell>;
}
