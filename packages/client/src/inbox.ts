import { EventData, type DecisionContentV1, type LedgerEvent } from '@daintree/decisions-protocol';
import { parseAnswers, serializeAnswers, type AnswerEntry } from './answers.js';
import type { BridgeContext } from './context.js';
import type { EventVerifier } from './inbound.js';
import type { QuestionRow } from './types.js';

export interface InboxCallbacks {
  /** This device was revoked: stop all delivery. */
  onRevokedSelf(): void;
}

/**
 * Persists ledger events BEFORE anything is acknowledged, then verifies and applies them in seq order.
 * Unverifiable events are rejected and audited; they never reach a terminal.
 */
export class Inbox {
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

  /** Apply every stored-but-unprocessed event in order. Returns true if any delivery may now be pending. */
  async processPending(): Promise<boolean> {
    let drain = false;
    for (;;) {
      const batch = await this.ctx.store.unprocessedEvents(50);
      if (batch.length === 0) return drain;
      for (const stored of batch) {
        const ev = JSON.parse(stored.json) as LedgerEvent;
        try {
          if (await this.apply(ev)) drain = true;
        } catch (e) {
          await this.ctx.audit.log({
            event: 'event.error',
            result: (e as Error).message.slice(0, 80),
          });
        }
        await this.ctx.store.markEventProcessed(stored.seq, this.ctx.now());
      }
    }
  }

  private options(row: QuestionRow): DecisionContentV1['options'] {
    try {
      return (JSON.parse(row.content_json ?? '{}') as DecisionContentV1).options ?? [];
    } catch {
      return [];
    }
  }

  private async save(
    row: QuestionRow,
    patch: Partial<QuestionRow>,
    entries: AnswerEntry[],
  ): Promise<void> {
    await this.ctx.store.updateQuestion(row.question_id, {
      ...patch,
      answers_json: serializeAnswers(entries),
    });
  }

  private async apply(ev: LedgerEvent): Promise<boolean> {
    const { ctx } = this;
    switch (ev.event_type) {
      case 'device.revoked': {
        const d = EventData.deviceRevoked.safeParse(ev.data);
        this.verifier.invalidate();
        if (d.success && d.data.device_id === ctx.identity.config.deviceId) {
          await ctx.audit.log({ event: 'device.revoked-self' });
          this.cb.onRevokedSelf();
        }
        return false;
      }
      case 'device.approved':
      case 'device.key_rotated':
        this.verifier.invalidate();
        return false;
      default:
        break;
    }
    if (!ev.question_id) return false;
    const row = await ctx.store.getQuestion(ev.question_id);
    if (!row || row.history_only) return false; // not ours (or imported history): never act on it

    switch (ev.event_type) {
      case 'decision.created': {
        const patch: Partial<QuestionRow> = { remote_event_seq: ev.seq };
        if (row.local_status === 'queued') patch.local_status = 'open';
        await ctx.store.updateQuestion(row.question_id, patch);
        return false;
      }
      case 'decision.answer.committed':
      case 'decision.answer.overridden':
      case 'decision.proxy.committed':
      case 'decision.proxy.confirmed':
        return this.applyAnswer(ev, row);
      case 'decision.proxy.abstained':
        await ctx.audit.log({
          event: 'proxy.abstained',
          question_id: row.question_id,
          requirement: row.requirement,
        });
        return false;
      case 'decision.cancelled': {
        const entries = parseAnswers(row.answers_json).map((e) =>
          e.delivered ? e : { ...e, deliver: false },
        );
        await this.save(row, { local_status: 'cancelled', remote_event_seq: ev.seq }, entries);
        await ctx.audit.log({
          event: 'question.cancelled',
          question_id: row.question_id,
          result: 'relay',
        });
        return false;
      }
      case 'decision.deleted': {
        const entries = parseAnswers(row.answers_json).map((e) => ({ ...e, deliver: false }));
        await this.save(row, { local_status: 'cancelled', remote_event_seq: ev.seq }, entries);
        return false;
      }
      case 'decision.reopened': {
        const rev =
          typeof ev.question_revision === 'number' ? ev.question_revision : row.question_revision;
        await ctx.store.updateQuestion(row.question_id, {
          local_status: 'open',
          question_revision: rev,
          remote_event_seq: ev.seq,
        });
        return false;
      }
      case 'decision.expired':
        return this.applyExpired(ev, row);
      default:
        return false;
    }
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
      choices: [],
      text: '',
      reviewed_attachment_digests: [],
      correction: false,
      created_at: new Date(this.ctx.now()).toISOString(),
      deliver: true,
      delivered: false,
    });
    await this.save(
      row,
      { local_status: 'expired', remote_event_seq: ev.seq, delivery_status: 'desktop-received' },
      entries,
    );
    await this.ctx.audit.log({
      event: 'question.expired',
      question_id: row.question_id,
      requirement: row.requirement,
    });
    return true;
  }

  private async applyAnswer(ev: LedgerEvent, row: QuestionRow): Promise<boolean> {
    const { ctx } = this;
    const v = await this.verifier.verifyAction(ev);
    if (!v.ok) {
      await ctx.audit.log({
        event: 'event.rejected',
        question_id: row.question_id,
        requirement: row.requirement,
        result: v.reason,
      });
      return false;
    }
    const entries = parseAnswers(row.answers_json);
    if (entries.some((e) => e.entry_id === v.record.action_id)) return false; // duplicate delivery of the same event
    // Defence in depth: the relay should refuse this, but a proxy must never satisfy human-required.
    if (v.provenance === 'proxy' && row.requirement === 'human-required') {
      await ctx.audit.log({
        event: 'event.rejected',
        question_id: row.question_id,
        requirement: row.requirement,
        provenance: 'proxy',
        result: 'proxy-on-human-required',
      });
      return false;
    }
    const newRevision = v.record.expected_revision + 1;
    const opts = this.options(row);
    const chosen = v.content?.selected_option_ids ?? [];
    const gate = ctx.policy.get(row.origin.workflow_gate_id);
    const bad = chosen.find(
      (id) =>
        (opts.length > 0 && !opts.some((o) => o.id === id)) ||
        (gate?.allowedOptionIds && !gate.allowedOptionIds.includes(id)),
    );
    if (bad !== undefined) {
      await ctx.audit.log({
        event: 'event.rejected',
        question_id: row.question_id,
        requirement: row.requirement,
        result: 'unknown-option',
      });
      await ctx.store.updateQuestion(row.question_id, {
        delivery_status: 'needs-attention',
        error_code: 'unknown_option',
      });
      return false;
    }
    const entry: AnswerEntry = {
      entry_id: v.record.action_id,
      kind: 'answer',
      action:
        v.action === 'answer' ||
        v.action === 'override' ||
        v.action === 'proxy-answer' ||
        v.action === 'confirm-proxy'
          ? v.action
          : 'answer',
      revision: newRevision,
      source: v.provenance ?? 'human',
      choices: chosen.map((id) => ({
        id,
        ...(opts.find((o) => o.id === id)?.label
          ? { label: opts.find((o) => o.id === id)!.label }
          : {}),
      })),
      text: v.content?.text ?? '',
      reviewed_attachment_digests: v.content?.reviewed_attachment_digests ?? [],
      correction: v.action === 'override',
      ...(v.content?.confidence !== undefined ? { confidence: v.content.confidence } : {}),
      ...(v.content?.model_id ? { model_id: v.content.model_id } : {}),
      created_at: v.record.created_at,
      // Confirmations are logged only; everything else must reach the agent.
      deliver: v.action !== 'confirm-proxy',
      delivered: false,
    };
    entries.push(entry);
    const status = (EventData.action.safeParse(ev.data).data?.status ??
      row.local_status) as QuestionRow['local_status'];
    await this.save(
      row,
      {
        local_status: status,
        question_revision: Math.max(row.question_revision, newRevision),
        remote_event_seq: ev.seq,
        delivery_status: entry.deliver ? 'desktop-received' : row.delivery_status,
        error_code: null,
      },
      entries,
    );
    await ctx.audit.log({
      event: entry.deliver ? 'answer.received' : 'answer.confirmed',
      question_id: row.question_id,
      requirement: row.requirement,
      provenance: entry.source,
      result: 'verified',
    });
    return entry.deliver;
  }
}
