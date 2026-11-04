import {
  LIMITS,
  SnapshotRefresh,
  isThreadClosedStatus,
  type LedgerEvent,
} from '@daintreehq/decisions-protocol';
import type { QuestionView } from '../domain/model.js';
import type { SnapshotState } from '../domain/snapshot.js';
import type { Verified } from '../domain/verify.js';
import { RelayError } from './relay.js';

export interface SnapshotStoreDeps {
  /** `GET /questions/{id}/snapshot`, signed. */
  fetch: (questionId: string) => Promise<unknown>;
  verify: (raw: unknown, view: QuestionView) => Promise<Verified<SnapshotState>>;
  view: (questionId: string) => QuestionView | undefined;
  /** `POST /questions/{id}/snapshot/refresh`, signed: asks the publishing desktop for a fresh snapshot. */
  refresh?: (questionId: string) => Promise<unknown>;
  /** The phone's clock. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  onError?: (questionId: string, reason: string) => void;
}

/** At most this many snapshot reads at once, so a backfill never crowds out answers and events. */
const CONCURRENCY = 3;
/** The relay keeps a snapshot this long after receiving it, so older hints cannot name one worth reading. */
const RETENTION_MS = LIMITS.snapshotRetentionMs;

const HINTS = new Set(['decision.snapshot.updated', 'decision.snapshot.refresh_requested']);
/** The relay clears a question's snapshot when it closes, reopens or is deleted. */
const CLEARS = new Set([
  'decision.expired',
  'decision.cancelled',
  'decision.reopened',
  'decision.deleted',
]);

/**
 * The latest pane snapshot of each question, read from the relay (docs/protocol.md section 18). Ledger events
 * about snapshots are content-free hints, so each one is answered by reading the question's current snapshot;
 * several hints for one question while a read is in flight cost one more read, never one each. Nothing here is
 * stored on the device: snapshots are latest-only and short-lived, and they are read again when the app starts.
 *
 * Listeners hear about a change only when what a row shows could change (the state, sharing, or whether the
 * observation is still fresh), not on every new screen of terminal text, so a busy agent never re-renders lists.
 */
export class SnapshotStore {
  private states = new Map<string, SnapshotState>();
  /** The latest hint seen per question, relay time (ms). */
  private hints = new Map<string, number>();
  private inflight = new Set<string>();
  private again = new Set<string>();
  private queue: string[] = [];
  private listeners = new Set<() => void>();
  private version = 0;
  private boundary: unknown = null;
  private stopped = false;
  /** Relay time minus the phone's clock, measured from the socket's `hello`. */
  private offsetMs = 0;

  constructor(private readonly d: SnapshotStoreDeps) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = (): number => this.version;

  get(questionId: string): SnapshotState | undefined {
    return this.states.get(questionId);
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }
  /** The phone's clock corrected to relay time: the only clock freshness is measured on. */
  relayNow(): number {
    return this.now() + this.offsetMs;
  }
  setServerTime(iso: string): void {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) {
      this.offsetMs = t - this.now();
      this.schedule();
    }
  }

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
    this.emitDetail();
  }

  /*
   * The terminal drawer shows everything in a snapshot (its title and lines too), so it listens to every change:
   * each new snapshot, each refresh asked for or refused, each freshness boundary. Only an open chat subscribes.
   */
  private detail = new Set<() => void>();
  private detailVersion = 0;
  /** Each question's latest refresh request: its number (so each outcome is told once) and, once done, how it went. */
  private attempts = new Map<string, { n: number; outcome?: RefreshOutcome }>();
  subscribeDetail = (l: () => void): (() => void) => {
    this.detail.add(l);
    return () => this.detail.delete(l);
  };
  getDetailVersion = (): number => this.detailVersion;
  private emitDetail() {
    this.detailVersion++;
    for (const l of this.detail) l();
  }
  /** Why the latest refresh request did not go through, until the next one does. */
  refreshRefusal(questionId: string): RefreshOutcome | undefined {
    const o = this.attempts.get(questionId)?.outcome;
    return o && o !== 'asked' ? o : undefined;
  }
  /** The latest refresh request: `n` counts them, `outcome` is set when it has finished. */
  lastAttempt(questionId: string): { n: number; outcome?: RefreshOutcome } | undefined {
    return this.attempts.get(questionId);
  }
  /** Refresh requests on their way to the relay, so the drawer says it is asking from the tap, not the reply. */
  private requesting = new Set<string>();
  isRequesting(questionId: string): boolean {
    return this.requesting.has(questionId);
  }

  /**
   * Asks the question's publishing desktop for a fresh snapshot (the relay coalesces requests from every phone).
   * The outstanding request's deadline joins the question's state, so a desktop that never answers (asleep, offline)
   * turns the last snapshot stale when it passes; the snapshot that answers arrives as an ordinary hint.
   */
  async requestRefresh(questionId: string): Promise<RefreshOutcome> {
    if (this.stopped || !this.d.refresh) return 'failed';
    if (this.requesting.has(questionId)) return 'asked';
    this.requesting.add(questionId);
    const n = (this.attempts.get(questionId)?.n ?? 0) + 1;
    this.attempts.set(questionId, { n });
    this.emitDetail();
    let raw: unknown;
    try {
      raw = await this.d.refresh(questionId);
    } catch (e) {
      this.requesting.delete(questionId);
      const outcome: RefreshOutcome = !(e instanceof RelayError)
        ? 'failed'
        : e.status === 0
          ? 'offline'
          : e.status === 429
            ? 'limited'
            : e.status === 409
              ? 'unavailable'
              : 'failed';
      if (this.stopped) return outcome;
      this.attempts.set(questionId, { n, outcome });
      this.emitDetail();
      return outcome;
    }
    this.requesting.delete(questionId);
    if (this.stopped) return 'failed';
    const r = SnapshotRefresh.safeParse(raw);
    this.attempts.set(questionId, { n, outcome: r.success ? 'asked' : 'failed' });
    if (!r.success) {
      this.emitDetail();
      return 'failed';
    }
    const cur = this.states.get(questionId);
    // A snapshot that already answered this request (it can arrive before the response) is not made stale by it.
    const answered =
      !!cur?.observation &&
      Date.parse(cur.observation.receivedAt) >= Date.parse(r.data.requested_at);
    if (!answered)
      this.replace(questionId, {
        observation: cur?.observation ?? null,
        refreshDeadline: r.data.deadline_at,
      });
    else this.emitDetail();
    return 'asked';
  }

  /** What a row shows from a state; a change in this key is what listeners hear about. */
  private shown(s: SnapshotState | undefined): string {
    const o = s?.observation;
    if (!o) return 'none';
    if (o.sharing === 'off') return 'off';
    return `${o.agentState}:${this.isFresh(s!) ? 'fresh' : 'stale'}`;
  }
  private isFresh(s: SnapshotState): boolean {
    if (s.missedRefresh) return false;
    const now = this.relayNow();
    if (s.refreshDeadline && now >= Date.parse(s.refreshDeadline)) return false;
    return !!s.observation && now - Date.parse(s.observation.receivedAt) <= LIMITS.snapshotFreshMs;
  }

  /**
   * Notes snapshot hints and closing events. `live` events (from sync) are acted on at once; events replayed
   * from this device's cache at start only record which questions had a snapshot recently (see `backfill`).
   */
  noteEvents(events: readonly LedgerEvent[], live: boolean): void {
    let changed = false;
    for (const ev of events) {
      const id = ev.question_id;
      if (!id) continue;
      if (HINTS.has(ev.event_type)) {
        const at = Date.parse(ev.occurred_at);
        this.hints.set(id, Math.max(this.hints.get(id) ?? 0, Number.isFinite(at) ? at : 0));
        if (live) this.request(id);
      } else if (CLEARS.has(ev.event_type) && this.states.delete(id)) {
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /**
   * Reads the snapshots worth reading after a start: every open or answered question with a hint the relay may
   * still hold, or, the first time this device declares the feature (`everything`), every open or answered
   * question it holds, since its cursor may already be past hints it was never sent.
   */
  backfill(views: readonly QuestionView[], everything: boolean): void {
    const cutoff = this.relayNow() - RETENTION_MS;
    const open = views.filter((v) => !isThreadClosedStatus(v.status));
    const picked = everything
      ? [...open].sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt)).slice(0, 50)
      : open.filter((v) => (this.hints.get(v.id) ?? 0) >= cutoff);
    for (const v of picked) this.request(v.id);
  }

  /** Reads the question's snapshot soon; a read already in flight is followed by one more. */
  request(questionId: string): void {
    if (this.stopped) return;
    if (this.inflight.has(questionId)) {
      this.again.add(questionId);
      return;
    }
    if (!this.queue.includes(questionId)) this.queue.push(questionId);
    this.pump();
  }

  private pump() {
    while (!this.stopped && this.inflight.size < CONCURRENCY && this.queue.length) {
      const id = this.queue.shift()!;
      this.inflight.add(id);
      void this.read(id).finally(() => {
        this.inflight.delete(id);
        if (this.again.delete(id)) this.request(id);
        this.pump();
      });
    }
  }

  private async read(id: string): Promise<void> {
    const view = this.d.view(id);
    if (!view || !view.verification.ok || isThreadClosedStatus(view.status)) {
      this.replace(id, undefined);
      return;
    }
    let raw: unknown;
    try {
      raw = await this.d.fetch(id);
    } catch (e) {
      // Gone, closed or not served: nothing to show. Anything else keeps what is shown until the next hint.
      if (e instanceof RelayError && [404, 409, 410].includes(e.status))
        this.replace(id, undefined);
      return;
    }
    if (this.stopped) return;
    const current = this.d.view(id) ?? view;
    const r = await this.d.verify(raw, current);
    if (this.stopped) return;
    if (!r.ok) {
      // An unverifiable snapshot is never shown, and it replaces nothing it could be mistaken for.
      this.d.onError?.(id, r.reason);
      this.replace(id, undefined);
      return;
    }
    this.replace(id, r.value);
  }

  private replace(id: string, next: SnapshotState | undefined) {
    const prev = this.states.get(id);
    const before = this.shown(prev);
    // The same observation keeps having missed a refresh: a new request's deadline does not make it current again.
    if (next && prev?.observation && next.observation?.snapshotId === prev.observation.snapshotId) {
      const missed =
        prev.missedRefresh ||
        (!!prev.refreshDeadline && this.relayNow() >= Date.parse(prev.refreshDeadline));
      if (missed && !next.missedRefresh) next = { ...next, missedRefresh: true };
    }
    if (next) this.states.set(id, next);
    else this.states.delete(id);
    this.schedule();
    if (this.shown(next) !== before) this.emit();
    else this.emitDetail();
  }

  /** Wakes at the next moment a shown observation turns stale, so rows step down without a new event. */
  private schedule() {
    (this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.boundary);
    this.boundary = null;
    if (this.stopped) return;
    const now = this.relayNow();
    let next = Infinity;
    for (const s of this.states.values()) {
      const o = s.observation;
      if (!o || o.sharing === 'off') continue;
      const staleAt = Date.parse(o.receivedAt) + LIMITS.snapshotFreshMs + 1;
      if (staleAt > now) next = Math.min(next, staleAt);
      const deadline = s.refreshDeadline ? Date.parse(s.refreshDeadline) : Infinity;
      if (deadline > now) next = Math.min(next, deadline);
    }
    if (next === Infinity) return;
    this.boundary = (this.d.setTimer ?? ((f, ms) => setTimeout(f, ms)))(
      () => {
        this.boundary = null;
        this.emit();
        this.schedule();
      },
      Math.max(0, next - now) + 50,
    );
  }

  /** Forgets everything (unpair, revocation): nothing read stays in memory, and late reads are dropped. */
  clear(): void {
    this.stopped = true;
    (this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.boundary);
    this.boundary = null;
    this.states.clear();
    this.hints.clear();
    this.queue = [];
    this.again.clear();
    this.attempts.clear();
    this.requesting.clear();
    this.emit();
  }
}

/**
 * How a refresh request went: `asked` (the desktop has until the deadline), `unavailable` (the relay refused it:
 * sharing is off, or the desktop does not take requests), `offline`, `limited` (asked too often), or `failed`.
 */
export type RefreshOutcome = 'asked' | 'unavailable' | 'offline' | 'limited' | 'failed';
