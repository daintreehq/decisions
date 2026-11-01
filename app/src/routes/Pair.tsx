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
import { BackLink } from './Install.js';

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
  const [scanKey, setScanKey] = useState(0);
  const [pasteOpen, setPasteOpen] = useState(false);
  const pasteInput = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pending = peekPendingInvite();
  const invite = pending?.invite;

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (pasteOpen && !scanning) pasteInput.current?.focus();
  }, [pasteOpen, scanning]);

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
    const signal = abort.current.signal;
    try {
      await app.pair(invite, label.trim() || defaultLabel(), setPhase, signal);
      clearPendingInvite();
      navigate('/', true);
    } catch (e) {
      clearPendingInvite();
      // Cancelling is not a failure: go back to the start without an error.
      if (!signal.aborted) setProblem(e instanceof PairingError ? e.message : 'Pairing failed.');
      setPhase(null);
      force((n) => n + 1);
    }
  };

  const code = phase?.phase === 'awaiting-approval' ? phase.shortCode : null;
  const busy = !!phase && phase.phase !== 'error';

  return (
    <div className="page center-page">
      {!busy && (
        <p className="left">
          <BackLink top />
        </p>
      )}
      <h1>{code ? 'Check the code' : 'Pair this phone'}</h1>
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
        <section className="code-card" aria-labelledby="code-h">
          <p id="code-h">Confirm this code on your computer:</p>
          <p className="big-code" aria-hidden="true">
            {code}
          </p>
          <p className="muted">
            In Daintree, check the same six digits and choose <strong>Approve</strong>. If they
            differ, choose Decline and start again.
          </p>
          <p className="waiting">
            <span className="spinner" aria-hidden="true" />
            Waiting for your computer…
          </p>
          <div>
            <button type="button" className="btn" onClick={() => abort.current?.abort()}>
              Cancel pairing
            </button>
          </div>
        </section>
      ) : phase && phase.phase !== 'error' ? (
        <p className="waiting">
          <span className="spinner" aria-hidden="true" />
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <label className="field">
              Name this device
              <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <button type="submit" className="btn primary big">
              Pair this phone
            </button>
          </form>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              clearPendingInvite();
              navigate('/', true);
            }}
          >
            Not now
          </button>
        </>
      ) : scanning ? (
        <QrScanner
          key={scanKey}
          onResult={accept}
          onCancel={() => setScanning(false)}
          onPaste={() => {
            setPasteOpen(true);
            setScanning(false);
          }}
          onRetry={() => setScanKey((k) => k + 1)}
        />
      ) : (
        <>
          <p>
            On your computer open <strong>Daintree → Settings → Decisions → Pair a phone</strong> to
            show a QR code.
          </p>
          <button type="button" className="btn primary big" onClick={() => setScanning(true)}>
            Scan QR code
          </button>
          <details
            className="paste"
            open={pasteOpen}
            onToggle={(e) => setPasteOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>Paste the link instead</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (paste.trim()) accept(paste);
              }}
            >
              <label className="field">
                Pairing link
                <input
                  ref={pasteInput}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder="https://…/pair#…"
                  autoCapitalize="off"
                  autoCorrect="off"
                  inputMode="url"
                />
              </label>
              <button type="submit" className="btn" disabled={!paste.trim()}>
                Continue
              </button>
            </form>
          </details>
          {isIos() && (
            <p className="note">
              Tip: on iPhone, pair in Safari first, then add Decisions to your Home Screen.{' '}
              <Link to="/install" className="text-link">
                Installation help
              </Link>
            </p>
          )}
        </>
      )}
      {/* One live region for the whole page: screen readers announce changes to it, not regions that appear. */}
      <p className="sr-only" role="status">
        {code
          ? `Your code is ${code.replace(/\s/g, '').split('').join(' ')}. Check that your computer shows the same code, then approve it there.`
          : phase?.phase === 'registering'
            ? 'Contacting your relay.'
            : phase?.phase === 'finalizing'
              ? 'Securing this phone.'
              : ''}
      </p>
      {/* Leaving this page cancels a pairing in progress, so the link is offered only before one starts. */}
      {!busy && (
        <nav className="links" aria-label="More">
          <Link to="/privacy" className="text-link">
            Who sees what
          </Link>
        </nav>
      )}
    </div>
  );
}
