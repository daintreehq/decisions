import {
  InvolvementRecord,
  InvolvementResponse,
  canonicalize,
  effectiveInvolvement,
  type InvolvementMode,
} from '@daintreehq/decisions-protocol';
import type { BridgeContext } from './context.js';
import { RelayError } from './errors.js';
import { revokedKey, type EventVerifier } from './inbound.js';
import { TransientError } from './mutex.js';
import type { SocketState } from './socket.js';

/*
 * The person's involvement preference (docs/protocol.md section 20), as this desktop last verified it. The relay
 * holds the latest signed record; this keeps a verified copy, refreshes it at start, on every reconnect and on
 * each `involvement.updated` hint, and answers reads from the copy alone, so reading it never touches the
 * network or creates anything. Expiry of a temporary mode is worked out on every read.
 */

/** The store meta key of the verified copy. */
export const INVOLVEMENT_META = 'involvement:v1';

/** A relay request for the preference that has not answered by then is retried later. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Least time between two retries of a failed refresh (the pump asks every 30 s by default). */
const RETRY_MS = 15_000;

interface Stored {
  /** The latest verified record; null when the relay holds none, or the last one's signer was revoked. */
  record: InvolvementRecord | null;
  /** The highest revision ever verified: a record below it is a rollback and is refused. */
  high_water: number;
  /** When the relay last confirmed `record` (epoch ms), or null if it never has. */
  synced_at: number | null;
  /** The relay's answer: it serves no preference (`involvement-v1`), or the latest record's signer is revoked. */
  status?: 'unsupported' | 'signer-revoked';
}

/**
 * Why no preference is available. Agents fall back to their normal configured behaviour for every one:
 * - `not-synced`: this desktop has never heard from the relay about it;
 * - `not-set`: nobody has set one;
 * - `unsupported`: the relay does not serve involvement preferences;
 * - `signer-revoked`: the device that set the latest one has been removed;
 * - `device-revoked`: this desktop has been removed from the relay.
 */
export type InvolvementUnavailableReason =
  'not-synced' | 'not-set' | 'unsupported' | 'signer-revoked' | 'device-revoked';

export type InvolvementView =
  | {
      status: 'available';
      /** The mode in force now: a temporary one until it ends, then the normal one. */
      mode: InvolvementMode;
      normalMode: InvolvementMode;
      /** Other agents to consult before a recommendation, the asking agent excluded. */
      consultCount: number;
      /** Unchanged when a temporary mode ends: compare `mode` and `until` too, not only this. */
      revision: number;
      overrideActive: boolean;
      /** When the temporary mode in force ends; null when none is. */
      until: string | null;
      /** When the person set it, by the signing device's clock. */
      setAt: string;
      /** When this desktop last confirmed it with the relay. */
      lastSyncedAt: string | null;
      /** True when it may be out of date: not confirmed since the last reconnect, hint or failed read. */
      stale: boolean;
    }
  | {
      status: 'unavailable';
      reason: InvolvementUnavailableReason;
      lastSyncedAt: string | null;
      stale: boolean;
    };

/** Coalesced, generation-guarded reads of the relay's preference into a verified local copy. */
export class InvolvementSync {
  private generation = 0;
  private running = false;
  private inflight: Promise<void> | null = null;
  private again = false;
  /** Confirmed with the relay since the last reconnect, hint or failure. In memory only: a restart is stale. */
  private fresh = false;
  private failedAt: number | null = null;

  constructor(
    private readonly ctx: BridgeContext,
    private readonly verifier: EventVerifier,
    private readonly onError: (e: Error) => void,
  ) {}

  start(): void {
    this.generation++;
    this.running = true;
    this.fresh = false;
    this.kick();
  }

  /** Stops the reads: a request still in flight finishes without writing anything. */
  stop(): void {
    this.generation++;
    this.running = false;
    this.fresh = false;
    this.again = false;
  }

  /** The socket moved: a dropped connection may have missed a hint, and a live one reads again. */
  socketState(s: SocketState): void {
    if (s === 'live') {
      if (!this.fresh) this.kick();
    } else if (s !== 'syncing') this.fresh = false;
  }

  /** An `involvement.updated` hint. It is the relay's word only, so it just says to read again. */
  hint(): void {
    this.fresh = false;
    this.kick();
  }

  /** The pump's chance to retry a read that failed, at most every `RETRY_MS`. */
  retryIfDue(): void {
    if (this.failedAt !== null && this.ctx.now() - this.failedAt >= RETRY_MS) this.kick();
  }

  private kick(): void {
    void this.refresh().catch((e) => this.onError(e as Error));
  }

  /** Read the relay's preference now. Concurrent calls share one read, and a call during a read adds one more. */
  refresh(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    const run = async () => {
      try {
        do {
          this.again = false;
          await this.readOnce(this.generation);
        } while (this.again && this.running);
      } finally {
        this.inflight = null;
      }
    };
    this.inflight = run();
    return this.inflight;
  }

  private async stored(): Promise<Stored> {
    const raw = await this.ctx.store.getMeta(INVOLVEMENT_META);
    let s: Partial<Stored> = {};
    try {
      if (raw) s = JSON.parse(raw) as Partial<Stored>;
    } catch {
      /* unreadable: start over */
    }
    // A copy that no longer parses is dropped, but its revision still bars older records.
    const parsed = s.record ? InvolvementRecord.safeParse(s.record) : null;
    const hw = s.high_water;
    return {
      record: parsed?.success ? parsed.data : null,
      high_water: typeof hw === 'number' && Number.isSafeInteger(hw) && hw > 0 ? hw : 0,
      synced_at: typeof s.synced_at === 'number' ? s.synced_at : null,
      ...(s.status === 'unsupported' || s.status === 'signer-revoked' ? { status: s.status } : {}),
    };
  }

  private async readOnce(gen: number): Promise<void> {
    const live = () => this.running && gen === this.generation;
    const failed = async (result: string) => {
      if (!live()) return;
      this.fresh = false;
      this.failedAt = this.ctx.now();
      await this.ctx.audit.log({ event: 'involvement.refused', result });
    };
    let body: InvolvementResponse;
    try {
      const raw = await this.ctx.client.involvement(REQUEST_TIMEOUT_MS);
      const parsed = InvolvementResponse.safeParse(raw);
      if (!parsed.success) return failed('malformed');
      body = parsed.data;
    } catch (e) {
      if (!live()) return;
      if (e instanceof RelayError && e.status === 404) {
        // A relay from before involvement preferences: nothing to read until it is upgraded.
        const prev = await this.stored();
        if (!live()) return;
        await this.save({
          ...prev,
          record: null,
          synced_at: this.ctx.now(),
          status: 'unsupported',
        });
        return this.succeeded();
      }
      this.fresh = false;
      this.failedAt = this.ctx.now();
      if (e instanceof RelayError) return; // unreachable or refusing for now: the pump retries
      throw e;
    }
    if (!live()) return;
    const prev = await this.stored();
    const r = body.preference;
    if (!r) {
      // Nobody has set one, or a relay withholding the one we verified: the second is refused.
      if (prev.high_water > 0) return failed('withheld');
      await this.save({ record: null, high_water: 0, synced_at: this.ctx.now() });
      return this.succeeded();
    }
    if (r.revision < prev.high_water) return failed('rollback');
    if (r.revision === prev.high_water && prev.record) {
      if (canonicalize(r) !== canonicalize(prev.record)) return failed('equivocation');
      await this.save({ ...prev, synced_at: this.ctx.now() });
      return this.succeeded();
    }
    let v: Awaited<ReturnType<EventVerifier['verifyInvolvement']>>;
    try {
      v = await this.verifier.verifyInvolvement(r);
    } catch (e) {
      if (e instanceof TransientError) return failed('directory-unavailable');
      throw e;
    }
    if (!live()) return;
    if (!v.ok) {
      if (v.reason !== 'signer-revoked') return failed(v.reason);
      // Authentic but from a removed device: it still supersedes everything older, and steers nothing.
      await this.save({
        record: null,
        high_water: Math.max(prev.high_water, r.revision),
        synced_at: this.ctx.now(),
        status: 'signer-revoked',
      });
      await this.ctx.audit.log({ event: 'involvement.refused', result: 'signer-revoked' });
      return this.succeeded();
    }
    await this.save({ record: r, high_water: r.revision, synced_at: this.ctx.now() });
    await this.ctx.audit.log({ event: 'involvement.updated', result: `revision-${r.revision}` });
    this.succeeded();
  }

  private async save(s: Stored): Promise<void> {
    await this.ctx.store.setMeta(INVOLVEMENT_META, JSON.stringify(s));
  }

  private succeeded(): void {
    this.failedAt = null;
    this.fresh = true;
  }

  /** The preference in force now, from the verified copy only. */
  async view(): Promise<InvolvementView> {
    const s = await this.stored();
    const lastSyncedAt = s.synced_at !== null ? new Date(s.synced_at).toISOString() : null;
    const stale = !this.fresh;
    const none = (reason: InvolvementUnavailableReason): InvolvementView => ({
      status: 'unavailable',
      reason,
      lastSyncedAt,
      stale,
    });
    if (s.status === 'unsupported') return none('unsupported');
    if (s.status === 'signer-revoked') return none('signer-revoked');
    if (!s.record) return none(s.synced_at === null ? 'not-synced' : 'not-set');
    // A removal seen in the ledger applies at once, before the next read.
    if ((await this.ctx.store.getMeta(revokedKey(s.record.signer_device_id))) !== null)
      return none('signer-revoked');
    const e = effectiveInvolvement(s.record, this.ctx.now());
    return {
      status: 'available',
      mode: e.mode,
      normalMode: e.normal_mode,
      consultCount: e.consult_count,
      revision: e.revision,
      overrideActive: e.override_active,
      until: e.until,
      setAt: s.record.created_at,
      lastSyncedAt,
      stale,
    };
  }
}
