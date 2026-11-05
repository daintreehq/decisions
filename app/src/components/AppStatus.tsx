import { useEffect, useRef, useState } from 'react';
import { app } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import { Link } from '../app/router.js';
import { announce } from '../lib/announce.js';
import { CloseIcon, OfflineIcon, RefreshIcon, WarningIcon } from './Icons.js';

/** The Daintree mark (public/icons/mark.svg; Daintree's own DaintreeIcon), inline so it takes the tile's colour. `size` is its width; it sits at 70% of its tile, as on the app icon. */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 177.31 132.85"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M95.92,132.85h-14.52c-.59,0-1.07-.48-1.07-1.07V36.42c0-.74.27-1.46.77-1.99,2.04-2.17,4.79-3.25,7.55-3.25s5.52,1.09,7.55,3.26c.5.54.77,1.26.77,1.99v95.35c0,.59-.47,1.07-1.07,1.07Z" />
      <path d="M177.31,70.43v19.64c0,.59-.48,1.07-1.07,1.07h-14.52c-.59,0-1.07-.48-1.07-1.07v-19.67c0-10.29-5.49-19.81-14.41-24.95l-43.18-24.93c-8.92-5.15-19.9-5.15-28.82,0l-43.18,24.93c-8.92,5.15-14.41,14.66-14.41,24.95v17.75c0,.06,0,.13,0,2.14,0,.59-.48,1.07-1.07,1.07H1.07c-.59,0-1.07-.48-1.07-1.07v-19.86c0-16.27,8.68-31.3,22.76-39.43L65.89,6.1c14.09-8.13,31.44-8.13,45.53,0l43.12,24.89c14.09,8.13,22.77,23.17,22.77,39.44Z" />
      <path d="M63.66,90.05v27.19c0,.59-.48,1.07-1.07,1.07h-14.52c-.59,0-1.07-.48-1.07-1.07v-27.17c0-5.9-3.15-11.34-8.26-14.3l-5.83-3.37c-.66-.38-1.15-1-1.36-1.73s-.41-1.76-.41-2.89c0-4.68,3.21-8.98,7.99-10.11.72-.17,1.48-.05,2.13.32l5.84,3.36c10.25,5.92,16.56,16.85,16.56,28.69Z" />
      <path d="M113.65,90.05v27.19c0,.59.48,1.07,1.07,1.07h14.52c.59,0,1.07-.48,1.07-1.07v-27.17c0-5.9,3.15-11.34,8.26-14.3l5.83-3.37c.66-.38,1.15-1,1.36-1.73s.41-1.76.41-2.89c0-4.68-3.21-8.98-7.99-10.11-.72-.17-1.48-.05-2.13.32l-5.84,3.36c-10.25,5.92-16.56,16.85-16.56,28.69Z" />
    </svg>
  );
}

export type ConnState = 'live' | 'wait' | 'off';

const syncedLabel = (at: number | null) =>
  at
    ? `Synced ${new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : 'Not synced yet';

/**
 * The connection in one word. Offline means this device has no network. The sync engine also reports 'offline'
 * between socket retries while the device is online; that is reconnecting, not offline, and must not claim the
 * network is gone. Polling is not a failure, but polling whose last fetch failed is not a connection either: the
 * relay is not answering, so it reads as reconnecting until a fetch succeeds again.
 */
export function useConnection(): { state: ConnState; label: string; synced: string } {
  const { connection, online, syncing, lastSyncedAt, relayUnreachable } = useApp();
  const state: ConnState = !online
    ? 'off'
    : connection === 'live' || (connection === 'polling' && !relayUnreachable)
      ? 'live'
      : 'wait';
  const label =
    state === 'off'
      ? 'Offline'
      : state === 'live'
        ? 'Connected'
        : syncing
          ? 'Syncing…'
          : lastSyncedAt === null
            ? 'Connecting…'
            : 'Reconnecting…';
  return { state, label, synced: syncedLabel(lastSyncedAt) };
}

/**
 * Announces only the transitions that matter (the network lost, the relay not answering for a while, and back),
 * never each reconnect attempt. Mounted once.
 */
export function useConnectionAnnouncements(): void {
  const { state } = useConnection();
  const long = useLongReconnect();
  const lost = useRef<'off' | 'relay' | null>(null);
  useEffect(() => {
    if (state === 'off' && lost.current !== 'off') {
      lost.current = 'off';
      announce('You are offline.');
    } else if (state === 'wait' && long && lost.current !== 'relay') {
      lost.current = 'relay';
      announce('Can’t reach your relay. Showing what is saved on this device.');
    } else if (state === 'live' && lost.current) {
      announce(lost.current === 'off' ? 'Back online.' : 'Connected to your relay again.');
      lost.current = null;
    }
  }, [state, long]);
}

/**
 * Connection, quietly: a small neutral dot in normal operation, words only when something is off. The question
 * workspace's header shows it; the sidebar says the same thing in its footer.
 */
export function ConnectionPill({ quiet = false }: { quiet?: boolean } = {}) {
  const { state, label, synced } = useConnection();
  return (
    // State as a data attribute: a bare `.live` class collides with the dictation styles.
    <span
      className="conn"
      data-state={state}
      data-quiet={quiet || undefined}
      title={`${label} · ${synced}`}
    >
      <span className="dot" aria-hidden="true" />
      <span className={state === 'live' || quiet ? 'sr-only' : 'conn-label'}>{label}</span>
    </span>
  );
}

const LONG_RECONNECT_MS = 12_000;
/** When the current spell of reconnecting began, shared so a sidebar mounted midway (the column, after a resize)
 * agrees with the menu button instead of starting its own 12 s. */
let reconnectingSince: number | null = null;

/** Whether reconnecting (or polling a relay that does not answer) has taken long enough (12 s) to say so. */
export function useLongReconnect(): boolean {
  const { online } = useApp();
  const { state } = useConnection();
  const reconnecting = online && state === 'wait';
  // Read during render so every instance agrees at once; it only ever moves with `reconnecting`.
  if (!reconnecting) reconnectingSince = null;
  else reconnectingSince ??= Date.now();
  const since = reconnectingSince;
  const [long, setLong] = useState(() => since !== null && Date.now() - since >= LONG_RECONNECT_MS);
  useEffect(() => {
    if (since === null) {
      setLong(false);
      return;
    }
    const left = since + LONG_RECONNECT_MS - Date.now();
    if (left <= 0) {
      setLong(true);
      return;
    }
    setLong(false);
    const t = setTimeout(() => setLong(true), left);
    return () => clearTimeout(t);
  }, [since]);
  return reconnecting && long;
}

/**
 * The sidebar's connection line. Quiet when all is well (a neutral dot and when it last synced); when offline or
 * when reconnecting has taken a while it becomes a tinted block that says what still works, with Retry.
 */
export function ConnectionLine() {
  const { state, label, synced } = useConnection();
  const long = useLongReconnect();
  const { connection, lastSyncedAt, syncing, relayUnreachable } = useApp();
  // Retry acknowledges a tap at once and stays busy until the relay's state next changes (or 3 s pass), since a
  // retry while polling changes no visible state of its own.
  const [kicked, setKicked] = useState(false);
  useEffect(() => setKicked(false), [lastSyncedAt, relayUnreachable, connection]);
  useEffect(() => {
    if (!kicked) return;
    const t = setTimeout(() => setKicked(false), 3_000);
    return () => clearTimeout(t);
  }, [kicked]);
  // The blocks are announced once by useConnectionAnnouncements, so they are not live regions themselves (a live
  // region here would re-read the whole block each time Retry's label changes).
  const when = lastSyncedAt ? ` ${synced}.` : '';
  if (state === 'off')
    return (
      <div className="conn-line" data-state="off" data-block="">
        <OfflineIcon size={16} />
        <span>
          <strong>Offline.</strong> Saved questions and drafts stay here; answers send when you
          reconnect.{when}
        </span>
      </div>
    );
  if (state === 'wait' && long) {
    const retrying = kicked || connection === 'connecting' || syncing;
    return (
      <div className="conn-line" data-state="wait" data-block="">
        <WarningIcon size={16} />
        <span>
          <strong>Can’t reach your relay.</strong> Saved questions and drafts stay here; answers
          send when it’s back.{when}
        </span>
        <button
          type="button"
          className="strip-action"
          aria-disabled={retrying || undefined}
          onClick={() => {
            if (retrying) return;
            setKicked(true);
            app.sync?.kick();
          }}
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    );
  }
  return (
    <p className="conn-line" data-state={state}>
      <span className="dot" aria-hidden="true" />
      <span>{lastSyncedAt ? `${label} · ${synced}` : label}</span>
    </p>
  );
}

/**
 * Whether the closed sidebar is hiding app state worth opening it for, most important first: no network, a relay
 * that has not answered for a while, an update to restart into. Brief reconnects and healthy operation stay quiet.
 */
export function useShellAttention(): 'offline' | 'reconnecting' | 'update' | null {
  const { state } = useConnection();
  const long = useLongReconnect();
  const { updateAvailable } = useApp();
  if (state === 'off') return 'offline';
  if (state === 'wait' && long) return 'reconnecting';
  if (updateAvailable) return 'update';
  return null;
}

/** "Update available · Restart": a row in the sidebar's footer. Explains itself when the restart has to wait. */
export function UpdateAffordance() {
  const { updateAvailable } = useApp();
  const [state, setState] = useState<'idle' | 'busy' | 'refused'>('idle');
  useEffect(() => {
    if (state !== 'refused') return;
    const t = setTimeout(() => setState('idle'), 8_000);
    return () => clearTimeout(t);
  }, [state]);
  if (!updateAvailable) return null;
  const restart = async () => {
    setState('busy');
    const ok = await app.applyUpdate().catch(() => false);
    if (!ok) {
      setState('refused');
      announce('The update is waiting until your work is saved.');
    }
  };
  return (
    <div className="update">
      <button
        type="button"
        className="update-btn"
        onClick={() => void restart()}
        disabled={state === 'busy'}
        aria-describedby={state === 'refused' ? 'update-note' : undefined}
      >
        <RefreshIcon size={16} />
        <span className="update-long">Update available</span>
        <span className="sr-only">, </span>
        <span className="update-act">{state === 'busy' ? 'Restarting…' : 'Restart'}</span>
      </button>
      {state === 'refused' && (
        <p className="update-note" id="update-note" role="status">
          Not yet: something is still being saved (a dictation, a draft or an answer). Try again in
          a moment.
        </p>
      )}
    </div>
  );
}

/** The iOS install nudge: one small card, dismissed for good. */
export function InstallNudge() {
  return (
    <div className="nudge" role="note">
      <span>Add Decisions to your Home Screen to get notifications.</span>
      <Link to="/install" className="nudge-link">
        How
      </Link>
      <button
        type="button"
        className="nudge-close"
        aria-label="Dismiss"
        onClick={() => void app.setPrefs({ dismissedInstall: true })}
      >
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
