import { app } from '../app/controller.js';
import { Link, navigate } from '../app/router.js';
import type { Phase } from '../app/controller.js';

/** Shown when no keys exist (or this phone was revoked). Deliberately renders no cached content. */
export function LockedPage({ phase }: { phase: Extract<Phase, 'unpaired' | 'revoked'> }) {
  if (phase === 'revoked') {
    return (
      <div className="page center-page welcome">
        <h1>This phone was removed</h1>
        <p>Your computer removed this phone, so it will not receive or answer any new questions.</p>
        <p className="muted">
          Clearing it deletes the Decisions data saved here (nothing else on the phone). Then you
          can pair it again.
        </p>
        <button
          type="button"
          className="btn primary big"
          onClick={() => {
            void app.wipe().then(() => navigate('/pair', true));
          }}
        >
          Clear and pair again
        </button>
      </div>
    );
  }
  return (
    <div className="page center-page welcome">
      <img src="/icons/icon-192.png" width="96" height="96" alt="" className="logo" />
      <h1>Daintree Decisions</h1>
      <p>
        Answer the questions your coding agents are waiting on, from your phone, whenever you get to
        it.
      </p>
      <Link to="/pair" className="btn primary big">
        Pair this phone
      </Link>
      <nav className="links" aria-label="More">
        <Link to="/install" className="text-link">
          Install on your Home Screen
        </Link>
        <Link to="/privacy" className="text-link">
          Who sees what
        </Link>
      </nav>
    </div>
  );
}
