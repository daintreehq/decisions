import {
  ADVISORY_ROUND_REVISION,
  ApiError,
  EventData,
  applyAction,
  isPersonDecline,
  isThreadClosedStatus,
  type DecisionContentV1,
  type LedgerEvent,
  type QuestionStatus,
  type SnapshotRefresh,
} from '@daintreehq/decisions-protocol';
import {
  isClosure,
  parseAnswers,
  supersededClosure,
  serializeAnswers,
  type AdvisoryDisposition,
  type AnswerContent,
  type AnswerEntry,
} from './answers.js';
import { advisoryContentHolds, replyModeOfRow } from './advisory.js';
import { openQuestionContent, sealAnswerContent } from './at-rest.js';
import { hostRef, type BridgeContext } from './context.js';
import { isDeviceRevoked } from './errors.js';
import {
  EVENT_ACTION,
  revokedKey,
  type EventVerifier,
  type VerifiedAnswer,
  type VerifiedMessage,
} from './inbound.js';
import { parseMessages, serializeMessages, type StoredMessage } from './messages.js';
import { KeyUnavailableError, Mutex, TransientError } from './mutex.js';
import { answerRuleViolation } from './policy.js';
import type { QuestionRow } from './types.js';

export interface InboxCallbacks {
  /** This device was revoked: stop all delivery. */
  onRevokedSelf(): void;
  /** A phone asked for a fresh snapshot of one of this device's questions. Must return without waiting. */
  onSnapshotRefresh?(row: QuestionRow, refresh: SnapshotRefresh): void;
  /** One of this device's questions expired, was cancelled or was deleted. Must return without waiting. */
  onQuestionClosed?(questionId: string): void;
  /** The relay says the involvement preference changed (a hint, not the record). Must return without waiting. */
  onInvolvementHint?(): void;
  /**
   * The terminal write of a closure notice for this question that is under way, if any: settled once the sink has
   * answered. A reopen is applied only after it, so the old round's notice is either written before the question
   * opens again or never. Must return without waiting.
   */
  closureWrite?(questionId: string): Promise<void> | null;
}

export interface InboxOptions {
  /**
   * Take thread messages (`decision.message.posted`) for the questions this device asked: store each verified one
   * and hand the person's to delivery. Off, they are ignored, as a client that never declared
   * `thread-messages-v1` is never sent them.
   */
  messages?: boolean;
  /**
   * The host delivers advisory outcomes (`BridgeOptions.advisoryDeadlines`): an expiry of an advisory question's
   * advisory round is recorded with its disposition (`AnswerEntry.advisory_disposition`), so the agent is told in the
   * advisory notice. Off, every expiry is recorded as an ordinary one, whose block every sink reads.
   */
  advisoryOutcomes?: boolean;
}

/** Withdraw every human message not yet typed: kept for the thread, never typed. */
function withdrawMessages(json: string): string {
  return serializeMessages(
    parseMessages(json).map((m) =>
      m.delivery && m.delivery.status !== 'terminal-delivered'
        ? { ...m, delivery: { ...m.delivery, deliver: false } }
        : m,
    ),
  );
}

/**
 * Closure notices (an expiry or a decline) of rounds before `revision` that were not typed yet: withdrawn, kept for
 * the record. A reopen starts round `revision`, so they no longer describe the question.
 */
export function withdrawClosures(entries: AnswerEntry[], revision: number): AnswerEntry[] {
  return entries.map((e) =>
    isClosure(e) && e.revision < revision && !e.delivered ? { ...e, deliver: false } : e,
  );
}

/** The latest of several deadlines; null (never) when any of them is. */
function latestDeadline(deadlines: (string | null)[]): string | null {
  if (deadlines.some((d) => d === null)) return null;
  return (deadlines as string[]).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/** Meta key: the stored history was searched for reopens whose deadline an earlier bridge did not keep. */
const ROUNDS_RECONCILED = 'rounds-reconciled';

/** How far this desktop's clock may lag the relay's before an expiry it holds is taken as early. */
export const EXPIRY_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * A key still missing after a reload that succeeded (`KeyUnavailableError`) is waited for only this many attempts AND
 * this long since it was first missed, then the event is consumed with an error. Attempts come with every pump and
 * socket event, so a count alone would end the wait for a rotation another process is still saving.
 */
const MAX_KEY_ATTEMPTS = 5;
const MIN_KEY_WINDOW_MS = 10 * 60_000;

/** What the relay would hold for this question, derived only from events WE verified. */
function protocolStatus(s: QuestionRow['local_status']): QuestionStatus | null {
  switch (s) {
    case 'queued': // the create receipt may have been lost; the relay has it as open
    case 'open':
      return 'open';
    case 'proxy-answered':
    case 'human-answered':
    case 'cancelled':
    case 'expired':
      return s;
    default:
      return null; // publish-failed etc.: the relay should not be sending events for it
  }
}

/**
 * Persists ledger events BEFORE anything is acknowledged, then verifies and applies them strictly in seq
 * order and only up to the confirmed (contiguous) frontier. Unverifiable events are rejected and audited;
 * they never reach a terminal. Transient failures leave the event unprocessed so it is retried in order, for as
 * long as they last: such a failure says nothing about the event, so however long the relay, the device directory
 * or the key store stays unreadable, a committed answer waits for it rather than being dropped. Only a key still
 * missing once its source was read is waited for a bounded time (`MAX_KEY_ATTEMPTS`, `MIN_KEY_WINDOW_MS`).
 */
export class Inbox {
  private readonly serial = new Mutex();
  private readonly keyAttempts = new Map<number, { n: number; since: number }>();
  /** What this run last audited as deferred (event and kind of failure): logged once per hold, not on every retry. */
  private deferred: string | null = null;
  /**
   * Rows written before reopens kept their deadline are repaired in the background (`reconcileRounds`), never in the
   * way of an event. Until a pass has settled them all, an expiry is judged by `roundDeadline` instead.
   */
  private reconciling: Promise<void> | null = null;
  /** Questions this run reopened itself: their deadline is the signed one, so the background pass leaves them. */
  private readonly reopened = new Set<string>();
  private reconcileDone = false;
  private reconcileAfter = 0;

  constructor(
    private readonly ctx: BridgeContext,
    private readonly verifier: EventVerifier,
    private readonly cb: InboxCallbacks,
    private readonly opts: InboxOptions = {},
  ) {}

  /** Durable write. Returns the new contiguous cursor (what may be acked). */
  async persist(ev: LedgerEvent): Promise<{ isNew: boolean; cursor: number }> {
    const isNew = await this.ctx.store.insertEvent({
      seq: ev.seq,
      event_id: ev.event_id,
      event_type: ev.event_type,
      json: JSON.stringify(ev),
      received_at: this.ctx.now(),
      processed_at: null,
    });
    const cursor = await this.ctx.store.advanceCursor();
    return { isNew, cursor };
  }

  /** True when we hold events beyond the confirmed frontier: something between them is missing or unconfirmed. */
  async hasGap(): Promise<boolean> {
    const cursor = await this.ctx.store.getCursor();
    const pending = await this.ctx.store.unprocessedEvents(1000);
    return pending.some((e) => e.seq > cursor);
  }

  /** Apply every stored-but-unprocessed event up to the frontier, in order. True if any delivery may now be pending. */
  processPending(): Promise<boolean> {
    return this.serial.run(async () => {
      let drain = false;
      if (!this.reconcileDone && !this.reconciling && this.ctx.now() >= this.reconcileAfter) {
        this.reconciling = this.reconcileRounds().finally(() => {
          this.reconciling = null;
        });
      }
      for (;;) {
        const cursor = await this.ctx.store.getCursor();
        const batch = (await this.ctx.store.unprocessedEvents(50)).filter((e) => e.seq <= cursor);
        if (batch.length === 0) return drain;
        for (const stored of batch) {
          const ev = JSON.parse(stored.json) as LedgerEvent;
          let revoked = false;
          try {
            if (await this.apply(ev, stored.received_at)) drain = true;
          } catch (e) {
            if (e instanceof TransientError && this.keepWaiting(ev.seq, e)) {
              // Leave it unprocessed and stop: later events must not overtake it.
              const hold = `${ev.seq}:${e.name}`;
              if (this.deferred !== hold) {
                await this.ctx.audit.log({
                  event: 'event.deferred',
                  result: e.message.slice(0, 80),
                });
                this.deferred = hold;
              }
              return drain;
            }
            await this.ctx.audit.log({
              event: 'event.error',
              result: (e as Error).message.slice(0, 80),
            });
            revoked = isDeviceRevoked(e);
          }
          this.keyAttempts.delete(ev.seq);
          await this.ctx.store.markEventProcessed(stored.seq, this.ctx.now());
          if (revoked) {
            // A read for this event found the relay no longer accepts this device: stop, as a sync or the socket
            // finding it would, rather than wait for the revocation to come up in the ledger.
            this.cb.onRevokedSelf();
            return drain;
          }
        }
      }
    });
  }

  /**
   * Whether an event held by a transient failure is still waited for. An outage (the relay, the device directory, the
   * key store) is waited out however long it lasts: it says nothing about the event, so an answer the relay committed
   * is never consumed for it. A key still missing after a reload that succeeded is waited for a bounded time, enough
   * for a rotation another process is saving; one erased from the key store never comes back.
   */
  private keepWaiting(seq: number, e: TransientError): boolean {
    if (!(e instanceof KeyUnavailableError)) return true;
    const prev = this.keyAttempts.get(seq);
    const a = { n: (prev?.n ?? 0) + 1, since: prev?.since ?? this.ctx.now() };
    this.keyAttempts.set(seq, a);
    return a.n < MAX_KEY_ATTEMPTS || this.ctx.now() - a.since < MIN_KEY_WINDOW_MS;
  }

  /**
   * The question's content, opened in memory. Null when it cannot be opened: the caller rejects the event
   * rather than guess the answer rules. A missing epoch key throws `TransientError` (retried in order).
   */
  private async content(row: QuestionRow): Promise<Partial<DecisionContentV1> | null> {
    try {
      return (await openQuestionContent(this.ctx, row)) ?? {};
    } catch (e) {
      if (e instanceof TransientError) throw e;
      return null;
    }
  }

  private async reject(
    row: QuestionRow,
    reason: string,
    extra: { provenance?: string } = {},
  ): Promise<false> {
    await this.ctx.audit.log({
      event: 'event.rejected',
      question_id: row.question_id,
      requirement: row.requirement,
      result: reason,
      ...extra,
    });
    return false;
  }

  /**
   * After a rotation: pick up the new epoch key unless we already hold it (replaying an old rotation costs no
   * relay round trip). A relay that understates the epoch only delays this until an answer arrives under the
   * unknown epoch, which refreshes again.
   */
  private async refreshKeys(epoch: number | null): Promise<void> {
    if (epoch !== null && epoch <= this.ctx.identity.currentEpoch) return;
    await this.ctx.refreshIdentity?.(epoch ?? undefined);
  }

  /** `receivedAt`: when this desktop first stored the event (durable, so a restart cannot move it). */
  private async apply(ev: LedgerEvent, receivedAt: number): Promise<boolean> {
    const { ctx } = this;
    switch (ev.event_type) {
      case 'device.revoked': {
        const d = EventData.deviceRevoked.safeParse(ev.data);
        if (d.success) {
          // Persist the revocation point (ledger order) so a stale device directory cannot undo it.
          await ctx.store.setMeta(revokedKey(d.data.device_id), String(ev.seq));
          if (d.data.device_id === ctx.identity.config.deviceId) {
            await ctx.audit.log({ event: 'device.revoked-self' });
            this.cb.onRevokedSelf();
            this.verifier.invalidate();
            return false; // nothing more is sealed to us
          }
        }
        this.verifier.invalidate();
        await this.refreshKeys(d.success ? d.data.key_epoch : null);
        return false;
      }
      case 'device.approved':
        this.verifier.invalidate();
        return false;
      case 'involvement.updated':
        // Installation-wide and question-free: read the signed record again, outside the delivery path.
        this.cb.onInvolvementHint?.();
        return false;
      case 'device.key_rotated': {
        // The owner reloads its key store; a Host fetches the grant the owner sealed to it for the new epoch.
        this.verifier.invalidate();
        const d = EventData.keyRotated.safeParse(ev.data);
        await this.refreshKeys(d.success ? d.data.key_epoch : null);
        return false;
      }
      default:
        break;
    }
    if (!ev.question_id) return false;
    // Only questions this device created have a live local row. Every other device's events (the owner's, a
    // Host's) were stored above for sync, and stop here: never verified for delivery, never acted on.
    const peek = await ctx.store.getQuestion(ev.question_id);
    if (!peek || peek.history_only) return false; // not ours (or imported history): never act on it

    if (EVENT_ACTION[ev.event_type]) {
      const v = await this.verifier.verifyAction(ev); // may throw TransientError; no lock held across the network
      if (!v.ok) return this.reject(peek, v.reason);
      if (v.action === 'reopen') return this.afterClosureWrites(peek.question_id, ev, v);
      return ctx.lock.run(() => this.applyVerified(ev, v));
    }
    if (ev.event_type === 'decision.message.posted') {
      if (!this.opts.messages) return false;
      const v = await this.verifier.verifyMessage(ev); // may throw TransientError, like an action
      if (!v.ok) return this.reject(peek, v.reason);
      return ctx.lock.run(() => this.applyMessage(ev, v));
    }
    return ctx.lock.run(async () => {
      const row = await ctx.store.getQuestion(ev.question_id!);
      if (!row) return false;
      switch (ev.event_type) {
        case 'decision.created': {
          // Our question ids are random and the record is signed by its creator: a creation naming any other
          // device for one of our ids is not ours, whatever the relay says.
          const d = EventData.created.safeParse(ev.data);
          if (
            !d.success ||
            d.data.record.question_id !== row.question_id ||
            d.data.record.originating_device_id !== ctx.identity.config.deviceId ||
            d.data.record.signer_device_id !== ctx.identity.config.deviceId
          ) {
            return this.reject(row, 'created-by-another-device');
          }
          const patch: Partial<QuestionRow> = { remote_event_seq: ev.seq };
          // The relay committed it: a question still queued, or one a refused retry closed although an earlier attempt
          // had landed (a relay that checked the deadline before the receipt), is open. One settled as never
          // published on the relay's own word stays as it was settled.
          const refused =
            row.local_status === 'publish-failed' &&
            !parseAnswers(row.answers_json).some((e) => e.kind === 'unpublished');
          if (row.local_status === 'queued' || refused) {
            patch.local_status = 'open';
            if (refused) patch.error_code = null;
          }
          await ctx.store.updateQuestion(row.question_id, patch);
          return false;
        }
        case 'decision.deleted': {
          const entries = parseAnswers(row.answers_json).map((e) => ({ ...e, deliver: false }));
          await ctx.store.updateQuestion(row.question_id, {
            local_status: 'cancelled',
            remote_event_seq: ev.seq,
            answers_json: serializeAnswers(entries),
            messages_json: withdrawMessages(row.messages_json),
          });
          this.cb.onQuestionClosed?.(row.question_id);
          return false;
        }
        case 'decision.expired':
          return this.applyExpired(ev, row, receivedAt);
        case 'decision.snapshot.refresh_requested': {
          // A relay hint, not a signed request: at most it asks this desktop to look at its own pane again.
          const d = EventData.snapshotRefreshRequested.safeParse(ev.data);
          if (!d.success) return this.reject(row, 'malformed-event');
          if (d.data.target_host_id !== (await hostRef(row.origin.host_id)))
            return this.reject(row, 'refresh-for-another-host');
          const { target_host_id: _host, ...refresh } = d.data;
          this.cb.onSnapshotRefresh?.(row, refresh);
          return false;
        }
        default:
          return false;
      }
    });
  }

  /**
   * After a reopen: a write of an earlier round's closure notice that may or may not have reached the screen (an
   * ambiguous sink answer, or a crash recovery found no marker for) no longer holds the question's answers back. The
   * notice is content-free and replaced, and the uncertainty stays in the audit log. True when the question's
   * `delivery-uncertain` came only from such writes. Runs under ctx.lock.
   */
  private async releaseClosureWrites(reopened: QuestionRow): Promise<boolean> {
    const { ctx } = this;
    if (!ctx.store.uncertainIntents) return false;
    for (const i of await ctx.store.uncertainIntents(reopened.question_id)) {
      if (!supersededClosure(reopened, i.answer_revision)) continue;
      await ctx.store.updateIntent(i.injection_id, { state: 'abandoned', updated_at: ctx.now() });
      await ctx.audit.log({
        event: 'delivery.superseded',
        question_id: reopened.question_id,
        result: 'uncertain',
      });
    }
    // Every uncertain write leaves its intent uncertain, so none left means none holds the question any more (also
    // when an earlier attempt released them and stopped before the row was written).
    return (
      reopened.delivery_status === 'delivery-uncertain' &&
      !(await ctx.store.hasUncertainIntent(reopened.question_id))
    );
  }

  /**
   * Apply a verified reopen once no closure notice of the question is being written to its terminal. The check and
   * the apply share the lock delivery admits a write under, so a notice is either admitted first (and the reopen
   * waits for the sink's answer, outside the lock) or finds itself withdrawn.
   */
  private async afterClosureWrites(
    questionId: string,
    ev: LedgerEvent,
    v: Extract<VerifiedAnswer, { ok: true }>,
  ): Promise<boolean> {
    type Turn = { kind: 'applied'; applied: boolean } | { kind: 'writing'; writing: Promise<void> };
    for (;;) {
      // The write is handed back, never awaited here: waiting inside the lock would hold up its own settlement.
      const turn = await this.ctx.lock.run(async (): Promise<Turn> => {
        const writing = this.cb.closureWrite?.(questionId);
        return writing
          ? { kind: 'writing', writing }
          : { kind: 'applied', applied: await this.applyVerified(ev, v) };
      });
      if (turn.kind === 'applied') return turn.applied;
      await turn.writing.catch(() => undefined);
    }
  }

  /**
   * A bridge before this one stored a reopen's status and revision but kept the previous round's deadline. For each
   * reopened question, write the deadline signed by the latest verified reopen in the stored history that the row's
   * revision has reached. Runs beside event processing; the store is marked once a pass has settled every question,
   * and an unfinished pass is tried again a minute later.
   */
  private async reconcileRounds(): Promise<void> {
    const { ctx } = this;
    let settled = false;
    try {
      if (!ctx.store.processedEventsOfType) return void (settled = true);
      if ((await ctx.store.getMeta(ROUNDS_RECONCILED)) !== null) return void (settled = true);
      const rows = (await ctx.store.listQuestions()).filter(
        (q) => !q.history_only && q.question_revision > 0,
      );
      const reopens =
        rows.length === 0
          ? []
          : (await ctx.store.processedEventsOfType('decision.reopened')).map(
              (e) => JSON.parse(e.json) as LedgerEvent,
            );
      let open = 0;
      for (const row of rows) {
        const done = await this.reconcileRow(row, reopens).catch(async (e: unknown) => {
          await ctx.audit.log({
            event: 'round.unreconciled',
            question_id: row.question_id,
            result: String((e as Error)?.message ?? e).slice(0, 80),
          });
          return false;
        });
        if (!done) open++;
      }
      if (open > 0) {
        await ctx.audit.log({ event: 'rounds.unreconciled', result: `${open}` });
        return;
      }
      await ctx.store.setMeta(ROUNDS_RECONCILED, String(ctx.now()));
      settled = true;
    } catch (e) {
      await ctx.audit
        .log({
          event: 'rounds.unreconciled',
          result: String((e as Error)?.message ?? e).slice(0, 80),
        })
        .catch(() => undefined);
    } finally {
      if (settled) {
        this.reconcileDone = true;
        this.reopened.clear();
      } else this.reconcileAfter = ctx.now() + 60_000;
    }
  }

  /**
   * One question's deadline from its stored history: the one signed by the latest verified reopen its revision has
   * reached. Reopens into that round that disagree give the latest of their deadlines (none, if any has none), as
   * `roundDeadline` does. True once settled; false when a reopen claims another deadline but none verifies, or the
   * row moved on meanwhile (a later pass looks again).
   */
  private async reconcileRow(row: QuestionRow, reopens: LedgerEvent[]): Promise<boolean> {
    const { ctx } = this;
    const mine = reopens.filter(
      (ev) =>
        ev.question_id === row.question_id &&
        ev.question_revision !== null &&
        ev.question_revision <= row.question_revision,
    );
    // The usual case once reopens keep their deadline: nothing differs, so nothing is verified.
    if (
      mine.every(
        (ev) => EventData.action.safeParse(ev.data).data?.record.expires_at === row.expires_at,
      )
    ) {
      return true;
    }
    let deadlines: (string | null)[] | null = null;
    const rounds = [...new Set(mine.map((ev) => ev.question_revision!))].sort((a, b) => b - a);
    for (const round of rounds) {
      const found: (string | null)[] = [];
      for (const ev of mine.filter((e) => e.question_revision === round)) {
        const v = await this.verifier.verifyAction(ev); // may throw TransientError: looked at again later
        const declared = EventData.action.safeParse(ev.data).data;
        if (
          v.ok &&
          v.action === 'reopen' &&
          v.record.expected_revision === round - 1 &&
          declared?.revision === round &&
          declared.status === 'open'
        ) {
          found.push(v.record.expires_at);
        }
      }
      if (found.length > 0) {
        deadlines = found;
        break;
      }
    }
    if (!deadlines) return false;
    if (new Set(deadlines).size > 1)
      await ctx.audit.log({ event: 'round.ambiguous', question_id: row.question_id });
    const deadline = latestDeadline(deadlines);
    if (deadline === row.expires_at) return true;
    return ctx.lock.run(async () => {
      const fresh = await ctx.store.getQuestion(row.question_id);
      if (
        !fresh ||
        this.reopened.has(row.question_id) ||
        fresh.local_status !== row.local_status ||
        fresh.question_revision !== row.question_revision ||
        fresh.expires_at !== row.expires_at
      ) {
        return false;
      }
      await ctx.store.updateQuestion(row.question_id, { expires_at: deadline });
      await ctx.audit.log({ event: 'round.reconciled', question_id: row.question_id });
      return true;
    });
  }

  /**
   * The deadline an expiry is judged by. Once the store's rows are reconciled, the row's own. Until then a reopened
   * round's row may still hold the round before's, so the deadlines the stored reopens into this round claim are
   * used instead, unverified: the latest of them, or none if any has none. A claim the relay made up can only make
   * that later, never earlier, so nothing is released early.
   */
  private async roundDeadline(row: QuestionRow): Promise<string | null> {
    const { ctx } = this;
    if (this.reconcileDone || row.question_revision === 0 || !ctx.store.processedEventsOfType)
      return row.expires_at;
    if ((await ctx.store.getMeta(ROUNDS_RECONCILED)) !== null) return row.expires_at;
    // Every reopen of this question that names the round, in the event or in its data (the inbox applies one by its
    // data): an extra claim can only make the deadline later, so more of them is the safe side.
    const claims = (await ctx.store.processedEventsOfType('decision.reopened'))
      .map((e) => JSON.parse(e.json) as LedgerEvent)
      .filter((ev) => ev.question_id === row.question_id)
      .flatMap((ev) => {
        const data = EventData.action.safeParse(ev.data).data;
        const round =
          ev.question_revision === row.question_revision ||
          data?.revision === row.question_revision;
        return round && data ? [data.record.expires_at] : [];
      });
    return claims.length === 0 ? row.expires_at : latestDeadline(claims);
  }

  /**
   * The relay's word that the round's deadline passed. Unsigned, so it is believed only against what this desktop
   * verified: the current round, the deadline signed for it (the question's, or its latest reopen's), this
   * question's host, and the ledger order. Even then it can only ever close the question with a "not authorised"
   * notice, never approve anything. Its notice records when the signed deadline elapsed, not when the event came.
   */
  private async applyExpired(
    ev: LedgerEvent,
    row: QuestionRow,
    receivedAt: number,
  ): Promise<boolean> {
    // An answer, cancellation or earlier expiry already in force stays in force; a duplicate changes nothing.
    if (row.local_status !== 'open' && row.local_status !== 'queued') return false;
    const d = EventData.expired.safeParse(ev.data);
    if (!d.success) return this.reject(row, 'malformed-event');
    if (ev.question_revision !== row.question_revision)
      return this.reject(row, 'expiry-for-another-round');
    if (row.remote_event_seq !== null && ev.seq <= row.remote_event_seq)
      return this.reject(row, 'stale-expiry');
    if (d.data.target_host_id !== (await hostRef(row.origin.host_id)))
      return this.reject(row, 'expiry-for-another-host');
    const signed = await this.roundDeadline(row);
    if (signed === null) return this.reject(row, 'expiry-without-deadline');
    const deadline = Date.parse(signed);
    // The relay's two clocks, and when this desktop first held the claim (with room for its clock to lag).
    if (
      Date.parse(ev.occurred_at) < deadline ||
      Date.parse(d.data.expired_at) < deadline ||
      receivedAt + EXPIRY_CLOCK_SKEW_MS < deadline
    ) {
      return this.reject(row, 'expiry-before-deadline');
    }
    // Held just before the deadline by this desktop's clock: a clock a little behind the relay's, or a relay that
    // dates its claim ahead. Either way it waits, in ledger order, until the deadline has passed here too.
    if (this.ctx.now() < deadline) throw new TransientError('expiry not yet due');
    const disposition = await this.advisoryDisposition(row);
    const entries = parseAnswers(row.answers_json);
    entries.push({
      entry_id: `expired-${ev.event_id}`,
      kind: 'expired',
      action: 'expire',
      revision: row.question_revision,
      source: 'system',
      ...(disposition ? { advisory_disposition: disposition } : {}),
      correction: false,
      created_at: new Date(deadline).toISOString(),
      event_seq: ev.seq,
      deliver: true,
      delivered: false,
      sealed: null,
    });
    await this.ctx.store.updateQuestion(row.question_id, {
      local_status: 'expired',
      remote_event_seq: ev.seq,
      delivery_status: 'desktop-received',
      answers_json: serializeAnswers(entries),
    });
    await this.ctx.audit.log({
      event: 'question.expired',
      question_id: row.question_id,
      requirement: row.requirement,
      ...(disposition ? { result: `advisory:${disposition}` } : {}),
    });
    this.cb.onQuestionClosed?.(row.question_id);
    return true;
  }

  /**
   * What the verified expiry of `row`'s current round lets its agent be told (protocol section 21), or undefined for an
   * ordinary expiry: a round other than the advisory one, a question asked for a decision, or a host that does not
   * deliver advisory outcomes (its sink may not read the advisory notice). `fallback-due` needs the question's own
   * sealed copy to be advisory at round 0 with a plan, under no workflow gate and with a finite deadline, and the
   * host's trusted policy to allow advice, read again once the content is open; anything less is `fallback-withheld`.
   * The content is opened with the keys already held: the inbox never waits on the relay under the lock.
   */
  private async advisoryDisposition(row: QuestionRow): Promise<AdvisoryDisposition | undefined> {
    if (
      !this.opts.advisoryOutcomes ||
      row.history_only ||
      row.question_revision !== ADVISORY_ROUND_REVISION ||
      replyModeOfRow(row) !== 'advisory'
    )
      return undefined;
    const holds =
      row.origin.workflow_gate_id === null &&
      row.expires_at !== null &&
      !!row.content_sealed &&
      (await advisoryContentHolds(
        { identity: this.ctx.identity },
        row.question_id,
        row.content_sealed,
      ));
    return holds && this.ctx.policy.advisoryQuestions ? 'fallback-due' : 'fallback-withheld';
  }

  /** Runs under ctx.lock with a fresh read of the row, so history appends never clobber delivery bookkeeping. */
  private async applyVerified(
    ev: LedgerEvent,
    v: Extract<VerifiedAnswer, { ok: true }>,
  ): Promise<boolean> {
    const { ctx } = this;
    const row = await ctx.store.getQuestion(v.record.question_id);
    if (!row || row.history_only) return false;
    const entries = parseAnswers(row.answers_json);
    if (entries.some((e) => e.entry_id === v.record.action_id)) return false; // already applied

    // Defence in depth: a proxy must never satisfy human-required, whatever the relay says.
    if (v.provenance === 'proxy' && row.requirement === 'human-required') {
      return this.reject(row, 'proxy-on-human-required', { provenance: 'proxy' });
    }
    const status = protocolStatus(row.local_status);
    if (status === null) return this.reject(row, 'question-not-live');

    // The ONLY source of truth for what an action does: the shared transition table over locally verified
    // state. Stale/losing signed actions fail the revision check here instead of being re-delivered.
    let t;
    try {
      t = applyAction(
        {
          status,
          revision: row.question_revision,
          requirement: row.requirement,
          proxyAbstained: false,
        },
        v.action,
        v.signerRole,
        v.record.expected_revision,
        v.record.decline,
      );
    } catch (e) {
      return this.reject(row, e instanceof ApiError ? `transition:${e.code}` : 'transition:error');
    }
    const declared = EventData.action.safeParse(ev.data).data;
    if (!declared || declared.revision !== t.revision || declared.status !== t.status) {
      return this.reject(row, 'relay-metadata-mismatch');
    }
    if (t.noop) return false;

    const patch: Partial<QuestionRow> = {
      local_status: t.status as QuestionRow['local_status'],
      question_revision: t.revision,
      remote_event_seq: ev.seq,
    };

    switch (v.action) {
      case 'cancel': {
        const dropped = entries.map((e) => (e.delivered ? e : { ...e, deliver: false }));
        // A cancel signed by a phone or tablet, or by the owner desktop with the signed `decline` flag, is the person
        // declining to answer: the agent is told so, plainly, in a content-free notice (never an answer), whichever
        // device it came from. A desktop's withdrawal (an owner cancel without the flag included) tells it nothing.
        const declined = isPersonDecline(v.action, v.signerRole, v.record.decline);
        if (declined) {
          dropped.push({
            entry_id: v.record.action_id,
            kind: 'declined',
            action: 'cancel',
            revision: row.question_revision,
            source: 'human',
            signer_device_id: v.signerDeviceId,
            signer_role: v.signerRole,
            correction: false,
            created_at: v.record.created_at,
            event_seq: ev.seq,
            deliver: true,
            delivered: false,
            sealed: null,
          });
        }
        await ctx.store.updateQuestion(row.question_id, {
          ...patch,
          ...(declined ? { delivery_status: 'desktop-received' as const } : {}),
          answers_json: serializeAnswers(dropped),
          messages_json: withdrawMessages(row.messages_json),
        });
        await ctx.audit.log({
          event: 'question.cancelled',
          question_id: row.question_id,
          result: declined ? 'declined' : 'relay',
        });
        this.cb.onQuestionClosed?.(row.question_id);
        return declined;
      }
      case 'reopen': {
        // A new round: its signed deadline (null: never) replaces the last one, and a closure notice of an earlier
        // round that was not typed yet never will be: the question is open again.
        const answers_json = serializeAnswers(withdrawClosures(entries, t.revision));
        // Best effort: a write it could not release keeps holding the question, never the reopen itself.
        const released = await this.releaseClosureWrites({
          ...row,
          ...patch,
          answers_json,
        } as QuestionRow).catch(() => false);
        await ctx.store.updateQuestion(row.question_id, {
          ...patch,
          expires_at: v.record.expires_at,
          answers_json,
          ...(released ? { delivery_status: 'desktop-received' as const, error_code: null } : {}),
        });
        // Only once the row holds the reopen's deadline does the background pass leave it alone.
        if (!this.reconcileDone) this.reopened.add(row.question_id);
        return false;
      }
      case 'proxy-abstain':
        await ctx.store.updateQuestion(row.question_id, { remote_event_seq: ev.seq });
        await ctx.audit.log({
          event: 'proxy.abstained',
          question_id: row.question_id,
          requirement: row.requirement,
        });
        return false;
      default:
        break;
    }

    // answer / override / proxy-answer / confirm-proxy
    if (v.action === 'confirm-proxy') {
      // A confirmation affirms one specific proxy answer: it must be the one in force here.
      const target = entries
        .filter((e) => e.kind === 'answer' && e.action !== 'confirm-proxy')
        .at(-1);
      if (
        !target ||
        target.action !== 'proxy-answer' ||
        target.entry_id !== v.record.confirms_action_id
      ) {
        return this.reject(row, 'confirms-another-answer');
      }
    }
    const question = await this.content(row);
    if (!question) return this.reject(row, 'question-content-unreadable');
    const opts = question.options ?? [];
    const chosen = v.content?.selected_option_ids ?? [];
    // The answer rules the question was published with (and the gate's, should it have tightened since).
    // confirm-proxy carries no content of its own: it affirms an answer that was already checked.
    const invalid = answerRuleViolation(
      question,
      ctx.policy.get(row.origin.workflow_gate_id),
      chosen,
      v.content?.text ?? '',
      v.action !== 'confirm-proxy',
    );
    if (invalid) {
      await ctx.store.updateQuestion(row.question_id, {
        delivery_status: 'needs-attention',
        error_code: invalid,
      });
      return this.reject(row, invalid.replace(/_/g, '-'));
    }
    // Null provenance is never human: answer-like actions always carry an explicit human/proxy provenance.
    if (v.provenance === null) return this.reject(row, 'missing-provenance');
    // The person's answer, from a phone, a tablet or the owner desktop; which one is kept as the signer's role.
    const human = v.provenance === 'human' || v.provenance === 'human-desktop';
    const labelOf = (id: string) => opts.find((o) => o.id === id)?.label;
    const content: AnswerContent = {
      choices: chosen.map((id) => ({ id, ...(labelOf(id) ? { label: labelOf(id)! } : {}) })),
      text: v.content?.text ?? '',
      reviewed_attachment_digests: v.content?.reviewed_attachment_digests ?? [],
      ...(v.content?.confidence !== undefined ? { confidence: v.content.confidence } : {}),
      ...(v.content?.model_id ? { model_id: v.content.model_id } : {}),
      ...(v.action === 'override' && v.content?.reason?.trim() ? { reason: v.content.reason } : {}),
      // Phone images stay references here, sealed with the words: delivery fetches and checks them, against
      // the ids the phone signed into the record, only when the answer is about to be typed.
      ...(v.content?.images?.length ? { images: v.content.images } : {}),
      ...(v.record.attachment_ids?.length ? { image_ids: v.record.attachment_ids } : {}),
    };
    // Only the sealed form is stored; the clear content lives in memory until it is typed.
    const entry: AnswerEntry = {
      entry_id: v.record.action_id,
      kind: 'answer',
      action: v.action as AnswerEntry['action'],
      revision: t.revision,
      source: human ? 'human' : 'proxy',
      signer_device_id: v.signerDeviceId,
      signer_role: v.signerRole,
      correction: v.action === 'override',
      created_at: v.record.created_at,
      event_seq: ev.seq,
      deliver: t.deliverable,
      delivered: false,
      sealed: await sealAnswerContent(
        ctx,
        row.question_id,
        v.record.action_id,
        t.revision,
        content,
      ),
    };
    entries.push(entry);
    await ctx.store.updateQuestion(row.question_id, {
      ...patch,
      delivery_status: entry.deliver ? 'desktop-received' : row.delivery_status,
      error_code: null,
      answers_json: serializeAnswers(entries),
    });
    await ctx.audit.log({
      event: entry.deliver ? 'answer.received' : 'answer.confirmed',
      question_id: row.question_id,
      requirement: row.requirement,
      provenance: v.provenance,
      result: 'verified',
    });
    if (human && (v.action === 'answer' || v.action === 'override')) {
      await this.learn(row, question, content, entry);
    }
    return entry.deliver;
  }

  /**
   * Store one verified thread message with its question. Runs under ctx.lock with a fresh read of the row. A
   * message never answers: it leaves the status, the revision, the answers and their delivery state, the gate
   * and the decision model's history exactly as they were. Only the person's messages are delivered; the agent's
   * own are kept for `get_decision`. True when a human message now waits for the pane.
   */
  private async applyMessage(ev: LedgerEvent, v: VerifiedMessage): Promise<boolean> {
    const { ctx } = this;
    const { record, envelope } = v.entry;
    const row = await ctx.store.getQuestion(record.question_id);
    if (!row || row.history_only) return false;
    const messages = parseMessages(row.messages_json);
    const prior = messages.find((m) => m.message_id === record.message_id);
    if (prior) {
      // A replay of the same message is harmless; the same id with other content is not the same message.
      return prior.envelope_digest === record.envelope_digest
        ? false
        : this.reject(row, 'message-id-reused');
    }
    // Events apply in ledger order, so this is the state the relay committed the message against.
    const status = protocolStatus(row.local_status);
    if (status === null || isThreadClosedStatus(status)) return this.reject(row, 'thread-closed');
    const human = record.side === 'human';
    const message: StoredMessage = {
      message_id: record.message_id,
      message_seq: v.entry.message_seq,
      event_seq: ev.seq,
      side: record.side,
      expects_reply: record.expects_reply,
      signer_device_id: record.signer_device_id,
      signer_role: v.signerRole,
      attachment_ids: [...record.attachment_ids],
      created_at: record.created_at,
      committed_at: v.entry.committed_at,
      envelope_digest: record.envelope_digest,
      // Stored as the relay holds it: ciphertext under the installation's epoch key, opened only to type or show.
      sealed: JSON.stringify(envelope),
      target_host_id: v.targetHostId,
      delivery: human
        ? {
            status: 'received',
            deliver: true,
            received_at: new Date(ctx.now()).toISOString(),
            terminal_delivered_at: null,
            injection_id: null,
            error_code: null,
            reported: null,
          }
        : null,
    };
    messages.push(message);
    messages.sort((a, b) => a.event_seq - b.event_seq);
    await ctx.store.updateQuestion(row.question_id, { messages_json: serializeMessages(messages) });
    await ctx.audit.log({
      event: 'message.received',
      question_id: row.question_id,
      requirement: row.requirement,
      result: record.side,
    });
    return human;
  }

  /**
   * Hand a human decision to the decision model's history, the only place plaintext may be kept, and only
   * when the host wired a learner (which records nothing unless the user opted into learning). Proxy answers
   * and confirmations of them are never ground truth. A failing learner never blocks delivery.
   */
  private async learn(
    row: QuestionRow,
    question: Partial<DecisionContentV1>,
    content: AnswerContent,
    entry: AnswerEntry,
  ): Promise<void> {
    const learner = this.ctx.learner;
    if (!learner || typeof question.question !== 'string') return;
    try {
      await learner.learn({
        questionId: row.question_id,
        question: question.question,
        ...(question.context ? { context: question.context } : {}),
        options: (question.options ?? []).map((o) => ({ id: o.id, label: o.label })),
        kind: question.kind ?? 'mixed',
        requirement: row.requirement,
        projectId: row.origin.project_id,
        createdAt: row.origin_created_at,
        chosenAt: entry.created_at,
        selectedOptionIds: content.choices.map((c) => c.id),
        text: content.text,
        revision: entry.revision,
        correction: entry.correction,
      });
    } catch (e) {
      await this.ctx.audit.log({
        event: 'learning.failed',
        question_id: row.question_id,
        result: ((e as Error)?.name ?? 'error').slice(0, 40),
      });
    }
  }
}
