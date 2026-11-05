import { useEffect, useRef, useState, type ReactNode } from 'react';
import { app } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import { syncThemeColor } from '../app/prefs.js';
import { useStageCovered, abandonLayers } from '../app/layers.js';
import { resetNavState } from '../app/listState.js';
import { useTablet, useWide } from '../app/media.js';
import { navigate, useRoute } from '../app/router.js';
import { closeSidebar, openSidebar } from '../app/sidebar.js';
import { useSwipeOpen } from './useSwipeOpen.js';
import { isIos, isStandalone } from '../features/push.js';
import { onAnnounce } from '../lib/announce.js';
import { InstallNudge, useConnectionAnnouncements } from './AppStatus.js';
import { focusNavigatorSearch } from './navigator/Navigator.js';
import { NavigatorSheet, openNavigatorWithSearch } from './navigator/NavigatorSheet.js';
import { MenuButton, SidebarColumn, SidebarSheet } from './Sidebar.js';

export { ConnectionPill, Mark } from './AppStatus.js';

/**
 * The app frame. No title bar and no tab bar at any width.
 * - Under 1100px: the page fills the screen, with a round menu button floating top-left inside the safe area. It
 *   reveals the sidebar beneath the foreground canvas. Inside a question the workspace owns the frame and the button
 *   sits in its header's leading slot.
 * - 1100px and up: the sidebar is a persistent column on the left and a right column of definite height (`.frame`,
 *   100dvh) holds the page or the question workspace.
 */
export function Shell({ children }: { children: ReactNode }) {
  const snap = useApp();
  const route = useRoute();
  const wide = useWide();
  const tablet = useTablet();
  const frame = useRef<HTMLDivElement>(null);
  const drillIn =
    !tablet && (route.name === 'devices' || (route.name === 'settings' && !!route.section));
  useSwipeOpen(
    frame,
    !wide,
    drillIn ? () => navigate('/settings') : openSidebar,
    route.name === 'question'
      ? () => document.getElementById('terminal-button')?.click()
      : undefined,
  );
  const covered = useStageCovered();
  useEffect(() => {
    const refresh = () => syncThemeColor(snap.prefs.theme, covered);
    refresh();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', refresh);
    return () => {
      media.removeEventListener('change', refresh);
      syncThemeColor(app.getSnapshot().prefs.theme);
    };
  }, [covered, snap.prefs.theme]);
  const [msg, setMsg] = useState('');
  useEffect(() => onAnnounce((m) => setMsg((p) => (p === m ? m + ' ' : m))), []);
  useConnectionAnnouncements();
  const inQuestion = route.name === 'question';
  const currentId = route.name === 'question' ? route.id : undefined;
  const showInstall = isIos() && !isStandalone() && !snap.prefs.dismissedInstall;

  // The overlay belongs to the narrow layouts: widening to the column closes it (its layer unwinds as it unmounts),
  // so narrowing again starts closed.
  useEffect(() => {
    if (wide) closeSidebar();
  }, [wide]);

  // Ctrl/⌘+K focuses Home's search when Home is on screen, and otherwise opens the navigator with its search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k')
        return;
      e.preventDefault();
      // Another modal layer owns the keyboard: nothing behind it moves. The navigator's own sheet handles its search.
      if (document.querySelector('dialog[open]:not(.nav-sheet)')) return;
      if (focusNavigatorSearch()) return;
      openNavigatorWithSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    // data-route lets area styles adapt the frame (the question workspace owns it below 1100px).
    <div
      className="shell"
      data-route={route.name}
      data-layout={wide ? 'column' : 'single'}
      data-drill-in={drillIn || undefined}
    >
      {/* First in document order, as it is first on screen: global navigation before the page. */}
      {!wide && !drillIn && <MenuButton />}
      {wide && <SidebarColumn currentId={currentId} install={showInstall} />}
      <div className="frame" ref={frame}>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        {!wide && showInstall && !inQuestion && <InstallNudge />}
      </div>
      {!wide && <SidebarSheet currentId={currentId} install={false} />}
      <NavigatorSheet currentId={currentId} />
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
