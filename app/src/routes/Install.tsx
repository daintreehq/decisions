import { useEffect, useState } from 'react';
import { useApp } from '../app/hooks.js';
import { Link } from '../app/router.js';
import { ChevronLeft } from '../components/Icons.js';
import { isIos, isStandalone } from '../features/push.js';
import {
  installPrompt,
  justInstalled,
  onInstallChange,
  runInstallPrompt,
} from '../features/install.js';

/** Where "back" goes depends on whether this phone is paired yet. */
export function BackLink({ top = false }: { top?: boolean }) {
  const { phase } = useApp();
  const paired = phase === 'ready';
  return top ? (
    <Link to={paired ? '/settings' : '/'} className="page-back">
      <ChevronLeft />
      {paired ? 'Settings' : 'Back'}
    </Link>
  ) : (
    <p>
      <Link to={paired ? '/settings' : '/'} className="btn">
        {paired ? 'Back to settings' : 'Back'}
      </Link>
    </p>
  );
}

export function InstallPage() {
  const [, rerender] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => onInstallChange(() => rerender((n) => n + 1)), []);

  const ios = isIos();
  const installed = isStandalone() || justInstalled();
  const prompt = installPrompt();
  const paired = useApp().phase === 'ready';
  // Settings exists only once the phone is paired, so the last step depends on where you are.
  const finish = paired
    ? 'then turn on notifications in Settings.'
    : 'pair it with your computer, then turn on notifications in Settings.';

  return (
    <div className="page prose">
      <BackLink top />
      <h1>Install Decisions</h1>
      {installed ? (
        <p className="card">
          {isStandalone()
            ? `You are using the installed app. Now ${finish.replace(/^then /, '')}`
            : `Decisions is installed on your Home Screen. Open it from there, ${finish}`}
        </p>
      ) : (
        <p>
          Install Decisions so it opens like an app and can send you notifications.{' '}
          {ios && (
            <strong>
              On iPhone and iPad, notifications only work once it is on your Home Screen (iOS 16.4
              or newer).
            </strong>
          )}
        </p>
      )}

      {ios && !installed && (
        <ol className="steps">
          <li>
            Open this page in <strong>Safari</strong> (not inside another app).
          </li>
          <li>
            Tap the <strong>Share</strong> button: a square with an arrow pointing up. If you do not
            see it, tap <strong>···</strong> first, then <strong>Share</strong>.
          </li>
          <li>
            Tap <strong>Add to Home Screen</strong> (you may need to scroll down or tap{' '}
            <strong>More</strong>), then <strong>Add</strong>.
          </li>
          <li>
            Open <strong>Decisions</strong> from your Home Screen, {finish}
          </li>
        </ol>
      )}

      {!ios && !installed && (
        <>
          {prompt ? (
            <button
              type="button"
              className="btn primary big"
              onClick={() => {
                void runInstallPrompt().then((o) =>
                  setResult(
                    o === 'accepted'
                      ? `Installed. Open Decisions from your Home Screen, ${finish}`
                      : 'No problem. You can install it later from the browser menu.',
                  ),
                );
              }}
            >
              Install app
            </button>
          ) : (
            <ol className="steps">
              <li>
                Open the browser menu (<strong>⋮</strong> in Chrome).
              </li>
              <li>
                Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
              </li>
              <li>Open Decisions from your Home Screen, {finish}</li>
            </ol>
          )}
          {result && <p role="status">{result}</p>}
        </>
      )}
    </div>
  );
}
