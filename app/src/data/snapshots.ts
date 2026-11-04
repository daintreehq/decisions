import { LIMITS, isThreadClosedStatus, type LedgerEvent } from '@daintreehq/decisions-protocol';
import type { QuestionView } from '../domain/model.js';
import type { SnapshotState } from '../domain/snapshot.js';
import type { Verified } from '../domain/verify.js';
import { RelayError } from './relay.js';

export interface SnapshotStoreDeps {
  /** `GET /questions/{id}/snapshot`, signed. */
  fetch: (questionId: string) => Promise<unknown>;
  verify: (raw: unknown, view: QuestionView) => Promise<Verified<SnapshotState>>;
  view: (questionId: string) => QuestionView | undefined;
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
  }

  /** What a row shows from a state; a change in this key is what listeners hear about. */
  private shown(s: SnapshotState | undefined): string {
    const o = s?.observation;
    if (!o) return 'none';
    if (o.sharing === 'off') return 'off';
    return `${o.agentState}:${this.isFresh(s!) ? 'fresh' : 'stale'}`;
  }
  private isFresh(s: SnapshotState): boolean {
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
    const before = this.shown(this.states.get(id));
    if (next) this.states.set(id, next);
    else this.states.delete(id);
    this.schedule();
    if (this.shown(next) !== before) this.emit();
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
    this.emit();
  }
}
