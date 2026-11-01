import { app } from '../app/controller.js';
import { Link, navigate } from '../app/router.js';
import type { Phase } from '../app/controller.js';

/** Shown when no keys exist (or this phone was revoked). Deliberately renders no cached content. */
export function LockedPage({ phase }: { phase: Extract<Phase, 'unpaired' | 'revoked'> }) {
  if (phase === 'revoked') {
    return (
      <div className="page center-page">
        <h1>This phone was removed</h1>
        <p>
          Your computer revoked this device, so it can no longer read or answer questions. You can
          erase it and pair again.
        </p>
        <button
          type="button"
          className="btn primary big"
          onClick={() => {
            void app.wipe().then(() => navigate('/pair', true));
          }}
        >
          Erase and pair again
        </button>
      </div>
    );
  }
  return (
    <div className="page center-page">
      <img src="/icons/icon-192.png" width="96" height="96" alt="" className="logo" />
      <h1>Daintree Decisions</h1>
      <p>
        Answer the questions your coding agents are waiting on, from your phone, whenever you get to
        it.
      </p>
      <Link to="/pair" className="btn primary big">
        Pair this phone
      </Link>
      <p className="muted">
        <Link to="/install">Install on your Home Screen</Link> ·{' '}
        <Link to="/privacy">Who sees what</Link>
      </p>
    </div>
  );
}
