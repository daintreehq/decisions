import { useState } from 'react';
import { app } from '../app/controller.js';
import type { Phase } from '../app/controller.js';
import { Link, navigate } from '../app/router.js';
import { LinkIcon, LockIcon, ScanIcon } from '../components/Icons.js';
import { forgetServerSettings } from '../components/settings/QuietHoursSection.js';
import { startPairing } from './Pair.js';

/**
 * Shown when no keys exist, or this device was revoked. Renders nothing decrypted: the app only reaches here with no
 * pairing or a revoked one, and the revoked screen offers only the way back to a clean start.
 */
export function LockedPage({ phase }: { phase: Extract<Phase, 'unpaired' | 'revoked'> }) {
  const [clearing, setClearing] = useState(false);
  if (phase === 'revoked') {
    return (
      <div className="page onb onb-center">
        <div className="onb-body">
          <span className="onb-lock" aria-hidden="true">
            <LockIcon size={28} />
          </span>
          <h1>This device is no longer paired</h1>
          <p className="onb-lead">
            Your computer revoked it, so it can’t receive or answer questions. Nothing saved here is
            shown.
          </p>
          <div className="onb-actions">
            <button
              type="button"
              className="btn primary big"
              disabled={clearing}
              onClick={() => {
                setClearing(true);
                forgetServerSettings();
                void app.wipe().then(() => navigate('/pair', true));
              }}
            >
              {clearing ? 'Erasing…' : 'Pair again'}
            </button>
          </div>
          <p className="onb-note">
            Pairing again first erases the Decisions data saved on this device. Nothing else on it
            is touched.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="page onb onb-center welcome">
      <div className="onb-body">
        <img src="/icons/icon-192.png" width="72" height="72" alt="" className="onb-mark" />
        <h1>Daintree Decisions</h1>
        <p className="onb-lead">
          Answer the questions your coding agents are waiting on, wherever you are.
        </p>
        <div className="onb-actions">
          <button type="button" className="btn primary big" onClick={() => startPairing('scan')}>
            <ScanIcon size={20} />
            Scan pairing code
          </button>
          <button type="button" className="btn big" onClick={() => startPairing('paste')}>
            <LinkIcon size={20} />
            Paste pairing link
          </button>
        </div>
        <p className="onb-hint">
          Daintree shows the code in <span className="nowrap">Settings ›</span>{' '}
          <span className="nowrap">Decisions ›</span> <span className="nowrap">Pair a phone</span>.
        </p>
      </div>
      <nav className="onb-links" aria-label="More">
        <Link to="/install">Install the app</Link>
        <span aria-hidden="true">·</span>
        <Link to="/privacy">Who sees what</Link>
      </nav>
    </div>
  );
}
