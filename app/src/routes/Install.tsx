import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../app/hooks.js';
import { peekPendingInvite } from '../app/invite.js';
import { Link } from '../app/router.js';
import { ChevronLeft } from '../components/Icons.js';
import { Callout } from '../components/settings/ui.js';
import { isIos, isStandalone } from '../features/push.js';
import {
  installPrompt,
  justInstalled,
  onInstallChange,
  runInstallPrompt,
} from '../features/install.js';

/**
 * Back goes to Settings once paired (the About & help section). Before pairing it goes to the welcome, or back to an
 * invitation that is still waiting, so reading the install steps never hides it.
 */
export function BackLink() {
  const { phase } = useApp();
  const paired = phase === 'ready';
  const to = paired ? '/settings/about' : peekPendingInvite()?.invite ? '/pair' : '/';
  return (
    <Link to={to} className="s-back">
      <ChevronLeft size={18} />
      {paired ? 'Settings' : 'Back'}
    </Link>
  );
}

export type Platform = 'ios' | 'android' | 'desktop' | 'mac-safari';

export function detectPlatform(
  ua = navigator.userAgent,
  touch = navigator.maxTouchPoints,
): Platform {
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua))
    return 'mac-safari';
  return 'desktop';
}

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'ios', label: 'iPhone & iPad' },
  { id: 'android', label: 'Android' },
  { id: 'desktop', label: 'Chrome & Edge' },
  { id: 'mac-safari', label: 'Safari on Mac' },
];

function Steps({ children }: { children: ReactNode }) {
  return <ol className="install-steps">{children}</ol>;
}

function StepsFor({ platform, finish }: { platform: Platform; finish: string }) {
  switch (platform) {
    case 'ios':
      return (
        <Steps>
          <li>
            Open this page in <strong>Safari</strong>, not inside another app.
          </li>
          <li>
            Tap <strong>Share</strong>, the square with an arrow pointing up, in the bar at the
            bottom of the screen (at the top on iPad). If you don’t see it, tap <strong>···</strong>{' '}
            first.
          </li>
          <li>
            Tap <strong>Add to Home Screen</strong> (scroll down if it’s hidden), then{' '}
            <strong>Add</strong>. If you see <strong>Open as Web App</strong>, leave it on.
          </li>
          <li>Open Decisions from your Home Screen, {finish}</li>
        </Steps>
      );
    case 'android':
      return (
        <Steps>
          <li>
            Open this page in <strong>Chrome</strong>.
          </li>
          <li>
            Tap the menu <strong>⋮</strong>, then <strong>Add to Home screen</strong> and{' '}
            <strong>Install</strong>.
          </li>
          <li>Open Decisions from your Home Screen, {finish}</li>
        </Steps>
      );
    case 'desktop':
      return (
        <Steps>
          <li>
            Click the install icon at the right of the address bar. Or use the menu:
            <span className="install-alt">
              In <strong>Chrome</strong>, <strong>⋮</strong> › <strong>Cast, save and share</strong>{' '}
              › <strong>Install page as app</strong>
            </span>
            <span className="install-alt">
              In <strong>Edge</strong>, <strong>···</strong> › <strong>Apps</strong> ›{' '}
              <strong>Install this site as an app</strong>
            </span>
          </li>
          <li>Decisions opens in its own window. Pin it to your taskbar or Dock, {finish}</li>
        </Steps>
      );
    case 'mac-safari':
      return (
        <Steps>
          <li>
            In <strong>Safari</strong> (macOS Sonoma or newer), choose <strong>File</strong> ›{' '}
            <strong>Add to Dock</strong>.
          </li>
          <li>
            Keep the name <strong>Decisions</strong> and click <strong>Add</strong>.
          </li>
          <li>Open Decisions from the Dock or Launchpad, {finish}</li>
        </Steps>
      );
  }
}

export function InstallPage() {
  const [, rerender] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [platform, setPlatform] = useState<Platform>(() => detectPlatform());
  useEffect(() => onInstallChange(() => rerender((n) => n + 1)), []);

  const detected = detectPlatform();
  const standalone = isStandalone();
  const installed = standalone || justInstalled();
  const prompt = installPrompt();
  const paired = useApp().phase === 'ready';
  const firefox = /Firefox\//.test(navigator.userAgent) && !isIos();
  // Settings exists only once the device is paired, so the last step depends on where you are. Another tab is another
  // device, which still needs pairing. A Home Screen or Dock app from Safari keeps its own storage, so a pairing made
  // in Safari does not carry into it.
  const finishFor = (p: Platform) =>
    !paired || p !== detected
      ? 'pair it with your computer, then turn on notifications.'
      : (p === 'ios' || p === 'mac-safari') && !standalone
        ? 'pair it from there (it doesn’t share Safari’s pairing), then turn on notifications in Settings.'
        : 'then turn on notifications in Settings.';
  const windows = /Windows/.test(navigator.userAgent);
  const finish = finishFor(detected);

  return (
    // Before pairing this page is a step of onboarding and takes its type; from Settings it is a settings page.
    <div className={`page s-page s-standalone${paired ? '' : ' onb-install'}`}>
      <BackLink />
      <h1 className="s-title">Install Decisions</h1>
      <p className="s-lead">
        Once installed, Decisions opens in its own window, stays signed in to your relay and can
        notify you when a question needs you.
        {isIos() && ' On iPhone and iPad, notifications only work once it’s on your Home Screen.'}
      </p>

      {installed && (
        <Callout tone="success" title={standalone ? 'You’re using the installed app' : 'Installed'}>
          {standalone
            ? `Nothing more to do here. Now ${finish.replace(/^then /, '')}`
            : `Open Decisions from your Home Screen or app list, ${finish}`}
        </Callout>
      )}

      {!installed && prompt && (
        <div className="install-now">
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              // An accepted install shows the Installed callout above; only a dismissal needs a line here.
              void runInstallPrompt().then((o) => {
                setResult(
                  o === 'accepted'
                    ? null
                    : 'Not installed. You can install it later from the browser menu.',
                );
                if (o === 'accepted') setAnnounce('Decisions is installed.');
              });
            }}
          >
            Install app
          </button>
          <span className="s-row-desc">Your browser asks to confirm.</span>
        </div>
      )}
      {result && (
        <p className="s-row-desc" role="status">
          {result}
        </p>
      )}

      {!standalone && (
        <>
          <div className="seg install-tabs" role="tablist" aria-label="Device">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                id={`tab-${p.id}`}
                aria-controls="install-panel"
                aria-selected={platform === p.id}
                tabIndex={platform === p.id ? 0 : -1}
                onClick={() => setPlatform(p.id)}
                onKeyDown={(e) => {
                  const i = PLATFORMS.findIndex((x) => x.id === platform);
                  const n = PLATFORMS.length;
                  // Horizontal tabs: Left/Right move one tab, Home/End jump; Up/Down stay with the page.
                  const to =
                    e.key === 'ArrowRight'
                      ? (i + 1) % n
                      : e.key === 'ArrowLeft'
                        ? (i - 1 + n) % n
                        : e.key === 'Home'
                          ? 0
                          : e.key === 'End'
                            ? n - 1
                            : -1;
                  if (to < 0) return;
                  e.preventDefault();
                  const next = PLATFORMS[to]!;
                  setPlatform(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div
            className="install-panel"
            role="tabpanel"
            id="install-panel"
            aria-labelledby={`tab-${platform}`}
            // The steps hold no control, so the panel itself is the next tab stop after the tabs.
            tabIndex={0}
          >
            {firefox && platform === 'desktop' && (
              <Callout tone="info">
                {windows
                  ? 'In Firefox, click the web apps button in the address bar to install Decisions. Windows may then offer to pin it to the taskbar. If you don’t see the button, update Firefox, or use Chrome or Edge.'
                  : 'Firefox installs web apps only on Windows. Open this address in Chrome, Edge or Safari to install Decisions.'}
              </Callout>
            )}
            {/* Off an iPhone the reason lives with the iPhone steps, so the lead above never changes height. */}
            {platform === 'ios' && !isIos() && (
              <p className="install-why">
                On iPhone and iPad, notifications only work once it’s on the Home Screen.
              </p>
            )}
            <StepsFor platform={platform} finish={finishFor(platform)} />
          </div>
        </>
      )}
      <p className="sr-only" role="status">
        {announce}
      </p>
    </div>
  );
}
