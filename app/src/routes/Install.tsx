import { useEffect, useState } from 'react';
import { Link } from '../app/router.js';
import { isIos, isStandalone } from '../features/push.js';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPage() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);

  const ios = isIos();
  const installed = isStandalone();

  return (
    <div className="page">
      <h1>Install Decisions</h1>
      {installed ? (
        <p className="card">Decisions is installed on your Home Screen. You are all set.</p>
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
            Tap the <strong>Share</strong> button: a square with an arrow pointing up, at the bottom
            of the screen (top right on iPad).
          </li>
          <li>
            Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </li>
          <li>
            Open <strong>Decisions</strong> from your Home Screen, then turn on notifications in
            Settings.
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
                void prompt.prompt();
                void prompt.userChoice.then((c) =>
                  setResult(
                    c.outcome === 'accepted'
                      ? 'Installed.'
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
            </ol>
          )}
          {result && <p role="status">{result}</p>}
        </>
      )}
      <p>
        <Link to="/" className="btn">
          Back
        </Link>
      </p>
    </div>
  );
}
