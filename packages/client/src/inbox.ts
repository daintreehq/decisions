import {
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
  serializeAnswers,
  type AnswerContent,
  type AnswerEntry,
} from './answers.js';
import { openQuestionContent, sealAnswerContent } from './at-rest.js';
import { hostRef, type BridgeContext } from './context.js';
import {
  EVENT_ACTION,
  revokedKey,
  type EventVerifier,
  type VerifiedAnswer,
  type VerifiedMessage,
} from './inbound.js';
import { parseMessages, serializeMessages, type StoredMessage } from './messages.js';
import { Mutex, TransientError } from './mutex.js';
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

/** How far this desktop's clock may lag the relay's before an expiry it holds is taken as early. */
export const EXPIRY_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * A transiently failing event is given up on (consumed with an error) only after this many attempts AND this long
 * since its first failure. Attempts come as fast as events arrive, so a count alone would let a short outage
 * (a relay restart, a rate limit) discard a valid answer.
 */
const MAX_TRANSIENT_ATTEMPTS = 5;
const MIN_TRANSIENT_WINDOW_MS = 10 * 60_000;

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
 * they never reach a terminal. Transient failures leave the event unprocessed so it is retried in order.
 */
export class Inbox {
  private readonly serial = new Mutex();
  private readonly transientAttempts = new Map<number, { n: number; since: number }>();
  /** Rows written before reopens kept their deadline are reconciled once per run, before any event applies. */
  private reconciled = false;

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
      if (!this.reconciled) {
        try {
          await this.reconcileRounds();
          this.reconciled = true;
        } catch (e) {
          // A directory that cannot be read now is tried again on the next pass; anything else on the next start.
          if (!(e instanceof TransientError)) this.reconciled = true;
          await this.ctx.audit.log({
            event: 'rounds.unreconciled',
            result: (e as Error).message.slice(0, 80),
          });
        }
      }
      for (;;) {
        const cursor = await this.ctx.store.getCursor();
        const batch = (await this.ctx.store.unprocessedEvents(50)).filter((e) => e.seq <= cursor);
        if (batch.length === 0) return drain;
        for (const stored of batch) {
          const ev = JSON.parse(stored.json) as LedgerEvent;
          try {
            if (await this.apply(ev, stored.received_at)) drain = true;
          } catch (e) {
            if (e instanceof TransientError) {
              const prev = this.transientAttempts.get(ev.seq);
              const a = { n: (prev?.n ?? 0) + 1, since: prev?.since ?? this.ctx.now() };
              this.transientAttempts.set(ev.seq, a);
              if (
                a.n < MAX_TRANSIENT_ATTEMPTS ||
                this.ctx.now() - a.since < MIN_TRANSIENT_WINDOW_MS
              ) {
                // Leave it unprocessed and stop: later events must not overtake it.
                await this.ctx.audit.log({
                  event: 'event.deferred',
                  result: e.message.slice(0, 80),
                });
                return drain;
              }
            }
            await this.ctx.audit.log({
              event: 'event.error',
              result: (e as Error).message.slice(0, 80),
            });
          }
          this.transientAttempts.delete(ev.seq);
          await this.ctx.store.markEventProcessed(stored.seq, this.ctx.now());
        }
      }
    });
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
          if (row.local_status === 'queued') patch.local_status = 'open';
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
   * Apply a verified reopen once no closure notice of the question is being written to its terminal. The check and
   * the apply share the lock delivery admits a write under, so a notice is either admitted first (and the reopen
   * waits for the sink's answer, outside the lock) or finds itself withdrawn.
   */
  private async afterClosureWrites(
    questionId: string,
    ev: LedgerEvent,
    v: Extract<VerifiedAnswer, { ok: true }>,
  ): Promise<boolean> {
    for (;;) {
      const r = await this.ctx.lock.run(async () => {
        const writing = this.cb.closureWrite?.(questionId);
        return writing ? { writing } : { applied: await this.applyVerified(ev, v) };
      });
      if ('applied' in r) return r.applied;
      await r.writing.catch(() => undefined);
    }
  }

  /**
   * A bridge before this one stored a reopen's status and revision but kept the previous round's deadline. For each
   * open question in a reopened round, take the deadline from the one verified reopen that started that round in
   * the stored history. Nothing is guessed: no such reopen, or more than one, leaves the row as it is.
   */
  private async reconcileRounds(): Promise<void> {
    const { ctx } = this;
    if (!ctx.store.processedEventsOfType) return;
    const rows = (await ctx.store.listQuestions()).filter(
      (q) => !q.history_only && q.local_status === 'open' && q.question_revision > 0,
    );
    if (rows.length === 0) return;
    const reopens = (await ctx.store.processedEventsOfType('decision.reopened')).map(
      (e) => JSON.parse(e.json) as LedgerEvent,
    );
    for (const row of rows) {
      const into = reopens.filter(
        (ev) => ev.question_id === row.question_id && ev.question_revision === row.question_revision,
      );
      const claimed = into.map((ev) => EventData.action.safeParse(ev.data).data?.record.expires_at);
      // The usual case once reopens keep their deadline: nothing differs, so nothing is verified.
      if (claimed.every((d) => d === row.expires_at)) continue;
      const verified: (string | null)[] = [];
      for (const ev of into) {
        const v = await this.verifier.verifyAction(ev); // may throw TransientError: retried on the next pass
        const declared = EventData.action.safeParse(ev.data).data;
        if (
          v.ok &&
          v.action === 'reopen' &&
          v.record.expected_revision === row.question_revision - 1 &&
          declared?.revision === row.question_revision &&
          declared.status === 'open'
        ) {
          verified.push(v.record.expires_at);
        }
      }
      if (verified.length !== 1) {
        if (verified.length > 1)
          await ctx.audit.log({ event: 'round.ambiguous', question_id: row.question_id });
        continue;
      }
      const deadline = verified[0]!;
      if (deadline === row.expires_at) continue;
      await ctx.lock.run(async () => {
        const fresh = await ctx.store.getQuestion(row.question_id);
        if (
          !fresh ||
          fresh.local_status !== 'open' ||
          fresh.question_revision !== row.question_revision
        ) {
          return;
        }
        await ctx.store.updateQuestion(row.question_id, { expires_at: deadline });
        await ctx.audit.log({ event: 'round.reconciled', question_id: row.question_id });
      });
    }
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
    if (row.expires_at === null) return this.reject(row, 'expiry-without-deadline');
    const deadline = Date.parse(row.expires_at);
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
    const entries = parseAnswers(row.answers_json);
    entries.push({
      entry_id: `expired-${ev.event_id}`,
      kind: 'expired',
      action: 'expire',
      revision: row.question_revision,
      source: 'system',
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
    });
    this.cb.onQuestionClosed?.(row.question_id);
    return true;
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
      case 'reopen':
        // A new round: its signed deadline (null: never) replaces the last one, and a closure notice of an earlier
        // round that was not typed yet never will be: the question is open again.
        await ctx.store.updateQuestion(row.question_id, {
          ...patch,
          expires_at: v.record.expires_at,
          answers_json: serializeAnswers(withdrawClosures(entries, t.revision)),
        });
        return false;
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
