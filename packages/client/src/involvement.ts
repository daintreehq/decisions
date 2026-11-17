import { z } from 'zod';
import {
  InvolvementConflictDetails,
  InvolvementMode,
  InvolvementReceipt,
  InvolvementRecord,
  InvolvementResponse,
  IsoTime,
  LIMITS,
  canonicalize,
  effectiveInvolvement,
  type ErrorCode,
  type InvolvementSetOn,
} from '@daintreehq/decisions-protocol';
import { buildSignedInvolvement, newId } from '@daintreehq/decisions-crypto';
import type { BridgeContext } from './context.js';
import { BridgeError } from './content.js';
import { RelayError } from './errors.js';
import { revokedKey, type EventVerifier } from './inbound.js';
import { Mutex, TransientError } from './mutex.js';
import type { SocketState } from './socket.js';

/*
 * The person's involvement preference (docs/protocol.md section 20), as this desktop last verified it. The relay
 * holds the latest signed record; this keeps a verified copy, refreshes it at start, on every reconnect and on
 * each `involvement.updated` hint, and answers reads from the copy alone, so reading it never touches the
 * network or creates anything. Expiry of a temporary mode is worked out on every read. On the owner desktop the
 * person can also set it here (`save`), signed with this desktop's key.
 */

/** The store meta key of the verified copy. */
export const INVOLVEMENT_META = 'involvement:v1';

/** A relay request for the preference that has not answered by then is retried later. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Least time between two retries of a failed refresh (the pump asks every 30 s by default). */
const RETRY_MS = 15_000;

interface Stored {
  /**
   * The authentic record at `high_water` (null when the relay holds none). Kept while it cannot be used (`status`),
   * so a later record at the same revision is still compared with it.
   */
  record: InvolvementRecord | null;
  /** The highest revision ever verified: a record below it is a rollback and is refused. */
  high_water: number;
  /** When the relay last confirmed `record` (epoch ms), or null if it never has. */
  synced_at: number | null;
  /** The relay's answer: it serves no preference (`involvement-v1`), or the latest record's signer is revoked. */
  status?: 'unsupported' | 'signer-revoked';
  /**
   * Where `record` was set, from the certificate it was verified with. A copy from before the owner desktop could set
   * it has none, and its record was a phone's or a tablet's: that version verified no other.
   */
  set_on?: InvolvementSetOn;
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

/**
 * What agents read (`get_involvement`). It says the same whichever device set the preference: where it was set is
 * for the person's own display (`InvolvementPreference`), never for agents.
 */
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

/**
 * The whole preference, for the host app's own settings screen (`getInvolvementPreference`): everything the person
 * set and where they set it, from the same verified copy agents read. It touches no network.
 */
export type InvolvementPreference =
  | {
      status: 'available';
      normalMode: InvolvementMode;
      consultCount: number;
      /**
       * The temporary mode and its end as the person set them, or null. Kept after it ends, when `overrideActive` turns
       * false: a form starting from it leaves an ended one out, since the relay refuses saving it again.
       */
      override: { mode: InvolvementMode; until: string } | null;
      /** The mode in force now: the temporary one until it ends, then the normal one. */
      mode: InvolvementMode;
      overrideActive: boolean;
      /** The revision a save replaces: pass it as `expectedRevision`. */
      revision: number;
      /** `computer` when the owner desktop set it, `phone` for a phone or tablet: from the signer's certificate. */
      setOn: InvolvementSetOn;
      /** When the person set it, by the signing device's clock. */
      setAt: string;
      lastSyncedAt: string | null;
      stale: boolean;
    }
  | {
      status: 'unavailable';
      reason: InvolvementUnavailableReason;
      /**
       * The highest revision this desktop verified (0 when none): what a save replaces. The relay may hold a newer
       * one this desktop has not verified, in which case the save comes back as a `conflict` naming it.
       */
      revision: number;
      lastSyncedAt: string | null;
      stale: boolean;
    };

/** `setInvolvementPreference`: what the person chose, and the revision they saw. */
export const SetInvolvementInput = z
  .object({
    /** The revision the person reviewed (`InvolvementPreference.revision`); the save replaces exactly it. */
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    normalMode: InvolvementMode,
    /** Other agents to consult before a recommendation, 1 to `LIMITS.involvementConsultMax`. */
    consultCount: z.number().int().min(1).max(LIMITS.involvementConsultMax),
    /**
     * A temporary mode and when it ends (ISO 8601 UTC with milliseconds), or null. It must end in the future and at
     * most `LIMITS.involvementOverrideMaxMs` (30 days) from now.
     */
    override: z.object({ mode: InvolvementMode, until: IsoTime }).strict().nullable(),
  })
  .strict();
export type SetInvolvementInput = z.infer<typeof SetInvolvementInput>;

/**
 * Where a save stands, for a UI to show:
 * - `saved`: the relay took it, and this desktop's copy and its agents have it now;
 * - `conflict`: the preference changed since the person reviewed it (a phone, a tablet or another save got there
 *   first). Nothing was saved. `latestRevision` is the relay's revision, or null if it did not say; the copy has been
 *   read again, so show `getInvolvementPreference` and let the person review it before saving over it;
 * - `unsupported`: the relay does not take involvement preferences;
 * - `unconfirmed`: the relay could not be reached, or its reply was unreadable, so it may or may not have been saved.
 *   The copy is read again when the relay answers; read it before saving again;
 * - `refused`: any other refusal, with the relay's error code.
 */
export type SetInvolvementResult =
  | { status: 'saved'; revision: number }
  | { status: 'conflict'; latestRevision: number | null }
  | { status: 'unsupported' }
  | { status: 'unconfirmed'; message: string }
  | { status: 'refused'; code: ErrorCode | 'network_error' | 'unknown_error'; message: string };

/** Why a temporary mode cannot be saved at `now`, or null. Mirrors the relay's rule without its clock allowance. */
function overrideIssue(o: SetInvolvementInput['override'], now: number): string | null {
  if (!o) return null;
  const until = Date.parse(o.until);
  if (until <= now) return 'override.until: the temporary mode must end in the future';
  if (until > now + LIMITS.involvementOverrideMaxMs)
    return `override.until: a temporary mode can last at most ${LIMITS.involvementOverrideMaxMs / 86_400_000} days`;
  return null;
}

/** Coalesced, generation-guarded reads of the relay's preference into a verified local copy. */
export class InvolvementSync {
  private generation = 0;
  private running = false;
  private inflight: Promise<void> | null = null;
  private again = false;
  /**
   * Bumped by anything that may leave the copy out of date (a start, a stop, a hint, a dropped socket): only a read
   * that began after the last bump may call the copy fresh.
   */
  private epoch = 0;
  /** Confirmed with the relay since the last bump. In memory only: a restart is stale. */
  private fresh = false;
  private failedAt: number | null = null;
  /**
   * Serializes every change to the copy: a read's verdict and this desktop's own save. A read checks its record
   * against the copy and writes its verdict inside it, so a save is never overwritten by an older read.
   */
  private readonly commit = new Mutex();
  /** Bumped by each save this desktop commits: a read that began before one says nothing about it, and reads again. */
  private saves = 0;

  constructor(
    private readonly ctx: BridgeContext,
    private readonly verifier: EventVerifier,
    private readonly onError: (e: Error) => void,
  ) {}

  start(): void {
    this.generation++;
    this.running = true;
    this.invalidate();
    this.kick();
  }

  /** Stops the reads: a request still in flight finishes without writing anything. */
  stop(): void {
    this.generation++;
    this.running = false;
    this.again = false;
    this.invalidate();
  }

  private invalidate(): void {
    this.epoch++;
    this.fresh = false;
  }

  /** The socket moved: a dropped connection may have missed a hint, and a live one reads again. */
  socketState(s: SocketState): void {
    if (s === 'live') this.kick();
    else if (s !== 'syncing') this.invalidate();
  }

  /** An `involvement.updated` hint. It is the relay's word only, so it just says to read again. */
  hint(): void {
    this.invalidate();
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
      ...(s.set_on === 'computer' || s.set_on === 'phone' ? { set_on: s.set_on } : {}),
    };
  }

  private async readOnce(gen: number): Promise<void> {
    const epoch = this.epoch;
    const saves = this.saves;
    const live = () => this.running && gen === this.generation;
    const failed = async (result: string) => {
      if (!live()) return;
      this.fresh = false;
      this.failedAt = this.ctx.now();
      await this.ctx.audit.log({ event: 'involvement.refused', result });
    };
    /** Keep what this read established; it is fresh only if nothing invalidated the copy since the read began. */
    const settle = async (next: Stored) => {
      if (!live()) return;
      await this.ctx.store.setMeta(INVOLVEMENT_META, JSON.stringify(next));
      if (!live()) return;
      this.failedAt = null;
      if (epoch === this.epoch) this.fresh = true;
    };
    /**
     * Decide inside the commit section. A save committed since this read began may be newer than what the relay
     * answered then: the answer is dropped and read again, rather than refused as a rollback.
     */
    const decide = (fn: () => Promise<void>) =>
      this.commit.run(async () => {
        if (saves !== this.saves) {
          this.again = true;
          return;
        }
        await fn();
      });
    let body: InvolvementResponse;
    try {
      const raw = await this.ctx.client.involvement(REQUEST_TIMEOUT_MS);
      const parsed = InvolvementResponse.safeParse(raw);
      if (!parsed.success) return failed('malformed');
      body = parsed.data;
    } catch (e) {
      if (!live()) return;
      if (e instanceof RelayError && e.status === 404) {
        // A relay from before involvement preferences: nothing to read until it is upgraded. What was verified
        // before is kept, so it still bars older and different records later.
        return decide(async () => {
          const prev = await this.stored();
          return settle({ ...prev, synced_at: this.ctx.now(), status: 'unsupported' });
        });
      }
      this.fresh = false;
      this.failedAt = this.ctx.now();
      if (e instanceof RelayError) return; // unreachable or refusing for now: the pump retries
      throw e;
    }
    if (!live()) return;
    try {
      await decide(() => this.accept(body.preference, settle, failed, live));
    } catch (e) {
      if (e instanceof TransientError) return failed('directory-unavailable');
      // A hostile record can make canonicalising or verifying throw: refused like any other bad record.
      return failed('unverifiable');
    }
  }

  private async accept(
    r: InvolvementRecord | null,
    settle: (s: Stored) => Promise<void>,
    failed: (result: string) => Promise<void>,
    live: () => boolean,
  ): Promise<void> {
    const prev = await this.stored();
    if (!live()) return;
    if (!r) {
      // Nobody has set one, or a relay withholding the one we verified: the second is refused.
      if (prev.high_water > 0) return failed('withheld');
      return settle({ record: null, high_water: 0, synced_at: this.ctx.now() });
    }
    if (r.revision < prev.high_water) return failed('rollback');
    if (
      r.revision === prev.high_water &&
      prev.record &&
      canonicalize(r) !== canonicalize(prev.record)
    )
      return failed('equivocation');
    // Verified on every read, not only when the revision moves: its signer may have been removed since.
    const v = await this.verifier.verifyInvolvement(r);
    if (!live()) return;
    if (!v.ok) {
      if (v.reason !== 'signer-revoked') return failed(v.reason);
      // Authentic but from a removed device: kept to bar older and different records, and steers nothing.
      if (prev.status !== 'signer-revoked' || prev.high_water !== r.revision)
        await this.ctx.audit.log({ event: 'involvement.refused', result: 'signer-revoked' });
      return settle({
        record: r,
        high_water: r.revision,
        synced_at: this.ctx.now(),
        status: 'signer-revoked',
      });
    }
    if (r.revision > prev.high_water)
      await this.ctx.audit.log({ event: 'involvement.updated', result: `revision-${r.revision}` });
    return settle({
      record: r,
      high_water: r.revision,
      synced_at: this.ctx.now(),
      set_on: v.setOn,
    });
  }

  /**
   * Set the person's preference from this owner desktop: sign `input` as the record that replaces
   * `expectedRevision`, and send it once (the client resends the same body and key only while the relay cannot be
   * reached). The caller has checked the role, the bridge state and the input. A record the relay took is this
   * desktop's own, so the copy takes it at once and never goes back below it; a conflict reads the copy again.
   */
  async save(input: SetInvolvementInput): Promise<SetInvolvementResult> {
    const { identity } = this.ctx;
    const record = await buildSignedInvolvement({
      installationId: identity.config.installationId,
      signerDeviceId: identity.config.deviceId,
      signingKey: identity.keys.signing.privateKey,
      revision: input.expectedRevision + 1,
      normalMode: input.normalMode,
      consultCount: input.consultCount,
      override: input.override,
      createdAt: new Date(this.ctx.now()).toISOString(),
    });
    // Signed fields are what the relay checks: a record the protocol would refuse is never sent.
    if (!InvolvementRecord.safeParse(record).success)
      throw new BridgeError('validation_error', 'the preference does not make a valid record');
    let raw: unknown;
    try {
      raw = await this.ctx.client.putInvolvement(newId(), record, {
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (e) {
      if (!(e instanceof RelayError)) throw e;
      if (e.code === 'revision_conflict') {
        const d = InvolvementConflictDetails.safeParse(e.details);
        this.invalidate();
        await this.refresh().catch((err) => this.onError(err as Error));
        return { status: 'conflict', latestRevision: d.success ? d.data.latest_revision : null };
      }
      if (e.status === 404) return { status: 'unsupported' };
      if (e.retryable) {
        this.invalidate();
        this.kick();
        return { status: 'unconfirmed', message: e.message };
      }
      return { status: 'refused', code: e.code, message: e.message };
    }
    const receipt = InvolvementReceipt.safeParse(raw);
    if (!receipt.success || receipt.data.revision !== record.revision) {
      this.invalidate();
      this.kick();
      return {
        status: 'unconfirmed',
        message: 'the relay’s reply did not confirm this preference',
      };
    }
    await this.adopt(record);
    await this.ctx.audit.log({ event: 'involvement.set', result: `revision-${record.revision}` });
    this.kick();
    return { status: 'saved', revision: record.revision };
  }

  /**
   * Take this desktop's own record, which the relay just accepted, as verified: it signed it, so it is authentic and
   * set on the computer. A newer record verified meanwhile is kept, and a read that began before it reads again.
   */
  private adopt(r: InvolvementRecord): Promise<void> {
    return this.commit.run(async () => {
      this.saves++;
      if (!this.running) return;
      const prev = await this.stored();
      if (r.revision <= prev.high_water) return;
      await this.ctx.store.setMeta(
        INVOLVEMENT_META,
        JSON.stringify({
          record: r,
          high_water: r.revision,
          synced_at: this.ctx.now(),
          set_on: 'computer',
        } satisfies Stored),
      );
    });
  }

  /** The preference in force now, from the verified copy only. The same whichever device set it. */
  async view(): Promise<InvolvementView> {
    const p = await this.preference();
    if (p.status === 'unavailable')
      return {
        status: 'unavailable',
        reason: p.reason,
        lastSyncedAt: p.lastSyncedAt,
        stale: p.stale,
      };
    return {
      status: 'available',
      mode: p.mode,
      normalMode: p.normalMode,
      consultCount: p.consultCount,
      revision: p.revision,
      overrideActive: p.overrideActive,
      until: p.overrideActive ? p.override!.until : null,
      setAt: p.setAt,
      lastSyncedAt: p.lastSyncedAt,
      stale: p.stale,
    };
  }

  /** The whole preference and where it was set, from the verified copy only. */
  async preference(): Promise<InvolvementPreference> {
    const s = await this.stored();
    const lastSyncedAt = s.synced_at !== null ? new Date(s.synced_at).toISOString() : null;
    const stale = !this.fresh;
    const none = (reason: InvolvementUnavailableReason): InvolvementPreference => ({
      status: 'unavailable',
      reason,
      revision: s.high_water,
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
      normalMode: e.normal_mode,
      consultCount: e.consult_count,
      override: s.record.override
        ? { mode: s.record.override.mode, until: s.record.override.until }
        : null,
      mode: e.mode,
      overrideActive: e.override_active,
      revision: e.revision,
      setOn: s.set_on ?? 'phone',
      setAt: s.record.created_at,
      lastSyncedAt,
      stale,
    };
  }

  /** Why `input` cannot be saved now, or null. */
  inputIssue(input: SetInvolvementInput): string | null {
    return overrideIssue(input.override, this.ctx.now());
  }
}
