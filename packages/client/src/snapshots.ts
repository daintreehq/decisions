import {
  InfoResponse,
  LIMITS,
  PROTOCOL_VERSION,
  PaneSnapshotBody,
  PaneSnapshotContentV1,
  SNAPSHOT_RECORD_TYPE,
  SnapshotToken,
  boundTerminalLines,
  isThreadClosedStatus,
  knownFeatures,
  type SnapshotAgentState,
  type SnapshotRefresh,
  type SnapshotWaitingReason,
} from '@daintreehq/decisions-protocol';
import { buildSignedSnapshot, encryptEnvelope, newId } from '@daintreehq/decisions-crypto';
import { BridgeError } from './content.js';
import type { BridgeContext } from './context.js';
import { RelayError } from './errors.js';
import { currentEpochKey } from './identity.js';
import { backoffMs } from './relay.js';
import type { QuestionOrigin, QuestionRow } from './types.js';

/*
 * Pane snapshots (docs/protocol.md section 18): the host hands over what the asking pane looks like, and this
 * module bounds it, encrypts it, coalesces rapid updates and sends the latest one as the question's snapshot.
 * The library never reads a terminal: the host supplies the text, already redacted. Nothing here is durable but
 * an `observed_at` watermark per question; terminal text lives in memory until it is sealed and sent.
 */

/** What the host observed in the pane that asked. */
export interface PaneSnapshotInput {
  /** `idle`, `working`, `waiting`, `directing`, `completed`, `exited`, or a newer lowercase token. */
  agentState: SnapshotAgentState | (string & {});
  /** Why a `waiting` agent waits (`prompt`, `question`, `approval`, `error`), or null. */
  waitingReason?: SnapshotWaitingReason | (string & {}) | null;
  /** Escape sequences and control characters are removed, and it is cut to 240 characters. */
  paneTitle: string;
  /**
   * The pane's rendered text, already redacted: one string (split at line breaks) or its lines, oldest first.
   * Escape sequences and control characters are removed, and only the newest lines within the protocol's caps
   * are kept (`boundTerminalLines`).
   */
  terminal: string | readonly string[];
  /** When the host read the pane. Default: now. Each snapshot of a question is sent later than the last. */
  observedAt?: Date | number | string;
}

/** A phone asked for a fresh snapshot: read the pane named by `origin` and publish for `questionId`. */
export interface SnapshotRefreshRequest {
  questionId: string;
  alias: number;
  /** The pane the question is bound to, as the host registered it (or as resume last re-bound it). */
  origin: QuestionOrigin;
  refreshId: string;
  requestedByDeviceId: string;
  /** Relay time. */
  requestedAt: string;
  /** Relay time: the phone shows the snapshot as stale if no new one arrives by then. */
  deadlineAt: string;
}

export interface SnapshotOptions {
  /** Called when a phone asks for a fresh snapshot of a question this bridge published. */
  onRefresh?: (request: SnapshotRefreshRequest) => void | Promise<void>;
  /** Least time between two snapshots of one question; later updates replace the waiting one. Default 2 s. */
  minIntervalMs?: number;
}

/**
 * - `queued`: it replaces whatever was waiting and is sent as the question's latest snapshot;
 * - `closed`: the question is expired, cancelled, never published or deleted, so it keeps no snapshot;
 * - `unsupported`: the relay does not advertise `pane-snapshots-v1`.
 */
export type SnapshotPublishResult = 'queued' | 'closed' | 'unsupported';

export const SNAPSHOT_FEATURE = 'pane-snapshots-v1' as const;

const DEFAULT_INTERVAL_MS = 2_000;
/**
 * Least time between any two snapshot requests from this device, across questions: at most 240 a minute,
 * well inside the relay's 600 requests a minute per device, so questions and answers always have room.
 */
const SPACING_MS = 250;
/** How long a relay found without the feature is believed before `GET /info` is asked again. */
const RECHECK_MS = 10 * 60_000;
/** Rebuilds against a newer question revision before an observation is given up as stale. */
const MAX_REBUILDS = 3;
/** A snapshot request (or the feature check) that has not answered by then is retried later. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function cutChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * The snapshot content for `input`, within the protocol's limits. Terminal text is bounded by
 * `boundTerminalLines`: escape sequences and control characters go, the newest 200 lines are kept, and whole
 * lines are dropped from the oldest end until the text fits 32 KiB; only a newest line too long on its own is
 * cut, keeping its end, at a character boundary. Throws `BridgeError('validation_error')` for an invalid state
 * token or input that is not text.
 */
export function buildSnapshotContent(
  input: PaneSnapshotInput,
  observedAt: string,
): PaneSnapshotContentV1 {
  const state = SnapshotToken.safeParse(input?.agentState);
  if (!state.success)
    throw new BridgeError(
      'validation_error',
      'agentState must be a lowercase token such as "waiting"',
    );
  let reason: string | null = null;
  if (input.waitingReason !== undefined && input.waitingReason !== null) {
    const r = SnapshotToken.safeParse(input.waitingReason);
    if (!r.success)
      throw new BridgeError('validation_error', 'waitingReason must be a lowercase token or null');
    reason = r.data;
  }
  if (typeof input.paneTitle !== 'string')
    throw new BridgeError('validation_error', 'paneTitle must be a string');
  const t = input.terminal;
  if (typeof t !== 'string' && !(Array.isArray(t) && t.every((l) => typeof l === 'string')))
    throw new BridgeError('validation_error', 'terminal must be a string or an array of lines');
  const content: PaneSnapshotContentV1 = {
    content_version: 1,
    observed_at: observedAt,
    agent_state: state.data,
    waiting_reason: reason,
    pane_title: cutChars(
      boundTerminalLines(input.paneTitle).join(' ').trim(),
      LIMITS.snapshotPaneTitleChars,
    ),
    terminal_lines: boundTerminalLines(typeof t === 'string' ? t : t.join('\n')),
  };
  const valid = PaneSnapshotContentV1.safeParse(content);
  if (!valid.success)
    throw new BridgeError('validation_error', valid.error.issues.map((i) => i.message).join('; '));
  return content;
}

function observedMs(at: PaneSnapshotInput['observedAt'], now: number): number {
  if (at === undefined) return now;
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new BridgeError('validation_error', 'observedAt is not a time');
  // The relay refuses an observation more than its clock allowance ahead of it.
  if (ms > now + LIMITS.requestSkewMs)
    throw new BridgeError('validation_error', 'observedAt is in the future');
  return ms;
}

/** Whether the relay holds this question and keeps a snapshot for it, by what this device verified. */
function phase(row: QuestionRow | null): 'live' | 'unpublished' | 'closed' {
  if (!row || row.history_only) return 'closed';
  if (row.local_status === 'queued') return 'unpublished';
  if (row.local_status === 'publish-failed') return 'closed';
  return isThreadClosedStatus(row.local_status) ? 'closed' : 'live';
}

const markKey = (questionId: string) => `snapshot-observed:${questionId}`;

interface Pending {
  /** Null: sharing off. */
  content: Omit<PaneSnapshotContentV1, 'observed_at'> | null;
  observedMs: number;
  seq: number;
  /** The signed body, built once and resent unchanged on a transient failure (the relay may have it). */
  prepared: { body: PaneSnapshotBody; revision: number } | null;
  rebuilds: number;
}

interface Slot {
  pending: Pending | null;
  lastSentAt: number;
  retryAt: number;
  attempts: number;
  /** A refresh is waiting: an observation queued after this sequence number skips the interval. */
  urgentAfter: number | null;
  lastRefreshId: string | null;
  /** Waiting for the question's create to reach the relay; `kick` sends it once it has. */
  awaitingCreate: boolean;
  /** `clearSnapshots` callers waiting for this question's sharing-off record. */
  waiters: (() => void)[];
}

/**
 * Sends one snapshot request at a time. Each question keeps only its newest observation: an update while one
 * waits replaces it, and a question's snapshots are at least `minIntervalMs` apart, so the newest always lands
 * at the end of a burst. Sharing-off records and answers to a refresh skip that interval. Owned by the bridge,
 * which starts and stops it.
 */
export class SnapshotPublisher {
  readonly enabled: boolean;
  private readonly interval: number;
  private readonly slots = new Map<string, Slot>();
  private readonly marks = new Map<string, number>();
  /** The revision at which the relay said a question is closed: nothing more is sent until it changes. */
  private readonly gone = new Map<string, number>();
  private support: { value: boolean; at: number } | null = null;
  private running = false;
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt = 0;
  private seq = 0;

  constructor(
    private readonly ctx: BridgeContext,
    private readonly opts: SnapshotOptions | undefined,
    private readonly onError: (e: Error) => void,
  ) {
    this.enabled = opts !== undefined;
    this.interval = Math.max(0, opts?.minIntervalMs ?? DEFAULT_INTERVAL_MS);
  }

  private requireEnabled(): void {
    if (!this.enabled)
      throw new BridgeError(
        'not_configured',
        'pane snapshots are off: pass `snapshots` in the bridge options',
      );
  }

  /** True while a snapshot request (or the feature check) is in flight. */
  get busy(): boolean {
    return this.inflight;
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  /**
   * Drops every waiting snapshot and timer. Only the `observed_at` watermarks survive. A request already in
   * flight finishes (within `REQUEST_TIMEOUT_MS`) before a restarted publisher sends again, so there is never
   * more than one, and what it learns (the relay's feature list, a rate limit, a closed question) still holds.
   */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const slot of this.slots.values()) this.settle(slot);
    this.slots.clear();
  }

  /** Questions may have been published since: try what waits on them. */
  kick(): void {
    for (const slot of this.slots.values()) {
      if (!slot.awaitingCreate) continue;
      slot.awaitingCreate = false;
      slot.retryAt = 0;
    }
    this.schedule();
  }

  async publish(row: QuestionRow, input: PaneSnapshotInput): Promise<SnapshotPublishResult> {
    this.requireEnabled();
    const at = observedMs(input?.observedAt, this.ctx.now());
    const { observed_at: _ignored, ...content } = buildSnapshotContent(
      input,
      new Date(at).toISOString(),
    );
    if (this.closed(row)) return 'closed';
    if (this.knownUnsupported()) return 'unsupported';
    this.queue(row.question_id, content, at);
    return 'queued';
  }

  /**
   * Replace each question's snapshot with a sharing-off record, so phones show "not shared" instead of a stale
   * snapshot. Resolves once each record is settled: accepted, superseded by a newer shared snapshot, or given up
   * (its question closed, the relay lacks the feature, or the relay refused it, which `onError` reports). At once
   * when the bridge is not running: the records go out when it starts.
   */
  async clear(row?: QuestionRow): Promise<void> {
    this.requireEnabled();
    const rows = row
      ? [row]
      : await this.ctx.store.listQuestions({
          status: ['queued', 'open', 'proxy-answered', 'human-answered'],
        });
    const waits: Promise<void>[] = [];
    for (const r of rows) {
      // An unpublished question has nothing on the relay to clear, and a closed one keeps no snapshot.
      if (phase(r) !== 'live' || this.closed(r) || this.knownUnsupported()) {
        this.drop(r.question_id);
        continue;
      }
      const slot = this.queue(r.question_id, null, this.ctx.now());
      if (this.running) waits.push(new Promise<void>((res) => slot.waiters.push(res)));
    }
    await Promise.all(waits);
  }

  /** The question closed (expired, cancelled, deleted): forget what waits for it. */
  closedQuestion(questionId: string): void {
    this.drop(questionId);
  }

  /** A verified `decision.snapshot.refresh_requested` for a question this device published. */
  refreshRequested(row: QuestionRow, r: SnapshotRefresh): void {
    if (!this.enabled || this.closed(row)) return;
    // A request replayed long after its deadline (a desktop catching up) is not worth a capture.
    if (Date.parse(r.deadline_at) + LIMITS.requestSkewMs < this.ctx.now()) return;
    const slot = this.slot(row.question_id);
    if (slot.lastRefreshId === r.refresh_id) return;
    slot.lastRefreshId = r.refresh_id;
    slot.urgentAfter = this.seq;
    const cb = this.opts?.onRefresh;
    if (!cb) return;
    const request: SnapshotRefreshRequest = {
      questionId: row.question_id,
      alias: row.alias,
      origin: { ...row.origin },
      refreshId: r.refresh_id,
      requestedByDeviceId: r.requested_by_device_id,
      requestedAt: r.requested_at,
      deadlineAt: r.deadline_at,
    };
    // Outside the inbox's processing: a slow or failing host callback never holds up answers.
    void Promise.resolve()
      .then(() => cb(request))
      .catch((e) => this.onError(e as Error));
  }

  /* ---------------- internals ---------------- */

  private closed(row: QuestionRow): boolean {
    return phase(row) === 'closed' || this.gone.get(row.question_id) === row.question_revision;
  }

  private knownUnsupported(): boolean {
    const s = this.support;
    return s !== null && !s.value && this.ctx.now() - s.at < RECHECK_MS;
  }

  private async supported(): Promise<boolean> {
    const s = this.support;
    if (s && (s.value || this.ctx.now() - s.at < RECHECK_MS)) return s.value;
    // A relay whose `/info` does not parse advertises nothing.
    const info = InfoResponse.safeParse(await this.ctx.client.info(REQUEST_TIMEOUT_MS));
    const value = info.success && knownFeatures(info.data.features).has(SNAPSHOT_FEATURE);
    this.support = { value, at: this.ctx.now() };
    return value;
  }

  private slot(questionId: string): Slot {
    let s = this.slots.get(questionId);
    if (!s) {
      s = {
        pending: null,
        lastSentAt: -Infinity,
        retryAt: 0,
        attempts: 0,
        urgentAfter: null,
        lastRefreshId: null,
        awaitingCreate: false,
        waiters: [],
      };
      this.slots.set(questionId, s);
    }
    return s;
  }

  private queue(questionId: string, content: Pending['content'], at: number): Slot {
    const slot = this.slot(questionId);
    // A shared snapshot supersedes a waiting sharing-off record: its callers are done waiting.
    if (content !== null) this.settle(slot);
    slot.pending = { content, observedMs: at, seq: ++this.seq, prepared: null, rebuilds: 0 };
    this.schedule();
    return slot;
  }

  private settle(slot: Slot): void {
    for (const w of slot.waiters.splice(0)) w();
  }

  private drop(questionId: string): void {
    const slot = this.slots.get(questionId);
    if (!slot) return;
    this.settle(slot);
    this.slots.delete(questionId);
  }

  private current(questionId: string, slot: Slot, p: Pending): boolean {
    return this.slots.get(questionId) === slot && slot.pending === p;
  }

  /** Done with `p`, sent or given up: unless something newer replaced it, nothing waits any more. */
  private finish(questionId: string, slot: Slot, p: Pending): void {
    if (!this.current(questionId, slot, p)) return;
    slot.pending = null;
    this.settle(slot);
  }

  private schedule(): void {
    if (!this.running || this.inflight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.ctx.now();
    let next: { questionId: string; slot: Slot; at: number; ready: number; rank: number } | null =
      null;
    for (const [questionId, slot] of this.slots) {
      const p = slot.pending;
      if (!p) continue;
      const urgent = p.content === null || (slot.urgentAfter !== null && p.seq > slot.urgentAfter);
      // When this question could go on its own account; the spacing between requests then applies to all.
      const ready = Math.max(slot.retryAt, urgent ? -Infinity : slot.lastSentAt + this.interval);
      const at = Math.max(this.nextAt, ready);
      // Due work first, urgent before routine, longest ready first, so a busy question never starves another.
      const rank = at <= now ? (urgent ? 0 : 1) : 2;
      if (!next || rank < next.rank || (rank === next.rank && ready < next.ready))
        next = { questionId, slot, at, ready, rank };
    }
    if (!next) return;
    if (next.rank < 2) {
      void this.send(next.questionId, next.slot);
      return;
    }
    // Nothing is due: the least `ready` is also the earliest `at`.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, next.at - now);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async send(questionId: string, slot: Slot): Promise<void> {
    const p = slot.pending!;
    this.inflight = true;
    let requested = true;
    try {
      requested = await this.sendOne(questionId, slot, p);
    } catch (e) {
      // Not the relay's answer (a content key missing, a bug): report it and give this observation up.
      this.onError(e as Error);
      this.finish(questionId, slot, p);
    } finally {
      this.inflight = false;
      // Only a request spends the spacing; a question found unpublished or closed costs nothing.
      if (requested) this.nextAt = Math.max(this.nextAt, this.ctx.now() + SPACING_MS);
      this.schedule();
    }
  }

  /** Audit without holding the send: a slow audit file must not stall every snapshot behind it. */
  private note(entry: { event: string; question_id: string; result: string }): void {
    void this.ctx.audit.log(entry).catch((e) => this.onError(e as Error));
  }

  private retryLater(slot: Slot, err: RelayError | null): void {
    slot.attempts++;
    const wait = Math.max(err?.retryAfterMs ?? 0, backoffMs(slot.attempts, 1_000, 60_000));
    slot.retryAt = this.ctx.now() + wait;
    // A rate limit is the device's, not the question's: hold every snapshot back.
    if (err?.status === 429) this.nextAt = Math.max(this.nextAt, slot.retryAt);
  }

  /** Returns whether a request went to the relay. */
  private async sendOne(questionId: string, slot: Slot, p: Pending): Promise<boolean> {
    const { ctx } = this;
    // Whether `supported()` asks the relay, which spends the spacing like any request.
    const checked = this.support === null || (!this.support.value && !this.knownUnsupported());
    let supported: boolean;
    try {
      supported = await this.supported();
    } catch {
      this.retryLater(slot, null);
      return true;
    }
    if (!supported) {
      for (const id of [...this.slots.keys()]) this.drop(id);
      return checked;
    }
    const row = await ctx.store.getQuestion(questionId);
    if (!this.current(questionId, slot, p)) return checked; // replaced or dropped meanwhile
    if (!row || this.closed(row)) {
      this.drop(questionId);
      return checked;
    }
    if (phase(row) === 'unpublished') {
      // Not on the relay yet: the bridge kicks once the create lands; this is the fallback.
      slot.awaitingCreate = true;
      slot.retryAt = ctx.now() + Math.max(this.interval, 1_000);
      return checked;
    }
    // Revisions only grow: a body signed for an older one than this device has verified would be refused.
    if (!p.prepared || p.prepared.revision < row.question_revision)
      p.prepared = await this.prepare(questionId, p, row.question_revision);
    // Stopped, replaced or closed while sealing: send nothing.
    if (!this.running || !this.current(questionId, slot, p)) return checked;
    const sent = p.prepared;
    try {
      await ctx.client.putSnapshot(questionId, sent.body, REQUEST_TIMEOUT_MS);
    } catch (e) {
      const err =
        e instanceof RelayError ? e : new RelayError('network_error', (e as Error).message, 0);
      if (err.retryable) {
        this.retryLater(slot, err);
        return true;
      }
      await this.rejected(questionId, slot, p, sent.revision, err);
      return true;
    }
    slot.attempts = 0;
    slot.retryAt = 0;
    slot.lastSentAt = ctx.now();
    if (slot.urgentAfter !== null && p.seq > slot.urgentAfter) slot.urgentAfter = null;
    if (p.content === null && this.current(questionId, slot, p)) {
      this.note({ event: 'snapshot.cleared', question_id: questionId, result: 'off' });
    }
    this.finish(questionId, slot, p);
    return true;
  }

  private async rejected(
    questionId: string,
    slot: Slot,
    p: Pending,
    revision: number,
    err: RelayError,
  ): Promise<void> {
    const { ctx } = this;
    slot.attempts = 0;
    slot.retryAt = 0;
    if (err.code === 'revision_conflict') {
      // The question moved on (an answer, a reopen) before the inbox saw it: sign again for the relay's
      // revision. The same revision means the relay holds a later observation, so this one is stale.
      const latest = Number(err.details?.latest_revision);
      const row = await ctx.store.getQuestion(questionId);
      const target = Number.isInteger(latest) ? latest : row?.question_revision;
      if (
        target !== undefined &&
        target !== revision &&
        p.rebuilds < MAX_REBUILDS &&
        this.current(questionId, slot, p) &&
        row &&
        !this.closed(row)
      ) {
        p.rebuilds++;
        p.prepared = await this.prepare(questionId, p, target);
        return;
      }
    } else if (err.code === 'expired' || err.code === 'invalid_state' || err.code === 'not_found') {
      // The relay says the question is closed: stop until its revision moves (a reopen). A reply that comes
      // back after the question was closed and reopened here belongs to a discarded slot: leave the new one.
      this.gone.set(questionId, revision);
      if (this.slots.get(questionId) === slot) this.drop(questionId);
      this.note({ event: 'snapshot.stopped', question_id: questionId, result: err.code });
      return;
    } else {
      this.onError(err);
    }
    this.note({ event: 'snapshot.rejected', question_id: questionId, result: err.code });
    this.finish(questionId, slot, p);
  }

  private async mark(questionId: string): Promise<number> {
    const cached = this.marks.get(questionId);
    if (cached !== undefined) return cached;
    const v = await this.ctx.store.getMeta(markKey(questionId));
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : -Infinity;
  }

  /**
   * Seal and sign `p` for `revision`. Its `observed_at` is pushed past every earlier one for the question (the
   * relay refuses one no later than the last it accepted), and that watermark is stored before anything is sent.
   */
  private async prepare(
    questionId: string,
    p: Pending,
    revision: number,
  ): Promise<NonNullable<Pending['prepared']>> {
    const { ctx } = this;
    const at = Math.max(p.observedMs, (await this.mark(questionId)) + 1);
    this.marks.set(questionId, at);
    await ctx.store.setMeta(markKey(questionId), String(at));
    const observedAt = new Date(at).toISOString();
    const installationId = ctx.identity.config.installationId;
    const deviceId = ctx.identity.config.deviceId;
    const snapshotId = newId(ctx.now());
    const envelope = p.content
      ? await encryptEnvelope({
          epochKey: currentEpochKey(ctx.identity),
          installationId,
          questionId,
          recordId: snapshotId,
          recordType: SNAPSHOT_RECORD_TYPE,
          revision: 0,
          senderDeviceId: deviceId,
          purpose: 'snapshot-content',
          plaintext: { ...p.content, observed_at: observedAt },
        })
      : null;
    const snapshot = await buildSignedSnapshot({
      installationId,
      questionId,
      snapshotId,
      signerDeviceId: deviceId,
      signingKey: ctx.identity.keys.signing.privateKey,
      questionRevision: revision,
      observedAt,
      envelope,
    });
    const body: PaneSnapshotBody = {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: newId(ctx.now()),
      snapshot,
    };
    const valid = PaneSnapshotBody.safeParse(body);
    if (!valid.success)
      throw new BridgeError(
        'validation_error',
        `snapshot does not fit the protocol: ${valid.error.issues.map((i) => i.message).join('; ')}`,
      );
    return { body, revision };
  }
}
