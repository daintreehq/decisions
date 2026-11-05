import { useEffect, useId, useRef, useState } from 'react';
import { app } from '../app/controller.js';
import { useApp, useNow } from '../app/hooks.js';
import {
  clearPendingInvite,
  parseInviteText,
  peekPendingInvite,
  setPendingInvite,
} from '../app/invite.js';
import { Link, navigate } from '../app/router.js';
import { ErrorIcon, LinkIcon, ScanIcon } from '../components/Icons.js';
import { QrScanner, type ScanStatus } from '../components/QrScanner.js';
import { codeGroups, pairingProblem } from '../components/settings/pairingErrors.js';
import { Callout } from '../components/settings/ui.js';
import { PairingError, type PairingPhase } from '../data/pairing.js';
import { isIos, isStandalone } from '../features/push.js';
import { BackLink, detectPlatform } from './Install.js';

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
  // A bad invitation link from earlier has had its say; a fresh start doesn't carry its warning.
  if (peekPendingInvite()?.error) clearPendingInvite();
  navigate('/pair');
}

/**
 * On a desktop browser the code is usually on this same screen, so pasting its link is the realistic way in and
 * scanning is the alternative. Phones and tablets scan first.
 */
export function pasteFirst(): boolean {
  const p = detectPlatform();
  return p === 'desktop' || p === 'mac-safari';
}

/** Where the code lives on the computer, worded once for the welcome and the pairing start. */
export function WhereTheCodeIs() {
  return (
    <>
      In Daintree on your computer, open <span className="nowrap">Settings ›</span>{' '}
      <span className="nowrap">Decisions ›</span> <span className="nowrap">Pair a phone</span>.
    </>
  );
}

/** iPadOS Safari reports a Mac by default; a Mac with a touch screen is an iPad. */
function ipad(): boolean {
  const ua = navigator.userAgent;
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** The Home Screen advice for iPhone and iPad, worded once for the welcome, the pairing start and the invitation. */
export function HomeScreenFirst() {
  return (
    <>
      To get notifications on {ipad() ? 'iPad' : 'iPhone'}, add Decisions to your Home Screen first
      and pair it from there.
    </>
  );
}

/**
 * An iPhone or iPad keeps a Home Screen app's storage apart from Safari's, so a pairing made in a Safari tab does not
 * carry into the installed app, and only the installed app can notify. Said wherever pairing starts in Safari.
 */
function safariOnIos(): boolean {
  return isIos() && !isStandalone();
}

function relayHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The code digit by digit, with a pause between its two groups. */
function spokenGroups(code: string): string {
  return codeGroups(code)
    .map((g) => g.split('').join(' '))
    .join(', ');
}

function Countdown({ until }: { until: string }) {
  const now = useNow(1000);
  const s = Math.max(0, Math.floor((Date.parse(until) - now) / 1000));
  if (!Number.isFinite(s)) return null;
  return (
    <span className="tabular nowrap">
      {s === 0
        ? 'Code expired'
        : `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}
    </span>
  );
}

/** A paste that is not a pairing link, said beside the field that holds it. */
function pasteProblem(message: string): string {
  if (/different relay/.test(message))
    return 'This link is for a different relay. Open Decisions at the address Daintree shows next to the code, then pair there.';
  return 'That isn’t a pairing link. Copy the whole link from Daintree, then paste it again.';
}

export function PairPage() {
  const snap = useApp();
  const [, force] = useState(0);
  const [label, setLabel] = useState(defaultLabel);
  const [phase, setPhase] = useState<PairingPhase | null>(null);
  const [scanning, setScanning] = useState(() => startWith === 'scan');
  const [scanKey, setScanKey] = useState(0);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [pasteOpen, setPasteOpen] = useState(() => startWith === 'paste');
  const pasteInput = useRef<HTMLInputElement>(null);
  const pasteOpener = useRef<HTMLButtonElement>(null);
  // Folding the paste card removes the focused Cancel; focus goes back to the button that opened it.
  const [refocusPaste, setRefocusPaste] = useState(false);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [gated, setGated] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const abort = useRef<AbortController | null>(null);
  const ids = useId();
  const pending = peekPendingInvite();
  const invite = pending?.invite;
  // Before pairing, leaving the scanner or the paste field goes back to the welcome, which offers the same two ways in.
  const unpaired = snap.phase !== 'ready';

  useEffect(() => {
    startWith = null;
    return () => abort.current?.abort();
  }, []);
  useEffect(() => {
    if (pasteOpen && !scanning) pasteInput.current?.focus();
  }, [pasteOpen, scanning]);
  useEffect(() => {
    if (!refocusPaste || pasteOpen) return;
    pasteOpener.current?.focus();
    setRefocusPaste(false);
  }, [refocusPaste, pasteOpen]);

  const code = phase?.phase === 'awaiting-approval' ? phase.shortCode : null;
  const expiresAt = phase?.phase === 'awaiting-approval' ? phase.expiresAt : null;
  const busy = !!phase && phase.phase !== 'error';
  const registering = phase?.phase === 'registering';
  const view = code ? 'code' : busy ? 'busy' : invite ? 'invite' : scanning ? 'scan' : 'start';

  // Each step announces itself by taking focus on its heading, so keyboard and screen-reader users keep their place.
  // The paste field takes focus itself; the first render leaves focus where the app put it.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    if (view === 'start' && pasteOpen) return;
    // The progress step shows only after 400 ms, so a fast relay never moves focus to a screen nobody saw.
    if (view === 'busy') {
      const t = setTimeout(() => heading.current?.focus({ preventScroll: true }), 400);
      return () => clearTimeout(t);
    }
    heading.current?.focus({ preventScroll: true });
    // A camera retry remounts the scanner, so its heading takes focus again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, scanKey]);

  // The same 400 ms gate for what a loading step says aloud as for what it shows: each loading phase (contacting,
  // securing, the camera starting) is announced only once it has been on screen for 400 ms.
  const gateKey = busy
    ? (phase?.phase ?? '')
    : scanning && scanStatus === 'starting'
      ? 'camera'
      : '';
  useEffect(() => {
    setGated('');
    if (!gateKey) return;
    const t = setTimeout(() => setGated(gateKey), 400);
    return () => clearTimeout(t);
  }, [gateKey]);
  const settled = gateKey !== '' && gated === gateKey;

  // A code past its expiry is no longer worth comparing: say so at once rather than waiting on the relay.
  useEffect(() => {
    if (!expiresAt) return;
    const ms = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return;
    const t = setTimeout(
      () => {
        setProblem('The pairing code expired.');
        abort.current?.abort();
      },
      Math.max(0, ms),
    );
    return () => clearTimeout(t);
  }, [expiresAt]);

  // A relay that takes more than a few seconds to answer gets a word of explanation.
  useEffect(() => {
    setSlow(false);
    if (!registering) return;
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, [registering]);

  if (snap.phase === 'ready') {
    return (
      <div className="page onb onb-paired">
        <BackLink />
        <div className="onb-body">
          <h1>This device is already paired</h1>
          <p className="onb-lead">To pair it with a different computer, unpair it first.</p>
          <div className="onb-actions">
            <Link to="/" className="btn primary big">
              Go to questions
            </Link>
            <Link to="/settings/privacy" className="btn big">
              Open Privacy &amp; security
            </Link>
          </div>
        </div>
      </div>
    );
  }

  /** Clears whatever went wrong last, so a new attempt starts clean. */
  const fresh = () => {
    setProblem(null);
    setPasteError(null);
    if (pending?.error) clearPendingInvite();
  };

  const leave = () => {
    fresh();
    setScanning(false);
    setPasteOpen(false);
    setPaste('');
    if (unpaired) navigate('/', true);
  };

  const accept = (text: string, from: 'scan' | 'paste') => {
    try {
      setPendingInvite(parseInviteText(text, location.origin));
      setProblem(null);
      setPasteError(null);
      setScanning(false);
      setPasteOpen(false);
      force((n) => n + 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (from === 'paste') {
        setPasteError(pasteProblem(msg));
        pasteInput.current?.focus();
        return;
      }
      setScanning(false);
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

  const shown = problem ?? (!busy ? pending?.error : null) ?? null;
  const issue = shown ? pairingProblem(shown) : null;
  const desk = pasteFirst();

  // Said before the actions it qualifies, so it is read before someone commits to pairing in Safari.
  const installNote = safariOnIos() && (
    <p className="onb-note pair-ios-note">
      <HomeScreenFirst /> A pairing made in Safari stays in Safari.{' '}
      <Link to="/install">How to install</Link>
    </p>
  );

  // What went wrong last sits under the step's heading, so focus on the heading reads it next.
  const callout = issue && (
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
  );

  let body;
  if (code && phase?.phase === 'awaiting-approval') {
    body = (
      <section className="pair-code" aria-labelledby="code-h">
        <h1 id="code-h" ref={heading} tabIndex={-1}>
          Compare the code
        </h1>
        <p className="onb-lead">Check that this matches your computer.</p>
        <p className="pair-digits" aria-hidden="true">
          {codeGroups(code).map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </p>
        <p className="sr-only">Code: {spokenGroups(code)}</p>
        <p className="onb-note">
          If the six digits match, choose <strong>Approve</strong> in Daintree. If they don’t,
          choose <strong>Decline</strong>.
        </p>
        <p className="pair-wait">
          <span className="pair-wait-label">
            <span className="spinner" aria-hidden="true" />
            Waiting for your computer
          </span>
          <span className="pair-wait-sep" aria-hidden="true">
            ·
          </span>
          <span className="sr-only">. </span>
          <Countdown until={phase.expiresAt} />
        </p>
        <button type="button" className="btn big" onClick={() => abort.current?.abort()}>
          Cancel
        </button>
      </section>
    );
  } else if (busy) {
    body = (
      <section className="pair-progress">
        <h1 ref={heading} tabIndex={-1}>
          Pairing
        </h1>
        <p className="pair-wait">
          <span className="pair-wait-label">
            <span className="spinner" aria-hidden="true" />
            {registering
              ? 'Contacting your relay…'
              : phase?.phase === 'finalizing'
                ? 'Securing this device…'
                : 'Done'}
          </span>
        </p>
        {/* The space is kept from the start, so the words arriving at five seconds move nothing. */}
        {registering && (
          <p className="onb-note pair-slow">
            {slow ? 'Still trying to reach your relay. Check your connection.' : ''}
          </p>
        )}
        {/* Cancelling is safe until the relay has the device; securing it is quick and must finish. */}
        {registering && (
          <button type="button" className="btn big" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
      </section>
    );
  } else if (invite) {
    body = (
      <section>
        <h1 ref={heading} tabIndex={-1}>
          Pair with your computer?
        </h1>
        {callout}
        <p className="onb-lead">
          This device will be able to read and answer your Daintree questions. Only continue if you
          started pairing on your own computer just now.
        </p>
        {installNote}
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
          <div className="field">
            <label htmlFor={`${ids}-label`}>Name this device</label>
            <input
              id={`${ids}-label`}
              value={label}
              maxLength={60}
              aria-describedby={`${ids}-label-hint`}
              onChange={(e) => setLabel(e.target.value)}
            />
            <span className="hint" id={`${ids}-label-hint`}>
              Your computer shows this name in its device list.
            </span>
          </div>
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
        <h1 ref={heading} tabIndex={-1}>
          Scan the pairing code
        </h1>
        {callout}
        <QrScanner
          key={scanKey}
          onResult={(text) => accept(text, 'scan')}
          onStatus={setScanStatus}
          onCancel={leave}
          onPaste={() => {
            fresh();
            setPasteOpen(true);
            setScanning(false);
          }}
          onRetry={() => setScanKey((k) => k + 1)}
        />
      </section>
    );
  } else {
    const scanButton = (
      <button
        type="button"
        className={`btn big${pasteOpen || desk ? '' : ' primary'}`}
        onClick={() => {
          fresh();
          setPasteOpen(false);
          setScanning(true);
        }}
      >
        <ScanIcon size={20} />
        Scan pairing code
      </button>
    );
    const pasteButton = (
      <button
        ref={pasteOpener}
        type="button"
        className={`btn big${desk ? ' primary' : ''}`}
        onClick={() => {
          fresh();
          setPasteOpen(true);
        }}
      >
        <LinkIcon size={20} />
        Paste pairing link
      </button>
    );
    body = (
      <section>
        <h1 ref={heading} tabIndex={-1}>
          Pair this device
        </h1>
        {callout}
        <p className="onb-lead">
          <WhereTheCodeIs />
        </p>
        {installNote}
        {pasteOpen ? (
          <>
            <form
              className="pair-paste"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (paste.trim()) accept(paste, 'paste');
              }}
            >
              <div className="field">
                <label htmlFor={`${ids}-paste`}>Pairing link</label>
                <input
                  id={`${ids}-paste`}
                  ref={pasteInput}
                  value={paste}
                  onChange={(e) => {
                    setPaste(e.target.value);
                    setPasteError(null);
                  }}
                  placeholder="https://…/pair#…"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="url"
                  aria-invalid={pasteError ? true : undefined}
                  aria-describedby={`${ids}-paste-${pasteError ? 'error' : 'hint'}`}
                />
                {pasteError ? (
                  <span className="pair-field-error" id={`${ids}-paste-error`}>
                    <ErrorIcon size={16} />
                    {pasteError}
                  </span>
                ) : (
                  <span className="hint" id={`${ids}-paste-hint`}>
                    Daintree shows it under the pairing code. Copy it there, then paste it here.
                  </span>
                )}
              </div>
              <div className="pair-paste-actions">
                {/* Cancel folds the card back into the two ways in; Back above leaves the page. */}
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    fresh();
                    setPasteOpen(false);
                    setPaste('');
                    setRefocusPaste(true);
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={!paste.trim()}>
                  Continue
                </button>
              </div>
            </form>
            <div className="onb-actions pair-alt">{scanButton}</div>
          </>
        ) : (
          <div className="onb-actions">
            {desk ? (
              <>
                {pasteButton}
                {scanButton}
              </>
            ) : (
              <>
                {scanButton}
                {pasteButton}
              </>
            )}
          </div>
        )}
      </section>
    );
  }

  const status = code
    ? `Your code is ${spokenGroups(code)}. If your computer shows the same code, approve it there. If it doesn’t, decline it there.`
    : registering
      ? slow
        ? 'Still trying to reach your relay. Check your connection.'
        : settled
          ? 'Contacting your relay.'
          : ''
      : phase?.phase === 'finalizing'
        ? settled
          ? 'Securing this device.'
          : ''
        : pasteError
          ? pasteError
          : scanning && scanStatus === 'live'
            ? 'Camera ready. Point it at the code on your computer’s screen.'
            : scanning && scanStatus === 'starting' && settled
              ? 'Starting the camera.'
              : '';

  return (
    // Once pairing is under way the back link goes, so the code comparison takes the welcome's centred column
    // rather than jumping to the top edge with the lower half empty.
    <div className={`page onb${busy ? ' onb-center' : ''}`}>
      {/* Leaving this page cancels a pairing in progress, so the way out is offered only before one starts. The
          scanner and the invitation carry their own exits (Cancel, Not now), so they don't get a second one. The
          start keeps it with the paste field open, so opening the field moves nothing above it. */}
      {!busy && !invite && !scanning && <BackLink />}
      <div className="onb-body">{body}</div>
      {/* One live region for the whole page: screen readers announce changes to it, not regions that appear. */}
      <p className="sr-only" role="status">
        {status}
      </p>
    </div>
  );
}
