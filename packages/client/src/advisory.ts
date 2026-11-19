import {
  ADVISORY_ROUND_REVISION,
  DecisionContentV1,
  InfoResponse,
  advisoryContentIssue,
  knownFeatures,
  replyModeOf,
  type CryptoEnvelope,
  type ProtocolFeature,
  type ReplyMode,
} from '@daintreehq/decisions-protocol';
import { openQuestionContent, type SealContext } from './at-rest.js';
import type { BridgeContext } from './context.js';
import { verifiedDevices } from './devices.js';
import { RelayError } from './errors.js';
import { revokedKey } from './inbound.js';
import type { QuestionRow } from './types.js';

const ADVISORY_FEATURE: ProtocolFeature = 'advisory-deadlines-v1';

/** How long what the relay and the devices said is believed when an agent asks for advice. */
export const ADVISORY_SUPPORT_TTL_MS = 5 * 60_000;
/** How old a read may get before the pump reads again. */
const REFRESH_AFTER_MS = 60_000;
/** How soon a read is tried again after one that started (and may have failed). */
const RETRY_AFTER_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** When something was read: by the host's clock, and by a monotonic one a wall-clock step cannot move back. */
interface ReadAt {
  at: number;
  mono: number;
}

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
  private relay: ({ value: boolean } & ReadAt) | null = null;
  /** The active phones and tablets that declared the feature, by device id. */
  private readers: ({ ids: string[] } & ReadAt) | null = null;
  private reading: Promise<void> | null = null;
  /** When the last read started, so a relay that keeps failing is not read on every ask. */
  private attempted: ReadAt | null = null;
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

  /** Within the TTL by both clocks, so neither a clock set back nor one that stood still keeps a read alive. */
  private fresh<T extends ReadAt>(f: T | null): T | null {
    if (!f) return null;
    const age = this.ctx.now() - f.at;
    const mono = performance.now() - f.mono;
    return age >= 0 && age < ADVISORY_SUPPORT_TTL_MS && mono < ADVISORY_SUPPORT_TTL_MS ? f : null;
  }

  private stamp(): ReadAt {
    return { at: this.ctx.now(), mono: performance.now() };
  }

  /**
   * Read again when wanted and the last read is a minute old or missing, but not within 15 seconds of the last
   * attempt, so failures are not retried on every ask. Never throws.
   */
  refreshIfDue(): Promise<void> {
    if (!this.wanted()) return Promise.resolve();
    if (this.reading) return this.reading;
    const now = this.stamp();
    // By either clock, so a wall clock that stands still or is set back never stops the reads.
    const age = (f: ReadAt) =>
      now.at < f.at ? Infinity : Math.max(now.at - f.at, now.mono - f.mono);
    const due = (f: ReadAt | null) => !f || age(f) >= REFRESH_AFTER_MS;
    if (!due(this.relay) && !(this.relay?.value && due(this.readers))) return Promise.resolve();
    if (this.attempted && age(this.attempted) < RETRY_AFTER_MS) return Promise.resolve();
    this.attempted = now;
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
    this.attempted = null;
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
    this.relay = { value: relay, ...this.stamp() };
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
          // The directory is not schema-checked here: only a real list naming the feature counts.
          Array.isArray(d.features) &&
          d.features.includes(ADVISORY_FEATURE),
      )
      .map((d) => d.device_id);
    if (run !== this.generation) return;
    this.readers = { ids, ...this.stamp() };
  }
}

/** A question's reply mode, from the AAD of the envelope it was published with (readable without opening it). */
export function replyModeOfRow(row: Pick<QuestionRow, 'content_sealed'>): ReplyMode {
  if (!row.content_sealed) return 'blocking';
  try {
    const env = JSON.parse(row.content_sealed) as { aad?: { reply_mode?: unknown } };
    return env.aad?.reply_mode === 'advisory' ? 'advisory' : 'blocking';
  } catch {
    return 'blocking';
  }
}

/**
 * Whether a sealed question envelope is an advisory question that still stands as one (protocol section 21): advisory
 * in its AAD at the advisory round, with content that opens, parses and states a plan for a question that is not an
 * approval (`advisoryContentIssue`). The plan is opened in memory only. Never throws: anything it cannot show is false.
 */
export async function advisoryContentHolds(
  ctx: SealContext,
  questionId: string,
  envelope: string,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(envelope) as Pick<CryptoEnvelope, 'aad'>;
    if (replyModeOf(parsed) !== 'advisory' || parsed.aad.revision !== ADVISORY_ROUND_REVISION)
      return false;
    const raw = await openQuestionContent(ctx, {
      question_id: questionId,
      content_sealed: envelope,
    });
    const content = DecisionContentV1.safeParse(raw);
    return content.success && advisoryContentIssue({ envelope: parsed }, content.data) === null;
  } catch {
    return false;
  }
}
