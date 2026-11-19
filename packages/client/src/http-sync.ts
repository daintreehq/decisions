import { ERROR_STATUS } from '@daintreehq/decisions-protocol';
import { RelayError, isDeviceRevoked } from './errors.js';
import type { LocalStore } from './store.js';

/**
 * Continuous HTTP polling for a bridge without a live socket (`start({ socket: false, poll })`). Each pass is one
 * `sync()`: it waits `intervalMs` after a success, and after a failure it backs off with equal jitter, from
 * `retryBaseMs` doubling up to `retryCapMs`, never sooner than a `Retry-After` the relay sent.
 */
export interface HttpPollOptions {
  /** Wait after a successful sync before the next one. Default 15 s. */
  intervalMs?: number;
  /** Backoff after the first failure in a row; it doubles with each further one. Default 2 s. */
  retryBaseMs?: number;
  /** The longest backoff. Default 60 s. */
  retryCapMs?: number;
  /** Deadline of each request a sync makes. Default 10 s. */
  requestTimeoutMs?: number;
  /** Jitter source, in [0, 1). Default `Math.random`. */
  rand?: () => number;
}

export type ResolvedPoll = Required<HttpPollOptions>;

export const DEFAULT_POLL: ResolvedPoll = {
  intervalMs: 15_000,
  retryBaseMs: 2_000,
  retryCapMs: 60_000,
  requestTimeoutMs: 10_000,
  rand: Math.random,
};

export function resolvePoll(o: HttpPollOptions | true): ResolvedPoll {
  return { ...DEFAULT_POLL, ...(o === true ? {} : o) };
}

/**
 * A relay that refuses this device's signature for another reason than revocation (a bad signature, a clock it cannot
 * correct, an installation it does not know) is asked again only this often: every refusal counts against the relay's
 * per-address budget of failed authentications, which the person's other devices behind the same address share.
 */
export const AUTH_RETRY_MS = 5 * 60_000;
/** The longest `Retry-After` a sync honours. */
const MAX_RETRY_AFTER_MS = 15 * 60_000;
/**
 * How often a polling bridge declares its features again. The relay keeps a device's latest declaration, and another
 * process of the same device (an older `decisions`) may have replaced it with fewer.
 */
export const DECLARE_EVERY_MS = 5 * 60_000;

/**
 * The outcome of the last HTTP sync, kept in the local store's metadata (`HTTP_SYNC_META_KEY`) so another process
 * (`decisions status`) can read it. It carries timestamps, a cursor and a relay error code: never question content.
 */
export interface HttpSyncStatus {
  v: 1;
  /**
   * `degraded`: the sync failed and polling goes on. `fatal`: it failed in a way no retry can fix (the relay needs a
   * newer client), so polling stopped. `stopped` is only ever returned, by a sync the bridge's stop cut short; it is
   * never recorded.
   */
  outcome: 'ok' | 'degraded' | 'fatal' | 'revoked' | 'stopped';
  /** When a sync last read the whole ledger after the stored cursor (ms since the epoch). */
  last_success_at: number | null;
  /** The cursor that sync reached. */
  last_success_cursor: number | null;
  /** When this sync started. */
  last_attempt_at: number | null;
  /** Failed syncs in a row since the last success, in this process. */
  failures: number;
  /** Why the sync failed: a protocol error code, `network_error`, `unknown_error`, `invalid_page`, `device_revoked` or `sync_failed`. */
  reason: string | null;
  /** When a continuously polling bridge syncs next; null when nothing is scheduled. */
  next_attempt_at: number | null;
}

export const HTTP_SYNC_META_KEY = 'http_sync';

export const NEVER_SYNCED: HttpSyncStatus = {
  v: 1,
  outcome: 'degraded',
  last_success_at: null,
  last_success_cursor: null,
  last_attempt_at: null,
  failures: 0,
  reason: null,
  next_attempt_at: null,
};

/** The last recorded HTTP sync, or null when this store has none (it never synced over HTTP, or predates it). */
export async function readHttpSyncStatus(store: LocalStore): Promise<HttpSyncStatus | null> {
  const raw = await store.getMeta(HTTP_SYNC_META_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as HttpSyncStatus;
    return v && v.v === 1 ? v : null;
  } catch {
    return null;
  }
}

/** A failure no retry can fix: the relay refuses this client's protocol version (`426 upgrade_required`). */
export function isFatalSyncError(e: unknown): boolean {
  return e instanceof RelayError && e.code === 'upgrade_required' && e.status === 426;
}

/**
 * A content-free reason for a failed sync. The code a relay sends is free text on the wire, so only the protocol's
 * own codes are kept; anything else is `unknown_error`.
 */
export function syncFailureReason(e: unknown): string {
  if (isDeviceRevoked(e)) return 'device_revoked';
  if (e instanceof RelayError) {
    if (e.code === 'network_error' || Object.prototype.hasOwnProperty.call(ERROR_STATUS, e.code))
      return e.code;
    return 'unknown_error';
  }
  // A page that does not parse (`EventsPage`) or does not advance the cursor.
  if (e instanceof Error && (e.name === 'ZodError' || /does not advance/.test(e.message)))
    return 'invalid_page';
  return 'sync_failed';
}

/** How long a polling bridge waits after its `failures`-th failed sync in a row, which ended in `e`. */
export function retryDelayMs(failures: number, o: ResolvedPoll, e: unknown): number {
  if (e instanceof RelayError && e.code === 'not_authenticated') return AUTH_RETRY_MS;
  const ceiling = Math.min(o.retryCapMs, o.retryBaseMs * 2 ** Math.max(0, failures - 1));
  const jittered = Math.floor(ceiling / 2 + o.rand() * (ceiling / 2));
  const hint = e instanceof RelayError ? e.retryAfterMs : undefined;
  // The hint is the relay's word: a value that is not a positive number is ignored.
  const asked =
    typeof hint === 'number' && Number.isFinite(hint) && hint > 0
      ? Math.min(hint, MAX_RETRY_AFTER_MS)
      : 0;
  return Math.max(jittered, asked);
}
