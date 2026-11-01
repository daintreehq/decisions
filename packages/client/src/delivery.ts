import { batchNotices, formatAnswerNotice } from './notice.js';
import { parseAnswers, serializeAnswers, type AnswerEntry } from './answers.js';
import type { BridgeContext } from './context.js';
import { hostRef } from './context.js';
import { newId } from '@daintree/decisions-crypto';
import { pickResumeAdapter, unsupportedResumeAdapter } from './resume.js';
import type { AgentResumeAdapter, TerminalSink, TerminalTarget } from './sink.js';
import type { InjectionIntent, LocalDeliveryStatus, QuestionOrigin, QuestionRow } from './types.js';

export interface DeliveryOptions {
  sink: TerminalSink;
  adapters?: AgentResumeAdapter[];
  /** Combine several pending notices for one pane into a single typed chunk. Default true. */
  batch?: boolean;
  maxBatchBytes?: number;
}

export interface DrainResult {
  delivered: number;
  /** Panes that were busy or whose host was offline: call drain() again later. */
  deferred: number;
  needsAttention: number;
}

interface Item {
  q: QuestionRow;
  entry: AnswerEntry;
  intentId: string;
}

export class DeliveryEngine {
  private running: Promise<DrainResult> | null = null;
  private again = false;
  stopped = false;

  constructor(
    private readonly ctx: BridgeContext,
    private readonly o: DeliveryOptions,
  ) {}

  /** Serialised: concurrent callers share one pass plus at most one follow-up pass. */
  async drain(): Promise<DrainResult> {
    if (this.stopped) return { delivered: 0, deferred: 0, needsAttention: 0 };
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      const total: DrainResult = { delivered: 0, deferred: 0, needsAttention: 0 };
      try {
        do {
          this.again = false;
          const r = await this.pass();
          total.delivered += r.delivered;
          total.deferred = r.deferred;
          total.needsAttention += r.needsAttention;
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
      return total;
    })();
    return this.running;
  }

  private pending(q: QuestionRow): AnswerEntry[] {
    return parseAnswers(q.answers_json)
      .filter((e) => e.deliver && !e.delivered)
      .sort((a, b) => a.revision - b.revision);
  }

  private async pass(): Promise<DrainResult> {
    const { ctx } = this;
    const out: DrainResult = { delivered: 0, deferred: 0, needsAttention: 0 };
    await this.flushAcks();
    const all = (await ctx.store.listQuestions()).filter(
      (q) =>
        !q.history_only &&
        this.pending(q).length > 0 &&
        q.delivery_status !== 'needs-attention' &&
        q.delivery_status !== 'delivery-uncertain',
    );
    // One lane per pane: answers go in question-creation order (alias is monotonic).
    const lanes = new Map<string, QuestionRow[]>();
    for (const q of all) {
      const k = `${q.origin.host_id}\u0000${q.origin.pane_id}`;
      (lanes.get(k) ?? lanes.set(k, []).get(k)!).push(q);
    }
    for (const qs of lanes.values()) {
      if (this.stopped) break;
      qs.sort((a, b) => a.alias - b.alias);
      const r = await this.laneDeliver(qs);
      out.delivered += r.delivered;
      out.deferred += r.deferred;
      out.needsAttention += r.needsAttention;
    }
    return out;
  }

  private async resolveTarget(
    q: QuestionRow,
  ): Promise<{ target: TerminalTarget } | { defer: true } | { attention: string }> {
    const { o } = this;
    const loc = await o.sink.locate(q.origin);
    switch (loc.state) {
      case 'alive':
        return loc.target ? { target: loc.target } : { attention: 'no_target' };
      case 'host-offline':
        await this.setStatus(q, 'pending-host');
        return { defer: true };
      case 'generation-mismatch':
        return { attention: 'generation_mismatch' };
      case 'gone':
      case 'session-mismatch': {
        const adapter =
          pickResumeAdapter(o.adapters ?? [], q.origin) ??
          unsupportedResumeAdapter(q.origin.agent_kind);
        const probe = await adapter.probe(q.origin.host_id);
        if (probe.supported && (await adapter.canResume(q.origin))) {
          const r = await adapter.resume(q.origin);
          if (r.ready) return this.adopt(q, r.target, `adapter:${adapter.kind}`);
        } else if (o.sink.resume) {
          const t = await o.sink.resume(q.origin);
          if (t) return this.adopt(q, t, 'sink');
        }
        return { attention: loc.state === 'gone' ? 'pane_gone' : 'session_mismatch' };
      }
    }
  }

  private async adopt(q: QuestionRow, target: TerminalTarget, strategy: string) {
    const origin: QuestionOrigin = {
      ...q.origin,
      host_id: target.hostId,
      pane_id: target.paneId,
      terminal_generation: target.terminalGeneration,
      agent_session_id: target.agentSessionId,
    };
    await this.ctx.store.updateQuestion(q.question_id, { origin, agent_resume_strategy: strategy });
    await this.ctx.audit.log({
      event: 'agent.resumed',
      question_id: q.question_id,
      result: strategy,
    });
    q.origin = origin;
    return { target };
  }

  private async laneDeliver(qs: QuestionRow[]): Promise<DrainResult> {
    const { ctx, o } = this;
    const res: DrainResult = { delivered: 0, deferred: 0, needsAttention: 0 };
    let target: TerminalTarget | null = null;
    const items: Item[] = [];
    for (const q of qs) {
      const r = await this.resolveTarget(q);
      if ('defer' in r) {
        res.deferred++;
        break; // preserve ordering: nothing later in the lane may overtake
      }
      if ('attention' in r) {
        await this.attention(q, r.attention, 'needs-attention');
        res.needsAttention++;
        continue;
      }
      if (
        target &&
        (target.paneId !== r.target.paneId ||
          target.terminalGeneration !== r.target.terminalGeneration)
      ) {
        break; // a resumed pane differs; handle on the next pass
      }
      target = r.target;
      for (const entry of this.pending(q)) items.push({ q, entry, intentId: newId(ctx.now()) });
    }
    if (!target || items.length === 0) return res;
    if (!(await o.sink.isIdle(target))) {
      res.deferred++;
      return res;
    }
    const chunks = o.batch === false ? items.map((i) => [i]) : this.chunk(items);
    for (const chunk of chunks) {
      if (this.stopped) break;
      const r = await this.injectChunk(target, chunk);
      if (r === 'ok') res.delivered += chunk.length;
      else if (r === 'busy') {
        res.deferred++;
        break;
      } else {
        res.needsAttention += chunk.length;
        break;
      }
    }
    return res;
  }

  private chunk(items: Item[]): Item[][] {
    const blocks = items.map((i) => this.block(i));
    const texts = batchNotices(blocks, this.o.maxBatchBytes);
    // Map chunk texts back to item groups by counting blocks per text.
    const groups: Item[][] = [];
    let idx = 0;
    for (const t of texts) {
      const n = t.split('[DAINTREE DECISION ANSWER]').length - 1;
      groups.push(items.slice(idx, idx + n));
      idx += n;
    }
    return groups;
  }

  private block(i: Item): string {
    const e = i.entry;
    return formatAnswerNotice({
      kind: e.kind,
      questionId: i.q.question_id,
      alias: i.q.alias,
      revision: e.revision,
      source: e.source === 'proxy' ? 'proxy' : 'human',
      choices: e.choices,
      comment: e.text,
      correction: e.correction,
      ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
      ...(e.model_id ? { modelId: e.model_id } : {}),
      injectionId: i.intentId,
    });
  }

  private async injectChunk(
    target: TerminalTarget,
    chunk: Item[],
  ): Promise<'ok' | 'busy' | 'failed'> {
    const { ctx, o } = this;
    const text = batchNotices(
      chunk.map((i) => this.block(i)),
      Number.MAX_SAFE_INTEGER,
    )[0]!;
    const now = ctx.now();
    // 1. Persist the intent BEFORE touching the terminal.
    for (const i of chunk) {
      await ctx.store.putIntent({
        injection_id: i.intentId,
        question_id: i.q.question_id,
        answer_revision: i.entry.revision,
        host_id: target.hostId,
        pane_id: target.paneId,
        terminal_generation: target.terminalGeneration,
        state: 'intent',
        created_at: now,
        updated_at: now,
      });
      await ctx.store.updateQuestion(i.q.question_id, {
        last_injection_id: i.intentId,
        last_attempt_at: new Date(now).toISOString(),
      });
    }
    let result;
    try {
      result = await o.sink.inject(target, text, chunk[0]!.intentId);
    } catch (e) {
      // The terminal may or may not have received the text: never retry blindly.
      for (const i of chunk) {
        await ctx.store.updateIntent(i.intentId, { state: 'uncertain', updated_at: ctx.now() });
        await this.attention(i.q, 'inject_threw', 'delivery-uncertain');
      }
      await ctx.audit.log({ event: 'inject.threw', result: (e as Error).message.slice(0, 80) });
      return 'failed';
    }
    if (!result.ok) {
      for (const i of chunk)
        await ctx.store.updateIntent(i.intentId, { state: 'abandoned', updated_at: ctx.now() });
      if (result.reason === 'busy') return 'busy';
      for (const i of chunk)
        await this.attention(i.q, result.reason ?? 'inject_failed', 'needs-attention');
      return 'failed';
    }
    for (const i of chunk) {
      await ctx.store.updateIntent(i.intentId, { state: 'typed', updated_at: ctx.now() });
      await this.markDelivered(i.q.question_id, i.entry.entry_id, i.intentId, i.entry.revision);
      await this.ack(i.intentId);
    }
    return 'ok';
  }

  private async markDelivered(
    questionId: string,
    entryId: string,
    injectionId: string,
    revision: number,
  ): Promise<void> {
    const q = await this.ctx.store.getQuestion(questionId);
    if (!q) return;
    const entries = parseAnswers(q.answers_json).map((e) =>
      e.entry_id === entryId ? { ...e, delivered: true, injection_id: injectionId } : e,
    );
    const stillPending = entries.some((e) => e.deliver && !e.delivered);
    await this.ctx.store.updateQuestion(questionId, {
      answers_json: serializeAnswers(entries),
      delivered_revision: Math.max(q.delivered_revision, revision),
      delivery_status: stillPending ? q.delivery_status : 'terminal-delivered',
      last_injection_id: injectionId,
      error_code: null,
    });
    await this.ctx.audit.log({
      event: 'answer.delivered',
      question_id: questionId,
      requirement: q.requirement,
      result: 'typed',
    });
  }

  /** Tell the relay the text was really typed. Retried by flushAcks until it sticks. */
  private async ack(injectionId: string): Promise<void> {
    const { ctx } = this;
    const intent = await ctx.store.getIntent(injectionId);
    if (!intent) return;
    const q = await ctx.store.getQuestion(intent.question_id);
    if (!q) return;
    if (intent.answer_revision < 1) {
      await ctx.store.updateIntent(injectionId, { state: 'acked', updated_at: ctx.now() });
      return;
    }
    try {
      await ctx.client.deliveriesTerminal({
        idempotency_key: injectionId.slice(0, 64),
        question_id: intent.question_id,
        answer_revision: intent.answer_revision,
        injection_id: injectionId,
        host_id: await hostRef(intent.host_id),
      });
      await ctx.store.updateIntent(injectionId, { state: 'acked', updated_at: ctx.now() });
    } catch {
      /* stays 'typed'; flushAcks retries it */
    }
  }

  private async flushAcks(): Promise<void> {
    for (const i of await this.ctx.store.openIntents()) {
      if (i.state === 'typed') await this.ack(i.injection_id);
    }
  }

  private async setStatus(q: QuestionRow, s: LocalDeliveryStatus): Promise<void> {
    if (q.delivery_status !== s)
      await this.ctx.store.updateQuestion(q.question_id, { delivery_status: s });
  }

  private async attention(
    q: QuestionRow,
    code: string,
    status: 'needs-attention' | 'delivery-uncertain',
  ): Promise<void> {
    const { ctx } = this;
    await ctx.store.updateQuestion(q.question_id, { delivery_status: status, error_code: code });
    await ctx.audit.log({
      event: 'delivery.attention',
      question_id: q.question_id,
      requirement: q.requirement,
      result: code,
    });
    const rev = Math.max(1, ...this.pending(q).map((e) => e.revision), q.question_revision);
    try {
      await ctx.client.deliveriesFailed({
        idempotency_key: `fail-${q.question_id}-${rev}-${code}`.slice(0, 64),
        question_id: q.question_id,
        answer_revision: rev,
        host_id: await hostRef(q.origin.host_id),
        status,
        error_code: code.replace(/[^a-z0-9_.-]/g, '_').slice(0, 48),
      });
    } catch {
      /* informational for the phone; local state is authoritative */
    }
  }

  /**
   * Startup reconciliation for injections interrupted by a crash. A marker found in the terminal means the
   * text was typed (mark delivered, do not repeat). No marker proves nothing, so the answer is flagged
   * `delivery-uncertain` for a human; it is NEVER re-injected automatically.
   */
  async recover(): Promise<{ reconciled: number; uncertain: number }> {
    const { ctx, o } = this;
    let reconciled = 0;
    let uncertain = 0;
    for (const intent of await ctx.store.openIntents()) {
      const q = await ctx.store.getQuestion(intent.question_id);
      if (!q) {
        await ctx.store.updateIntent(intent.injection_id, {
          state: 'abandoned',
          updated_at: ctx.now(),
        });
        continue;
      }
      let found = false;
      try {
        const loc = await o.sink.locate({
          ...q.origin,
          pane_id: intent.pane_id,
          terminal_generation: intent.terminal_generation,
        });
        if (loc.state === 'alive' && loc.target)
          found = await o.sink.hasMarker(loc.target, intent.injection_id);
      } catch {
        found = false;
      }
      if (found) {
        const entry = parseAnswers(q.answers_json).find(
          (e) => e.revision === intent.answer_revision && e.deliver && !e.delivered,
        );
        if (entry)
          await this.markDelivered(
            q.question_id,
            entry.entry_id,
            intent.injection_id,
            entry.revision,
          );
        await ctx.store.updateIntent(intent.injection_id, {
          state: 'typed',
          updated_at: ctx.now(),
        });
        await this.ack(intent.injection_id);
        reconciled++;
      } else {
        await ctx.store.updateIntent(intent.injection_id, {
          state: 'uncertain',
          updated_at: ctx.now(),
        });
        await this.attention(q, 'crash_unreconciled', 'delivery-uncertain');
        uncertain++;
      }
    }
    return { reconciled, uncertain };
  }

  /** Explicit human action: allow a stuck question to be delivered again with a fresh injection id. */
  async retry(questionId: string): Promise<void> {
    const q = await this.ctx.store.getQuestion(questionId);
    if (!q) return;
    const entries = parseAnswers(q.answers_json).map((e) => (e.deliver && !e.delivered ? e : e));
    await this.ctx.store.updateQuestion(questionId, {
      delivery_status: 'desktop-received',
      error_code: null,
      answers_json: serializeAnswers(entries),
    });
    await this.ctx.audit.log({ event: 'delivery.retry-requested', question_id: questionId });
  }
}

export type { InjectionIntent };
