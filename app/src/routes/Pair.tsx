import { useEffect, useRef, useState } from 'react';
import { app } from '../app/controller.js';
import { useApp, useNow } from '../app/hooks.js';
import {
  clearPendingInvite,
  parseInviteText,
  peekPendingInvite,
  setPendingInvite,
} from '../app/invite.js';
import { Link, navigate } from '../app/router.js';
import { LinkIcon, ScanIcon } from '../components/Icons.js';
import { QrScanner } from '../components/QrScanner.js';
import { codeGroups, pairingProblem, spokenCode } from '../components/settings/pairingErrors.js';
import { Callout } from '../components/settings/ui.js';
import { PairingError, type PairingPhase } from '../data/pairing.js';
import { isIos } from '../features/push.js';
import { BackLink } from './Install.js';

function defaultLabel(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (isIos()) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

/** How the welcome screen asked to start, so the camera opens only because the person tapped Scan. */
let startWith: 'scan' | 'paste' | null = null;
export function startPairing(mode: 'scan' | 'paste'): void {
  startWith = mode;
  navigate('/pair');
}

function relayHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function Countdown({ until }: { until: string }) {
  const now = useNow(1000);
  const s = Math.max(0, Math.floor((Date.parse(until) - now) / 1000));
  if (!Number.isFinite(s)) return null;
  return (
    <span className="tabular">
      {s === 0
        ? 'Code expired'
        : `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}
    </span>
  );
}

export function PairPage() {
  const snap = useApp();
  const [, force] = useState(0);
  const [label, setLabel] = useState(defaultLabel);
  const [phase, setPhase] = useState<PairingPhase | null>(null);
  const [scanning, setScanning] = useState(() => startWith === 'scan');
  const [scanKey, setScanKey] = useState(0);
  const [pasteOpen, setPasteOpen] = useState(() => startWith === 'paste');
  const pasteInput = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pending = peekPendingInvite();
  const invite = pending?.invite;

  useEffect(() => {
    startWith = null;
    return () => abort.current?.abort();
  }, []);
  useEffect(() => {
    if (pasteOpen && !scanning) pasteInput.current?.focus();
  }, [pasteOpen, scanning]);

  if (snap.phase === 'ready') {
    return (
      <div className="page onb">
        <div className="onb-body">
          <h1>This device is already paired</h1>
          <p className="onb-lead">
            To pair it with a different computer, unpair it first in Settings › Privacy &amp;
            security.
          </p>
          <Link to="/" className="btn primary big">
            Go to questions
          </Link>
        </div>
      </div>
    );
  }

  const accept = (text: string) => {
    try {
      setPendingInvite(parseInviteText(text, location.origin));
      setProblem(null);
      setScanning(false);
      setPasteOpen(false);
      force((n) => n + 1);
    } catch (e) {
      setScanning(false);
      const msg = e instanceof Error ? e.message : '';
      setProblem(/different relay/.test(msg) ? msg : 'This pairing link is not valid.');
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
  const shown = problem ?? (!busy ? pending?.error : null) ?? null;
  const issue = shown ? pairingProblem(shown) : null;

  let body;
  if (code && phase?.phase === 'awaiting-approval') {
    body = (
      <section className="pair-code" aria-labelledby="code-h">
        <h1 id="code-h">Compare the code</h1>
        <p className="onb-lead">Check that this matches your computer.</p>
        <p className="pair-digits" aria-hidden="true">
          {codeGroups(code).map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </p>
        <p className="sr-only">Code: {spokenCode(code)}</p>
        <p className="onb-note">
          If the six digits match, choose <strong>Approve</strong> in Daintree. If they don’t,
          choose <strong>Decline</strong>.
        </p>
        <p className="pair-wait">
          <span className="spinner" aria-hidden="true" />
          <span>Waiting for your computer</span>
          <span aria-hidden="true">·</span>
          <Countdown until={phase.expiresAt} />
        </p>
        <button type="button" className="btn" onClick={() => abort.current?.abort()}>
          Cancel
        </button>
      </section>
    );
  } else if (busy) {
    body = (
      <section className="pair-progress">
        <h1>Pairing</h1>
        <p className="pair-wait">
          <span className="spinner" aria-hidden="true" />
          {phase?.phase === 'registering'
            ? 'Contacting your relay…'
            : phase?.phase === 'finalizing'
              ? 'Securing this device…'
              : 'Done'}
        </p>
      </section>
    );
  } else if (invite) {
    body = (
      <section>
        <h1>Pair with your computer?</h1>
        <p className="onb-lead">
          This device will be able to read and answer your Daintree questions. Only continue if you
          started pairing on your own computer just now.
        </p>
        <p className="pair-relay">
          <span className="eyebrow">Relay</span>
          <span className="mono">{relayHost(invite.o)}</span>
        </p>
        <form
          className="pair-form"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label className="field">
            Name this device
            <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
            <span className="hint">Your computer shows this name in its device list</span>
          </label>
          <button type="submit" className="btn primary big">
            Pair this device
          </button>
          <button
            type="button"
            className="btn ghost big"
            onClick={() => {
              clearPendingInvite();
              navigate('/', true);
            }}
          >
            Not now
          </button>
        </form>
      </section>
    );
  } else if (scanning) {
    body = (
      <section>
        <h1>Scan the pairing code</h1>
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
      </section>
    );
  } else {
    body = (
      <section>
        <h1>Pair this device</h1>
        <p className="onb-lead">
          On your computer, open <strong>Daintree › Settings › Decisions</strong> and choose{' '}
          <strong>Pair a phone</strong> to show a pairing code.
        </p>
        <div className="onb-actions">
          <button
            type="button"
            className="btn primary big"
            onClick={() => {
              setProblem(null);
              setScanning(true);
            }}
          >
            <ScanIcon size={20} />
            Scan pairing code
          </button>
          {!pasteOpen && (
            <button type="button" className="btn big" onClick={() => setPasteOpen(true)}>
              <LinkIcon size={18} />
              Paste pairing link
            </button>
          )}
        </div>
        {pasteOpen && (
          <form
            className="pair-paste"
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
                spellCheck={false}
                inputMode="url"
              />
              <span className="hint">
                The link that comes with the pairing code on your computer
              </span>
            </label>
            <div className="pair-paste-actions">
              <button type="button" className="btn" onClick={() => setPasteOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={!paste.trim()}>
                Continue
              </button>
            </div>
          </form>
        )}
        {isIos() && (
          <p className="onb-note">
            On iPhone, pair here in Safari first, then add Decisions to your Home Screen.{' '}
            <Link to="/install">How to install</Link>
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="page onb">
      {/* Leaving this page cancels a pairing in progress, so the way out is offered only before one starts. */}
      {!busy && <BackLink />}
      <div className="onb-body">
        {issue && (
          <Callout
            tone={issue.tone}
            role="alert"
            title={issue.title}
            action={
              issue.action === 'reload' ? (
                <button type="button" className="btn small" onClick={() => location.reload()}>
                  Reload
                </button>
              ) : undefined
            }
          >
            {issue.body}
          </Callout>
        )}
        {body}
      </div>
      {/* One live region for the whole page: screen readers announce changes to it, not regions that appear. */}
      <p className="sr-only" role="status">
        {code
          ? `Your code is ${spokenCode(code)}. Check that your computer shows the same code, then approve it there.`
          : phase?.phase === 'registering'
            ? 'Contacting your relay.'
            : phase?.phase === 'finalizing'
              ? 'Securing this device.'
              : ''}
      </p>
    </div>
  );
}
