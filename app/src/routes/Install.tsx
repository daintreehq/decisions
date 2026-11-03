import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../app/hooks.js';
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

/** Back goes to Settings once paired (the About & help section), to the welcome screen before. */
export function BackLink() {
  const { phase } = useApp();
  const paired = phase === 'ready';
  return (
    <Link to={paired ? '/settings/about' : '/'} className="s-back">
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
            Tap <strong>Share</strong> (the square with an arrow pointing up). If you don’t see it,
            tap <strong>···</strong> first.
          </li>
          <li>
            Tap <strong>Add to Home Screen</strong> (scroll or tap <strong>More</strong> if it’s
            hidden), then <strong>Add</strong>.
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
            In <strong>Chrome</strong>, click the install icon at the right of the address bar, or
            open the menu <strong>⋮</strong> › <strong>Cast, save and share</strong> ›{' '}
            <strong>Install page as app</strong>.
          </li>
          <li>
            In <strong>Edge</strong>, open the menu <strong>···</strong> › <strong>Apps</strong> ›{' '}
            <strong>Install this site as an app</strong>.
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
  const [platform, setPlatform] = useState<Platform>(() => detectPlatform());
  useEffect(() => onInstallChange(() => rerender((n) => n + 1)), []);

  const detected = detectPlatform();
  const standalone = isStandalone();
  const installed = standalone || justInstalled();
  const prompt = installPrompt();
  const paired = useApp().phase === 'ready';
  const firefox = /Firefox\//.test(navigator.userAgent) && !isIos();
  // Settings exists only once the device is paired, so the last step depends on where you are.
  const finish = paired
    ? 'then turn on notifications in Settings.'
    : 'pair it with your computer, then turn on notifications.';

  return (
    <div className="page s-page s-standalone">
      <BackLink />
      <h1 className="s-title">Install Decisions</h1>
      <p className="s-lead">
        Installed, Decisions opens in its own window, stays signed in to your relay and can notify
        you when a question needs you.
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
              void runInstallPrompt().then((o) =>
                setResult(
                  o === 'accepted'
                    ? `Installed. Open Decisions from its own window, ${finish}`
                    : 'Not installed. You can install it later from the browser menu.',
                ),
              );
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
                  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                  if (!step) return;
                  e.preventDefault();
                  const next = PLATFORMS[(i + step + PLATFORMS.length) % PLATFORMS.length]!;
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
          >
            {platform === detected && <p className="eyebrow">This device</p>}
            {firefox && platform === 'desktop' && (
              <Callout tone="info">
                Firefox doesn’t install web apps. Open this address in Chrome, Edge or Safari to
                install Decisions.
              </Callout>
            )}
            <StepsFor platform={platform} finish={finish} />
          </div>
        </>
      )}
    </div>
  );
}
