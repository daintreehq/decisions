import {
  ApiError,
  EventData,
  applyAction,
  type DecisionContentV1,
  type LedgerEvent,
  type QuestionStatus,
} from '@daintreehq/decisions-protocol';
import { parseAnswers, serializeAnswers, type AnswerContent, type AnswerEntry } from './answers.js';
import { openQuestionContent, sealAnswerContent } from './at-rest.js';
import type { BridgeContext } from './context.js';
import { EVENT_ACTION, revokedKey, type EventVerifier, type VerifiedAnswer } from './inbound.js';
import { Mutex, TransientError } from './mutex.js';
import { gateAllowsText } from './policy.js';
import type { QuestionRow } from './types.js';

export interface InboxCallbacks {
  /** This device was revoked: stop all delivery. */
  onRevokedSelf(): void;
}

const MAX_TRANSIENT_ATTEMPTS = 5;

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
  private readonly transientAttempts = new Map<number, number>();

  constructor(
    private readonly ctx: BridgeContext,
    private readonly verifier: EventVerifier,
    private readonly cb: InboxCallbacks,
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
      for (;;) {
        const cursor = await this.ctx.store.getCursor();
        const batch = (await this.ctx.store.unprocessedEvents(50)).filter((e) => e.seq <= cursor);
        if (batch.length === 0) return drain;
        for (const stored of batch) {
          const ev = JSON.parse(stored.json) as LedgerEvent;
          try {
            if (await this.apply(ev)) drain = true;
          } catch (e) {
            if (e instanceof TransientError) {
              const n = (this.transientAttempts.get(ev.seq) ?? 0) + 1;
              this.transientAttempts.set(ev.seq, n);
              if (n < MAX_TRANSIENT_ATTEMPTS) {
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

  private async apply(ev: LedgerEvent): Promise<boolean> {
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
          }
        }
        this.verifier.invalidate();
        await ctx.refreshIdentity?.();
        return false;
      }
      case 'device.approved':
        this.verifier.invalidate();
        return false;
      case 'device.key_rotated':
        this.verifier.invalidate();
        await ctx.refreshIdentity?.();
        return false;
      default:
        break;
    }
    if (!ev.question_id) return false;
    const peek = await ctx.store.getQuestion(ev.question_id);
    if (!peek || peek.history_only) return false; // not ours (or imported history): never act on it

    if (EVENT_ACTION[ev.event_type]) {
      const v = await this.verifier.verifyAction(ev); // may throw TransientError; no lock held across the network
      if (!v.ok) return this.reject(peek, v.reason);
      return ctx.lock.run(() => this.applyVerified(ev, v));
    }
    return ctx.lock.run(async () => {
      const row = await ctx.store.getQuestion(ev.question_id!);
      if (!row) return false;
      switch (ev.event_type) {
        case 'decision.created': {
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
          });
          return false;
        }
        case 'decision.expired':
          return this.applyExpired(ev, row);
        default:
          return false;
      }
    });
  }

  private async applyExpired(ev: LedgerEvent, row: QuestionRow): Promise<boolean> {
    // Relay-asserted and unsigned: it can only ever result in a "not authorised" notice, never an approval.
    if (row.local_status !== 'open' && row.local_status !== 'queued') return false;
    const entries = parseAnswers(row.answers_json);
    entries.push({
      entry_id: `expired-${ev.event_id}`,
      kind: 'expired',
      action: 'expire',
      revision: row.question_revision,
      source: 'system',
      correction: false,
      created_at: new Date(this.ctx.now()).toISOString(),
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
        await ctx.store.updateQuestion(row.question_id, {
          ...patch,
          answers_json: serializeAnswers(dropped),
        });
        await ctx.audit.log({
          event: 'question.cancelled',
          question_id: row.question_id,
          result: 'relay',
        });
        return false;
      }
      case 'reopen':
        await ctx.store.updateQuestion(row.question_id, patch);
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
    const allow_text = question.allow_text !== false;
    const chosen = v.content?.selected_option_ids ?? [];
    const text = v.content?.text ?? '';
    const gate = ctx.policy.get(row.origin.workflow_gate_id);
    const bad = chosen.find(
      (id) =>
        (opts.length > 0 && !opts.some((o) => o.id === id)) ||
        (gate?.allowedOptionIds && !gate.allowedOptionIds.includes(id)) ||
        (gate?.choices && !gate.choices.some((c) => c.id === id)),
    );
    // The answer rules the question was published with (and the gate's, should it have tightened since).
    // confirm-proxy carries no content of its own: it affirms an answer that was already checked.
    const ruled = v.action !== 'confirm-proxy';
    const textAllowed = allow_text && gateAllowsText(gate);
    const invalid =
      bad !== undefined
        ? 'unknown_option'
        : ruled && gate?.choices && chosen.length > 1
          ? 'too_many_choices'
          : ruled && text.trim() !== '' && !textAllowed
            ? 'text_not_allowed'
            : ruled && !textAllowed && chosen.length === 0
              ? 'choice_required'
              : null;
    if (invalid) {
      await ctx.store.updateQuestion(row.question_id, {
        delivery_status: 'needs-attention',
        error_code: invalid,
      });
      return this.reject(row, invalid.replace(/_/g, '-'));
    }
    // Null provenance is never human: answer-like actions always carry an explicit human/proxy provenance.
    if (v.provenance === null) return this.reject(row, 'missing-provenance');
    const labelOf = (id: string) => opts.find((o) => o.id === id)?.label;
    const content: AnswerContent = {
      choices: chosen.map((id) => ({ id, ...(labelOf(id) ? { label: labelOf(id)! } : {}) })),
      text: v.content?.text ?? '',
      reviewed_attachment_digests: v.content?.reviewed_attachment_digests ?? [],
      ...(v.content?.confidence !== undefined ? { confidence: v.content.confidence } : {}),
      ...(v.content?.model_id ? { model_id: v.content.model_id } : {}),
    };
    // Only the sealed form is stored; the clear content lives in memory until it is typed.
    const entry: AnswerEntry = {
      entry_id: v.record.action_id,
      kind: 'answer',
      action: v.action as AnswerEntry['action'],
      revision: t.revision,
      source: v.provenance,
      correction: v.action === 'override',
      created_at: v.record.created_at,
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
      provenance: entry.source,
      result: 'verified',
    });
    if (v.provenance === 'human' && (v.action === 'answer' || v.action === 'override')) {
      await this.learn(row, question, content, entry);
    }
    return entry.deliver;
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
