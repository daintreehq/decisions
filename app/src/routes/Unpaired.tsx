import { useState } from 'react';
import { app } from '../app/controller.js';
import type { Phase } from '../app/controller.js';
import { Link, navigate } from '../app/router.js';
import { LinkIcon, LockIcon, ScanIcon } from '../components/Icons.js';
import { Callout } from '../components/settings/ui.js';
import { isIos, isStandalone } from '../features/push.js';
import { forgetServerSettings } from '../components/settings/QuietHoursSection.js';
import { HomeScreenFirst, pasteFirst, startPairing, WhereTheCodeIs } from './Pair.js';

/**
 * Shown when no keys exist, or this device was revoked. Renders nothing decrypted: the app only reaches here with no
 * pairing or a revoked one, and the revoked screen offers only the way back to a clean start.
 */
export function LockedPage({ phase }: { phase: Extract<Phase, 'unpaired' | 'revoked'> }) {
  const [clearing, setClearing] = useState(false);
  const [wipeFailed, setWipeFailed] = useState(false);
  if (phase === 'revoked') {
    return (
      <div className="page onb onb-center">
        <div className="onb-body">
          <span className="onb-lock" aria-hidden="true">
            <LockIcon size={32} />
          </span>
          <h1>This device is no longer paired</h1>
          <p className="onb-lead">
            Your computer revoked it, so it can’t receive or answer questions. Nothing saved on this
            device is shown.
          </p>
          <div className="onb-actions">
            <button
              type="button"
              className="btn primary big"
              // aria-disabled rather than disabled, so focus stays on the button while it erases.
              aria-disabled={clearing || undefined}
              onClick={() => {
                if (clearing) return;
                setClearing(true);
                setWipeFailed(false);
                forgetServerSettings();
                app.wipe().then(
                  () => navigate('/pair', true),
                  () => {
                    setClearing(false);
                    setWipeFailed(true);
                  },
                );
              }}
            >
              {clearing ? 'Erasing…' : 'Pair again'}
            </button>
          </div>
          {wipeFailed ? (
            <div className="onb-note-callout">
              <Callout tone="error" role="alert" title="Couldn’t erase this device">
                Try again, or clear this site’s data in your browser’s settings.
              </Callout>
            </div>
          ) : (
            <p className="onb-note">
              Pairing again first erases the Decisions data saved on this device. Nothing else on it
              is touched.
            </p>
          )}
        </div>
      </div>
    );
  }
  const desk = pasteFirst();
  const scan = (
    <button
      type="button"
      className={`btn big${desk ? '' : ' primary'}`}
      onClick={() => startPairing('scan')}
    >
      <ScanIcon size={20} />
      Scan pairing code
    </button>
  );
  const paste = (
    <button
      type="button"
      className={`btn big${desk ? ' primary' : ''}`}
      onClick={() => startPairing('paste')}
    >
      <LinkIcon size={20} />
      Paste pairing link
    </button>
  );
  return (
    <div className="page onb onb-center welcome">
      <div className="onb-body">
        <img src="/icons/icon-192.png" width="72" height="72" alt="" className="onb-mark" />
        <h1>Daintree Decisions</h1>
        <p className="onb-lead">
          Answer the questions your coding agents are waiting on, wherever you are.
        </p>
        <div className="onb-actions">
          {desk ? (
            <>
              {paste}
              {scan}
            </>
          ) : (
            <>
              {scan}
              {paste}
            </>
          )}
        </div>
        <p className="onb-hint">
          <WhereTheCodeIs />
        </p>
        {/* Scan goes straight to the camera, so in Safari on iPhone the Home Screen advice is said here, first. The
            foot's Install link is how. */}
        {isIos() && !isStandalone() && (
          <p className="onb-hint">
            <HomeScreenFirst />
          </p>
        )}
      </div>
      <nav className="onb-links" aria-label="More">
        <Link to="/install">Install the app</Link>
        <span aria-hidden="true">·</span>
        <Link to="/privacy">Who sees what</Link>
      </nav>
    </div>
  );
}
