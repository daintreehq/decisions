import type { InvolvementRecord, LedgerEvent } from '@daintreehq/decisions-protocol';
import {
  recordMatches,
  servedRevision,
  type InvolvementDraft,
  type InvolvementState,
} from '../domain/involvement.js';
import type { Verified } from '../domain/verify.js';
import { RelayError } from './relay.js';

export interface InvolvementSnapshot {
  /**
   * - `idle`: never read on this device;
   * - `loading`: the first read is on its way;
   * - `ready`: `record` is what the relay holds, verified (null when nobody has set one);
   * - `invalid`: the relay holds a record this phone could not verify, so nothing from it is shown;
   * - `error`: the relay could not be read and nothing was read before.
   */
  status: 'idle' | 'loading' | 'ready' | 'invalid' | 'error';
  record: InvolvementRecord | null;
  receivedAt: string | null;
  /** The revision the relay holds, verified or not: the next save replaces it. */
  revision: number;
  problem: string | null;
}

export type InvolvementSaveResult =
  /** The relay took it. */
  | { kind: 'saved' }
  /** Another device changed the preference first: `current` is what is set now, and nothing was saved. */
  | { kind: 'conflict' };

export interface InvolvementDeps {
  /** `GET /involvement`. */
  fetch(): Promise<unknown>;
  /** `PUT /involvement` with the signed record. */
  put(record: InvolvementRecord): Promise<unknown>;
  verify(raw: unknown): Promise<Verified<InvolvementState>>;
  /** Signs `draft` as the record replacing `currentRevision`. */
  sign(draft: InvolvementDraft, currentRevision: number): Promise<InvolvementRecord>;
}

const EMPTY: InvolvementSnapshot = {
  status: 'idle',
  record: null,
  receivedAt: null,
  revision: 0,
  problem: null,
};

/**
 * This device's view of the involvement preference: read on demand, read again on a relay hint once it has been
 * read, and written with a compare-and-swap on the revision. A conflict is reported, never overwritten. `clear`
 * forgets everything and drops any read or save still on its way, so nothing lands in a later pairing.
 */
export class InvolvementStore {
  private snap: InvolvementSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private generation = 0;
  private reading: Promise<InvolvementSnapshot> | null = null;
  private again = false;

  constructor(private readonly d: InvolvementDeps) {}

  get(): InvolvementSnapshot {
    return this.snap;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private set(next: InvolvementSnapshot): void {
    this.snap = next;
    for (const l of this.listeners) l();
  }

  /** Whether anything has asked for the preference on this device yet. */
  get wanted(): boolean {
    return this.snap.status !== 'idle';
  }

  /** Reads the preference; a read already on its way is followed by one more, so a hint is never lost. */
  load(): Promise<InvolvementSnapshot> {
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    const gen = this.generation;
    if (this.snap.status === 'idle') this.set({ ...this.snap, status: 'loading' });
    const run = (async (): Promise<InvolvementSnapshot> => {
      try {
        for (;;) {
          this.again = false;
          try {
            await this.readOnce(gen);
          } catch (e) {
            // A read asked for while this one was failing still happens: it may be the one that succeeds.
            if (this.again && gen === this.generation) continue;
            throw e;
          }
          if (!this.again || gen !== this.generation) return this.snap;
        }
      } finally {
        if (gen === this.generation) this.reading = null;
      }
    })();
    this.reading = run;
    return run;
  }

  /**
   * Whether a response about `revision` may replace what is shown: never an older one than a verified record this
   * device already shows (a slow read finishing after a save, or after a newer read). A record it could not verify
   * sets no floor: its revision is only the relay's word.
   */
  private newerThanShown(revision: number): boolean {
    return this.snap.status !== 'ready' || revision >= this.snap.revision;
  }

  /** Shows what one read found, unless something newer is already shown. */
  private adopt(raw: unknown, v: Verified<InvolvementState>): void {
    if (v.ok) {
      const revision = v.value.record?.revision ?? 0;
      if (!this.newerThanShown(revision)) return;
      this.set({
        status: 'ready',
        record: v.value.record,
        receivedAt: v.value.receivedAt,
        revision,
        problem: null,
      });
    } else {
      const revision = servedRevision(raw);
      if (!this.newerThanShown(revision)) return;
      this.set({ status: 'invalid', record: null, receivedAt: null, revision, problem: v.reason });
    }
  }

  private async readOnce(gen: number): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.d.fetch();
    } catch (e) {
      if (gen !== this.generation) return;
      // What was read before stays shown; only a first read that fails is an error.
      if (this.snap.status === 'loading' || this.snap.status === 'error')
        this.set({
          ...EMPTY,
          status: 'error',
          problem: e instanceof Error ? e.message : String(e),
        });
      throw e;
    }
    const v = await this.d.verify(raw);
    if (gen !== this.generation) return;
    this.adopt(raw, v);
  }

  /** Reads again if this device has read it before (a hint, a reconnect, the app coming back). */
  refresh(): void {
    if (this.wanted) void this.load().catch(() => undefined);
  }

  /**
   * The relay's content-free hints: another device saved a new preference. A removed device is read again too, so
   * a preference it signed stops being shown (the question store has marked it revoked by now).
   */
  noteEvents(events: readonly LedgerEvent[]): void {
    if (
      events.some(
        (e) => e.event_type === 'involvement.updated' || e.event_type === 'device.revoked',
      )
    )
      this.refresh();
  }

  /**
   * Signs `draft` as the revision after `baseRevision`, the one the person's edits started from, and sends it. The
   * relay refuses it if anyone saved since (`conflict`): the preference is read again and nothing is re-signed over
   * the other device's choice. Any other failure throws, and the draft is the caller's to keep.
   */
  async save(draft: InvolvementDraft, baseRevision: number): Promise<InvolvementSaveResult> {
    const gen = this.generation;
    const record = await this.d.sign(draft, baseRevision);
    try {
      await this.d.put(record);
    } catch (e) {
      if (gen !== this.generation) throw e;
      if (e instanceof RelayError && e.status === 409 && e.code === 'revision_conflict') {
        // Read what the relay holds now, and judge by this read alone, never by what was shown before.
        let raw: unknown;
        let read: Verified<InvolvementState>;
        try {
          raw = await this.d.fetch();
          read = await this.d.verify(raw);
        } catch {
          return { kind: 'conflict' };
        }
        if (gen !== this.generation) throw e;
        this.adopt(raw, read);
        // An earlier attempt of this same save may have landed before its answer was lost: the relay then holds
        // exactly the revision this one asked for, signed here, saying the same. Anything else is a conflict.
        const held = read.ok ? read.value.record : null;
        if (
          held?.revision === record.revision &&
          held.signer_device_id === record.signer_device_id &&
          recordMatches(held, draft)
        )
          return { kind: 'saved' };
        return { kind: 'conflict' };
      }
      throw e;
    }
    if (gen !== this.generation) throw new Error('this device was unpaired');
    if (this.newerThanShown(record.revision))
      this.set({
        status: 'ready',
        record,
        receivedAt: new Date().toISOString(),
        revision: record.revision,
        problem: null,
      });
    return { kind: 'saved' };
  }

  /** Unpaired or revoked: forget the preference and drop whatever is still on its way. */
  clear(): void {
    this.generation++;
    this.reading = null;
    this.again = false;
    this.set(EMPTY);
  }
}
