import { InfoResponse, LIMITS, knownFeatures } from '@daintreehq/decisions-protocol';
import type { BridgeContext } from './context.js';
import { RelayError } from './errors.js';
import { backoffMs } from './relay.js';

/*
 * Presence (docs/protocol.md section 11, `presence-v1`): the host app on the owner desktop says whether the person
 * is at the computer, and this keeps the relay's lease current while they are, so the relay holds a new question's
 * phone push briefly. A report that the person is present counts for `PRESENCE_REPORT_MS`: the host reports again
 * while they stay, and the lease lapses on its own when the host says they are away, stops reporting, or the bridge
 * stops. Nothing here is stored, and a report carries the flag alone: nothing about questions, panes or content.
 */

export const PRESENCE_FEATURE = 'presence-v1' as const;

/**
 * How long one report that the person is present counts. The host reports again well inside it (every 30 s, and at
 * once whenever the person comes back); once it passes without one, the lease is no longer renewed and lapses.
 */
export const PRESENCE_REPORT_MS = 120_000;

/** Renew the relay's lease this often while the person is present: three tries inside one lease. */
const RENEW_MS = LIMITS.presenceLeaseMs / 3;
/** A presence request (or the feature check) that has not answered by then is retried. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long the relay's answer about `presence-v1`, either way, is believed before `GET /info` is asked again. */
const RECHECK_MS = 10 * 60_000;
/** Backoff for a failed renewal: never sooner than this, never later than one renewal period. */
const RETRY_MIN_MS = 1_000;

/** Keeps the relay's presence lease current while the host's latest report says the person is present. */
export class PresenceReporter {
  private running = false;
  /** Bumped by every start and stop: a request from an earlier run changes nothing when it returns. */
  private generation = 0;
  /** When the host last said the person is present (`ctx.now()`), or null after away, a stop, or never. */
  private presentAt: number | null = null;
  /** The host said the person is away since the last report that they are present. */
  private awayReported = false;
  /** A `true` went to the relay (answered or not) with no `false` after it, so a lease may be current. */
  private leaseMaybe = false;
  /** When the last accepted `true` was sent (`ctx.now()`): the next renewal is due `RENEW_MS` later. */
  private renewedAt: number | null = null;
  /** When a failed renewal may be tried again (`ctx.now()`), or null when none failed. */
  private retryAt: number | null = null;
  private attempts = 0;
  /** Whether the relay advertises `presence-v1`, and when that was learned. */
  private support: { value: boolean; at: number } | null = null;
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The latest `ctx.now()` read, to notice the wall clock stepping back. */
  private seen = -Infinity;
  /** Bumped whenever the wall clock is seen stepping back: a time read before one is never compared with one after. */
  private rollbacks = 0;

  constructor(
    private readonly ctx: BridgeContext,
    private readonly onError: (e: Error) => void,
  ) {}

  /** True while a presence request (or the feature check) is in flight. */
  get busy(): boolean {
    return this.inflight;
  }

  /** The host's latest observation. Before `start()` it is only kept, and starting acts on it if it is still fresh. */
  report(present: boolean): void {
    const now = this.clock();
    if (present) {
      this.presentAt = now;
      this.awayReported = false;
    } else {
      this.presentAt = null;
      this.awayReported = true;
      this.renewedAt = null;
      this.retryAt = null;
      this.attempts = 0;
    }
    this.schedule();
  }

  start(): void {
    this.generation++;
    this.running = true;
    this.schedule();
  }

  /**
   * Stops renewing and drops the host's observations, so the lease lapses within one lease and a restart waits for a
   * new report. Sends nothing: a request already in flight finishes without scheduling anything.
   */
  stop(): void {
    this.generation++;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.presentAt = null;
    this.awayReported = false;
    this.leaseMaybe = false;
    this.renewedAt = null;
    this.retryAt = null;
    this.attempts = 0;
  }

  /**
   * `ctx.now()`, wall-clock time. When the clock stepped back since the last read, nothing measured before can be
   * trusted: the host's report no longer counts (renewal waits for the next one, so a report never counts for longer
   * than `PRESENCE_REPORT_MS`), and the renewal, backoff and feature-check times are forgotten, so the next report
   * asks the relay and renews at once. A step forward (a machine waking from sleep) only makes them come due sooner:
   * a report goes stale, a renewal or retry is due.
   */
  private clock(): number {
    const now = this.ctx.now();
    if (now < this.seen) {
      this.rollbacks++;
      this.presentAt = null;
      this.renewedAt = null;
      this.retryAt = null;
      this.attempts = 0;
      this.support = null;
    }
    this.seen = now;
    return now;
  }

  /** The host's latest report says the person is present, and it is recent enough to act on at `now`. */
  private fresh(now: number): boolean {
    return this.presentAt !== null && now - this.presentAt < PRESENCE_REPORT_MS;
  }

  private knownUnsupported(now: number): boolean {
    const s = this.support;
    return s !== null && !s.value && now - s.at < RECHECK_MS;
  }

  private knownSupported(now: number): boolean {
    const s = this.support;
    return s !== null && s.value && now - s.at < RECHECK_MS;
  }

  /** What to send next and when, or null when nothing is owed. */
  private next(now: number): { present: boolean; at: number } | null {
    if (this.fresh(now)) {
      if (this.knownUnsupported(now)) return null;
      const due = this.renewedAt === null ? now : this.renewedAt + RENEW_MS;
      const at = this.retryAt === null ? due : Math.max(due, this.retryAt);
      // Not renewed past the report's freshness: the lease lapses unless the host reports again.
      return at < this.presentAt! + PRESENCE_REPORT_MS ? { present: true, at } : null;
    }
    // Ended once, when the person is reported away; a lease left by reports that simply stopped lapses alone.
    if (this.awayReported && this.leaseMaybe) return { present: false, at: now };
    return null;
  }

  private schedule(): void {
    if (!this.running || this.inflight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.clock();
    const next = this.next(now);
    if (!next) return;
    if (next.at <= now) {
      void this.send(next.present);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, next.at - now);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async send(present: boolean): Promise<void> {
    this.inflight = true;
    try {
      await (present ? this.renew(this.generation) : this.end());
    } catch (e) {
      this.onError(e as Error);
    } finally {
      this.inflight = false;
      this.schedule();
    }
  }

  /** Tell the relay the person is away, once: a lost or refused reply leaves the lease to lapse. */
  private async end(): Promise<void> {
    this.leaseMaybe = false;
    this.awayReported = false;
    // Sent only after a `true`, so the relay already showed it serves presence.
    await this.ctx.client.putPresence(false, REQUEST_TIMEOUT_MS).catch(() => undefined);
  }

  private async renew(gen: number): Promise<void> {
    const live = () => this.running && gen === this.generation;
    /** Still running and not told away since this renewal began: what it learned still applies. */
    const current = () => live() && this.presentAt !== null;
    let supported: boolean;
    try {
      supported = await this.supported();
    } catch {
      if (current()) this.retryLater(null);
      return;
    }
    // Stopped, told away, or the report went stale while the relay was asked: send nothing.
    if (!supported || !live() || !this.fresh(this.clock())) return;
    const sentAt = this.clock();
    const rollbacks = this.rollbacks;
    const hadLease = this.leaseMaybe;
    this.leaseMaybe = true;
    try {
      await this.ctx.client.putPresence(true, REQUEST_TIMEOUT_MS);
    } catch (e) {
      if (!live()) return;
      const err =
        e instanceof RelayError ? e : new RelayError('network_error', (e as Error).message, 0);
      // Unanswered: the lease may have started, so an away reported meanwhile still ends it.
      if (err.retryable) {
        if (current()) this.retryLater(err);
        return;
      }
      // Refused, so this request started no lease, though an earlier one may still be current and is ended on away. A
      // 404 is a relay that lists the feature without the route: nothing there to end.
      this.leaseMaybe = err.status === 404 ? false : hadLease;
      this.support = { value: false, at: this.clock() };
      if (err.status !== 404) this.onError(err);
      return;
    }
    // An away reported meanwhile is sent next, and a later return to present must not wait on this renewal. Nor must
    // a send time from before the clock stepped back: the next report renews at once instead.
    this.clock();
    if (!current() || rollbacks !== this.rollbacks) return;
    this.renewedAt = sentAt;
    this.retryAt = null;
    this.attempts = 0;
  }

  private retryLater(err: RelayError | null): void {
    this.attempts++;
    const wait = Math.max(
      err?.retryAfterMs ?? 0,
      RETRY_MIN_MS,
      backoffMs(this.attempts, RETRY_MIN_MS, RENEW_MS),
    );
    this.retryAt = this.clock() + wait;
  }

  /**
   * Whether the relay advertises `presence-v1` in `GET /info`. A relay without it is never sent presence. The answer
   * is believed for `RECHECK_MS` either way, then asked again only if the host is still reporting, so an upgraded
   * relay is picked up and one that stopped listing the feature is no longer sent it. A relay whose `/info` does not
   * parse, or answers with a client error, advertises nothing; a network failure or 5xx throws, so the caller retries.
   */
  private async supported(): Promise<boolean> {
    const now = this.clock();
    if (this.knownSupported(now)) return true;
    if (this.knownUnsupported(now)) return false;
    let value: boolean;
    try {
      const info = InfoResponse.safeParse(await this.ctx.client.info(REQUEST_TIMEOUT_MS));
      value = info.success && knownFeatures(info.data.features).has(PRESENCE_FEATURE);
    } catch (e) {
      if (!(e instanceof RelayError) || e.retryable) throw e;
      value = false;
    }
    this.support = { value, at: this.clock() };
    // A relay that no longer lists the feature is not sent an away either; a lease it holds lapses.
    if (!value) this.leaseMaybe = false;
    return value;
  }
}
