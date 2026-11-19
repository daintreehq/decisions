import { InfoResponse, knownFeatures, type ProtocolFeature } from '@daintreehq/decisions-protocol';
import type { BridgeContext } from './context.js';
import { verifiedDevices } from './devices.js';
import { RelayError } from './errors.js';
import { revokedKey } from './inbound.js';

const ADVISORY_FEATURE: ProtocolFeature = 'advisory-deadlines-v1';

/** How long what the relay and the devices said is believed when an agent asks for advice. */
export const ADVISORY_SUPPORT_TTL_MS = 5 * 60_000;
/** How old a read may get before the pump reads again. */
const REFRESH_AFTER_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** What is known about the remote half of `advisoryRefusal`; null means not known (never read, or too old). */
export interface AdvisorySupportSnapshot {
  /** The relay lists `advisory-deadlines-v1` in `GET /info`. */
  relay: boolean | null;
  /** An active phone or tablet declared `advisory-deadlines-v1` on its latest socket ticket. Null unless `relay`. */
  reader: boolean | null;
}

/**
 * The remote facts an advisory question needs before it is signed (protocol section 21), read in the background so
 * `ask_human` never waits on the network: whether the relay supports advisory questions, and whether a phone or tablet
 * the person holds can show one. Read only while the host delivers advisory outcomes and its policy allows them,
 * so other hosts make no extra requests. A read that fails leaves the facts to age out; nothing is assumed.
 */
export class AdvisorySupport {
  private relay: { value: boolean; at: number } | null = null;
  /** The active phones and tablets that declared the feature, by device id. */
  private readers: { ids: string[]; at: number } | null = null;
  private reading: Promise<void> | null = null;
  /** Bumped by `stop`, so a read that started before it never restores what it cleared. */
  private generation = 0;
  /** False once the bridge stopped or was revoked, until it starts again: nothing is read meanwhile. */
  private active = true;

  constructor(
    private readonly ctx: BridgeContext,
    /** The host delivers advisory outcomes (`BridgeOptions.advisoryDeadlines`). */
    readonly hostSupport: boolean,
  ) {}

  /** Whether an agent on this host could ask for advice now, so the facts are worth reading. */
  wanted(): boolean {
    return this.active && this.hostSupport && this.ctx.policy.advisoryQuestions;
  }

  /**
   * What is known now. A reader whose revocation this desktop has seen in the ledger no longer counts, even before the
   * next read of the directory.
   */
  async known(): Promise<AdvisorySupportSnapshot> {
    const relay = this.fresh(this.relay)?.value ?? null;
    const readers = relay ? this.fresh(this.readers) : null;
    if (!readers) return { relay, reader: null };
    for (const id of readers.ids)
      if ((await this.ctx.store.getMeta(revokedKey(id))) === null) return { relay, reader: true };
    return { relay, reader: false };
  }

  private fresh<T extends { at: number }>(f: T | null): T | null {
    if (!f) return null;
    const age = this.ctx.now() - f.at;
    return age >= 0 && age < ADVISORY_SUPPORT_TTL_MS ? f : null;
  }

  /** Read again when wanted and the last read is a minute old or missing. Never throws. */
  refreshIfDue(): Promise<void> {
    if (!this.wanted()) return Promise.resolve();
    if (this.reading) return this.reading;
    const now = this.ctx.now();
    const due = (f: { at: number } | null) => !f || now - f.at >= REFRESH_AFTER_MS || now < f.at;
    if (!due(this.relay) && !(this.relay?.value && due(this.readers))) return Promise.resolve();
    const run = this.generation;
    this.reading = this.read(run)
      .catch(() => undefined)
      .finally(() => {
        if (run === this.generation) this.reading = null;
      });
    return this.reading;
  }

  start(): void {
    this.active = true;
  }

  /** Forget everything and read nothing more (the bridge stopped or was revoked); a read in flight is discarded. */
  stop(): void {
    this.active = false;
    this.generation++;
    this.relay = null;
    this.readers = null;
    this.reading = null;
  }

  private async read(run: number): Promise<void> {
    const { ctx } = this;
    let relay: boolean;
    try {
      const info = InfoResponse.safeParse(await ctx.client.info(REQUEST_TIMEOUT_MS));
      relay = info.success && knownFeatures(info.data.features).has(ADVISORY_FEATURE);
    } catch (e) {
      // A relay that refuses the read outright advertises nothing; a network failure or 5xx says nothing.
      if (!(e instanceof RelayError) || e.retryable) return;
      relay = false;
    }
    if (run !== this.generation) return;
    this.relay = { value: relay, at: ctx.now() };
    if (!relay) {
      this.readers = null;
      return;
    }
    const devices = await verifiedDevices(ctx.client, {
      retry: false,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const ids = devices
      .filter(
        (d) =>
          (d.cert.role === 'phone' || d.cert.role === 'tablet') &&
          d.revoked_at === null &&
          (d.features ?? []).includes(ADVISORY_FEATURE),
      )
      .map((d) => d.device_id);
    if (run !== this.generation) return;
    this.readers = { ids, at: ctx.now() };
  }
}
