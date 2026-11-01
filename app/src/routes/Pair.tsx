import { useEffect, useRef, useState } from 'react';
import { app } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import {
  clearPendingInvite,
  parseInviteText,
  peekPendingInvite,
  setPendingInvite,
} from '../app/invite.js';
import { Link, navigate } from '../app/router.js';
import { QrScanner } from '../components/QrScanner.js';
import { PairingError, type PairingPhase } from '../data/pairing.js';
import { isIos } from '../features/push.js';

function defaultLabel(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android phone';
  return isIos() ? 'iPhone' : 'This device';
}

export function PairPage() {
  const snap = useApp();
  const [, force] = useState(0);
  const [label, setLabel] = useState(defaultLabel);
  const [phase, setPhase] = useState<PairingPhase | null>(null);
  const [scanning, setScanning] = useState(false);
  const [paste, setPaste] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pending = peekPendingInvite();
  const invite = pending?.invite;

  useEffect(() => () => abort.current?.abort(), []);

  if (snap.phase === 'ready') {
    return (
      <div className="page center-page">
        <h1>This phone is already paired</h1>
        <p>To pair it with a different computer, erase this phone first in Settings.</p>
        <Link to="/" className="btn primary">
          Go to inbox
        </Link>
      </div>
    );
  }

  const accept = (text: string) => {
    try {
      setPendingInvite(parseInviteText(text, location.origin));
      setProblem(null);
      setScanning(false);
      force((n) => n + 1);
    } catch (e) {
      setScanning(false);
      setProblem(e instanceof Error ? e.message : 'That is not a Decisions pairing code.');
    }
  };

  const start = async () => {
    if (!invite) return;
    abort.current = new AbortController();
    setProblem(null);
    try {
      await app.pair(invite, label.trim() || defaultLabel(), setPhase, abort.current.signal);
      clearPendingInvite();
      navigate('/', true);
    } catch (e) {
      clearPendingInvite();
      setProblem(e instanceof PairingError ? e.message : 'Pairing failed.');
      setPhase(null);
      force((n) => n + 1);
    }
  };

  const code = phase?.phase === 'awaiting-approval' ? phase.shortCode : null;

  return (
    <div className="page center-page">
      <h1>Pair this phone</h1>
      {problem && (
        <p className="note error" role="alert">
          {problem}
        </p>
      )}
      {pending?.error && !problem && (
        <p className="note error" role="alert">
          {pending.error}
        </p>
      )}

      {code ? (
        <section aria-live="polite" className="code-card">
          <p>Confirm this code on your computer:</p>
          <p className="big-code" aria-label={`Code ${code.replace(' ', ' ')}`}>
            {code}
          </p>
          <p className="muted">
            In Daintree, check the same six digits and choose <strong>Approve</strong>. If they
            differ, choose Decline and start again.
          </p>
          <button type="button" className="btn" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </section>
      ) : phase && phase.phase !== 'error' ? (
        <p role="status" className="note">
          {phase.phase === 'registering'
            ? 'Contacting your relay…'
            : phase.phase === 'finalizing'
              ? 'Securing this phone…'
              : 'Done'}
        </p>
      ) : invite ? (
        <>
          <p>
            This will let this phone read and answer your Daintree questions. Only continue if you
            started pairing on your own computer just now.
          </p>
          <label className="field">
            Name this device
            <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <button type="button" className="btn primary big" onClick={() => void start()}>
            Pair this phone
          </button>
        </>
      ) : scanning ? (
        <QrScanner onResult={accept} onCancel={() => setScanning(false)} />
      ) : (
        <>
          <p>
            On your computer open <strong>Daintree → Settings → Decisions → Pair a phone</strong> to
            show a QR code.
          </p>
          <button type="button" className="btn primary big" onClick={() => setScanning(true)}>
            Scan QR code
          </button>
          <details className="paste">
            <summary>Paste the link instead</summary>
            <label className="field">
              Pairing link
              <input
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder="https://…/pair#…"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={!paste.trim()}
              onClick={() => accept(paste)}
            >
              Continue
            </button>
          </details>
          {isIos() && (
            <p className="note">
              Tip: on iPhone, pair in Safari first, then add Decisions to your Home Screen.{' '}
              <Link to="/install">How</Link>
            </p>
          )}
        </>
      )}
      <p className="muted">
        <Link to="/privacy">Who sees what</Link>
      </p>
    </div>
  );
}
