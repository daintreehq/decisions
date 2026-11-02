import { batchNotices, formatAnswerNotice } from './notice.js';
import { parseAnswers, serializeAnswers, type AnswerContent, type AnswerEntry } from './answers.js';
import { openAnswerContent, openQuestionContent } from './at-rest.js';
import { TransientError } from './mutex.js';
import type { BridgeContext } from './context.js';
import { hostRef } from './context.js';
import { newId } from '@daintreehq/decisions-crypto';
import { pickResumeAdapter, unsupportedResumeAdapter } from './resume.js';
import {
  sameTarget,
  targetOf,
  type AgentResumeAdapter,
  type InjectResult,
  type TerminalSink,
  type TerminalTarget,
  type UnavailableReason,
} from './sink.js';
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
  /** Held (busy pane, closed wake gate), host offline or just resumed: call drain() again later. */
  deferred: number;
  /** Nothing was typed and a human has to decide (gone, relaunched without a resume, rejected). */
  needsAttention: number;
  /** The text may or may not have been typed: `delivery-uncertain`, never re-typed automatically. */
  uncertain: number;
}

const EMPTY = (): DrainResult => ({ delivered: 0, deferred: 0, needsAttention: 0, uncertain: 0 });

function add(a: DrainResult, b: DrainResult): void {
  a.delivered += b.delivered;
  a.deferred += b.deferred;
  a.needsAttention += b.needsAttention;
  a.uncertain += b.uncertain;
}

/** The local `error_code` for each unavailable reason (kept stable: the UI and relay echoes show them). */
const UNAVAILABLE_CODE: Record<UnavailableReason, string> = {
  'host-offline': 'host_offline',
  relaunched: 'relaunched',
  gone: 'pane_gone',
  'generation-mismatch': 'generation_mismatch',
  'session-mismatch': 'session_mismatch',
  rejected: 'inject_rejected',
};

/** Reasons that mean the original agent is no longer at the origin: a verified resume may bring it back. */
const RESUMABLE = new Set<string>([
  'relaunched',
  'gone',
  'generation-mismatch',
  'session-mismatch',
]);

/**
 * Checks a sink's answer against the contract. Anything unrecognised, and a `delivered` without proof, is
 * ambiguous: the text may be on screen, so it must never be typed again and never be reported delivered.
 * `code` is the local error code the engine records when it had to reinterpret the result.
 */
export function normalizeInjectResult(raw: unknown): InjectResult & { code?: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const reason = typeof r.reason === 'string' ? { reason: r.reason } : {};
  switch (r.outcome) {
    case 'delivered':
      return typeof r.proof === 'string' && r.proof.length > 0
        ? { outcome: 'delivered', proof: r.proof }
        : { outcome: 'ambiguous', code: 'delivered_without_proof' };
    case 'held':
      return { outcome: 'held', ...reason };
    case 'unavailable':
      return typeof r.reason === 'string' && Object.hasOwn(UNAVAILABLE_CODE, r.reason)
        ? {
            outcome: 'unavailable',
            reason: r.reason as UnavailableReason,
            ...(typeof r.detail === 'string' ? { detail: r.detail } : {}),
          }
        : // Nothing was typed, but the engine cannot route an unknown reason: a human decides.
          { outcome: 'unavailable', reason: 'rejected', code: 'unavailable_unknown_reason' };
    case 'ambiguous':
      return { outcome: 'ambiguous', ...reason };
    default:
      return { outcome: 'ambiguous', code: 'invalid_inject_result' };
  }
}

interface Item {
  q: QuestionRow;
  entry: AnswerEntry;
  /** The answer's content, opened in memory for this attempt only. */
  content: AnswerContent;
  /** The question as asked, quoted in the block; absent when its sealed content can't be opened now. */
  question?: string;
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
    if (this.stopped) return EMPTY();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      const total = EMPTY();
      try {
        do {
          this.again = false;
          const r = await this.pass();
          total.delivered += r.delivered;
          total.deferred = r.deferred;
          total.needsAttention += r.needsAttention;
          total.uncertain += r.uncertain;
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
    const out = EMPTY();
    await this.flushAcks();
    const candidates = (await ctx.store.listQuestions()).filter(
      (q) =>
        !q.history_only &&
        this.pending(q).length > 0 &&
        q.delivery_status !== 'needs-attention' &&
        q.delivery_status !== 'delivery-uncertain',
    );
    // An unresolved uncertain injection blocks the question even if its status flag was lost in a crash. So
    // does an intent still in state `intent`: passes are serialised, so one found here belongs to an attempt
    // that failed before it was settled. The text may be on screen; recover() reconciles it at start.
    const unsettled = new Set(
      (await ctx.store.openIntents()).filter((i) => i.state === 'intent').map((i) => i.question_id),
    );
    const all: QuestionRow[] = [];
    for (const q of candidates)
      if (!unsettled.has(q.question_id) && !(await ctx.store.hasUncertainIntent(q.question_id)))
        all.push(q);
    // One lane per pane: answers go in question-creation order (alias is monotonic).
    const lanes = new Map<string, QuestionRow[]>();
    for (const q of all) {
      const k = `${q.origin.host_id}\u0000${q.origin.pane_id}`;
      (lanes.get(k) ?? lanes.set(k, []).get(k)!).push(q);
    }
    for (const qs of lanes.values()) {
      if (this.stopped) break;
      qs.sort((a, b) => a.alias - b.alias);
      add(out, await this.laneDeliver(qs));
    }
    return out;
  }

  private async resolveTarget(
    q: QuestionRow,
  ): Promise<{ target: TerminalTarget } | { defer: true } | { attention: string }> {
    const loc = await this.o.sink.locate(q.origin);
    if (loc.state === 'alive') {
      if (!loc.target) return { attention: 'no_target' };
      // Defence in depth: whatever the sink believes, the engine only types into the exact origin.
      if (!sameTarget(loc.target, targetOf(q.origin))) return { attention: 'target_mismatch' };
      return { target: loc.target };
    }
    return this.unavailable(q, loc.state);
  }

  /** Route a destination that cannot take the answer: wait, resume through a verified path, or attention. */
  private async unavailable(
    q: QuestionRow,
    reason: string,
  ): Promise<{ target: TerminalTarget } | { defer: true } | { attention: string }> {
    const { o } = this;
    if (reason === 'host-offline') {
      await this.setStatus(q, 'pending-host');
      return { defer: true };
    }
    const code = Object.hasOwn(UNAVAILABLE_CODE, reason)
      ? UNAVAILABLE_CODE[reason as UnavailableReason]
      : 'unavailable_unknown_reason';
    if (!RESUMABLE.has(reason)) return { attention: code };
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
    return { attention: code };
  }

  private async adopt(
    q: QuestionRow,
    target: TerminalTarget,
    strategy: string,
  ): Promise<{ target: TerminalTarget } | { attention: string }> {
    // Resume restores the agent in its ORIGINAL worktree; anything else would cross a destination boundary.
    if (target.worktreeId !== q.origin.worktree_id) return { attention: 'resume_wrong_worktree' };
    const origin: QuestionOrigin = {
      ...q.origin,
      host_id: target.hostId,
      pane_id: target.paneId,
      terminal_generation: target.terminalGeneration,
      ownership_principal: target.ownershipPrincipal,
      agent_incarnation: target.agentIncarnation,
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
    const res = EMPTY();
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
      if (target && !sameTarget(target, r.target)) {
        break; // a different destination (pane, generation, session or worktree): handle on the next pass
      }
      // Open every pending answer before anything is typed. One that cannot be opened is never typed as an
      // empty answer: the question needs a human instead.
      // A missing epoch key (rotated by another process, not yet reloaded) just waits for a later pass.
      const opened: Item[] = [];
      let unreadable: 'transient' | 'broken' | null = null;
      // Only a reference for the agent: an answer is never held back because its question can't be read.
      const question = await openQuestionContent(ctx, q)
        .then((c) => c?.question)
        .catch(() => undefined);
      for (const entry of this.pending(q)) {
        try {
          const content = await openAnswerContent(ctx, q.question_id, entry);
          opened.push({
            q,
            entry,
            content,
            intentId: newId(ctx.now()),
            ...(question ? { question } : {}),
          });
        } catch (e) {
          unreadable = e instanceof TransientError ? 'transient' : 'broken';
          break;
        }
      }
      if (unreadable === 'transient') {
        res.deferred++;
        break;
      }
      if (unreadable) {
        await this.attention(q, 'answer_unreadable', 'needs-attention');
        res.needsAttention++;
        continue;
      }
      target = r.target;
      items.push(...opened);
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
      add(res, r);
      if (r.delivered === 0) break; // anything but delivered stops the lane: ordering is preserved
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
    const e = { ...i.entry, ...i.content };
    return formatAnswerNotice({
      kind: e.kind,
      questionId: i.q.question_id,
      alias: i.q.alias,
      revision: e.revision,
      ...(i.question ? { question: i.question } : {}),
      source: e.source === 'proxy' ? 'proxy' : 'human',
      choices: e.choices,
      comment: e.text,
      correction: e.correction,
      ...(e.reason ? { reason: e.reason } : {}),
      ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
      ...(e.model_id ? { modelId: e.model_id } : {}),
      injectionId: i.intentId,
    });
  }

  private async injectChunk(target: TerminalTarget, chunk: Item[]): Promise<DrainResult> {
    const { ctx, o } = this;
    const res = EMPTY();
    const text = batchNotices(
      chunk.map((i) => this.block(i)),
      Number.MAX_SAFE_INTEGER,
    )[0]!;
    // 0. Revalidate every distinct question's destination IMMEDIATELY before typing. Anything that moved
    //    (resumed into another session, relaunched, closed) is deferred, never typed into the wrong place.
    const questions = [...new Map(chunk.map((i) => [i.q.question_id, i.q])).values()];
    for (const q of questions) {
      const loc = await o.sink.locate(q.origin);
      if (
        loc.state !== 'alive' ||
        !loc.target ||
        !sameTarget(loc.target, target) ||
        !sameTarget(loc.target, targetOf(q.origin))
      ) {
        res.deferred++;
        return res;
      }
    }
    if (!(await o.sink.isIdle(target))) {
      res.deferred++;
      return res;
    }
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
        ownership_principal: target.ownershipPrincipal,
        agent_incarnation: target.agentIncarnation,
        state: 'intent',
        created_at: now,
        updated_at: now,
      });
      await ctx.store.updateQuestion(i.q.question_id, {
        last_injection_id: i.intentId,
        last_attempt_at: new Date(now).toISOString(),
      });
    }
    // 2. Type, and take the sink's word only in the shapes the contract allows.
    let result: InjectResult & { code?: string };
    let thrown: unknown = undefined;
    try {
      result = normalizeInjectResult(await o.sink.inject(target, text, chunk[0]!.intentId));
    } catch (e) {
      thrown = e ?? 'null';
      result = { outcome: 'ambiguous', code: 'inject_threw' };
    }
    if (thrown !== undefined) {
      // Settle first (below), log afterwards: nothing fallible may run between a possible write and the
      // durable record that it may have happened.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const settled = await this.settleChunk(chunk, questions, result, res);
      await ctx.audit
        .log({ event: 'inject.threw', result: message.slice(0, 80) })
        .catch(() => undefined);
      return settled;
    }
    return this.settleChunk(chunk, questions, result, res);
  }

  /** Record what the sink reported. Runs straight after inject(); see `InjectResult` for the meanings. */
  private async settleChunk(
    chunk: Item[],
    questions: QuestionRow[],
    result: InjectResult & { code?: string },
    res: DrainResult,
  ): Promise<DrainResult> {
    const { ctx } = this;
    switch (result.outcome) {
      case 'delivered':
        for (const i of chunk) {
          await ctx.store.updateIntent(i.intentId, { state: 'typed', updated_at: ctx.now() });
          await this.markDelivered(
            i.q.question_id,
            i.entry.entry_id,
            i.intentId,
            i.entry.revision,
            result.proof,
          );
          await this.ack(i.intentId);
        }
        res.delivered += chunk.length;
        return res;
      case 'ambiguous': {
        // The terminal may or may not have received the text: never retry blindly.
        const code = result.code ?? 'inject_ambiguous';
        for (const i of chunk) await this.attention(i.q, code, 'delivery-uncertain', i.intentId);
        res.uncertain += chunk.length;
        return res;
      }
      case 'held':
      case 'unavailable': {
        // Nothing was written: close the intents so neither recovery nor the uncertain guard trips on them.
        for (const i of chunk)
          await ctx.store.updateIntent(i.intentId, { state: 'abandoned', updated_at: ctx.now() });
        if (result.outcome === 'held') {
          res.deferred++;
          return res;
        }
        await ctx.audit.log({
          event: 'inject.unavailable',
          result: result.reason,
          ...(result.detail ? { detail: { detail: result.detail.slice(0, 80) } } : {}),
        });
        for (const q of questions) {
          const n = chunk.filter((i) => i.q.question_id === q.question_id).length;
          const routed = await this.unavailable(q, result.reason);
          if ('attention' in routed) {
            await this.attention(q, result.code ?? routed.attention, 'needs-attention');
            res.needsAttention += n;
          } else {
            res.deferred += n; // waiting for the host, or resumed: a later pass delivers it
          }
        }
        return res;
      }
    }
  }

  private async markDelivered(
    questionId: string,
    entryId: string,
    injectionId: string,
    revision: number,
    /** The sink's proof of the write; null when a crash-recovery marker was found instead. */
    proof: string | null,
  ): Promise<void> {
    // Re-read inside the shared lock so a concurrent inbox append is never overwritten with a stale copy.
    const q = await this.ctx.lock.run(async () => {
      const row = await this.ctx.store.getQuestion(questionId);
      if (!row) return null;
      const entries = parseAnswers(row.answers_json).map((e) =>
        e.entry_id === entryId ? { ...e, delivered: true, injection_id: injectionId } : e,
      );
      const stillPending = entries.some((e) => e.deliver && !e.delivered);
      await this.ctx.store.updateQuestion(questionId, {
        answers_json: serializeAnswers(entries),
        delivered_revision: Math.max(row.delivered_revision, revision),
        delivery_status: stillPending ? row.delivery_status : 'terminal-delivered',
        last_injection_id: injectionId,
        error_code: null,
      });
      return row;
    });
    if (!q) return;
    await this.ctx.audit.log({
      event: 'answer.delivered',
      question_id: questionId,
      requirement: q.requirement,
      result: proof === null ? 'marker-found' : 'typed',
      ...(proof !== null ? { detail: { proof: proof.slice(0, 120) } } : {}),
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
    uncertainIntentId?: string,
  ): Promise<void> {
    const { ctx } = this;
    if (uncertainIntentId) {
      // Intent state and the question's delivery state change in ONE atomic write: no crash window in which
      // the question is still deliverable while its intent is already marked uncertain.
      await ctx.store.settleIntent(
        uncertainIntentId,
        { state: 'uncertain', updated_at: ctx.now() },
        q.question_id,
        { delivery_status: status, error_code: code },
      );
    } else {
      await ctx.store.updateQuestion(q.question_id, { delivery_status: status, error_code: code });
    }
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
        // Look in exactly the run the text was typed into, as the intent recorded it.
        const typedInto: QuestionOrigin = {
          ...q.origin,
          host_id: intent.host_id,
          pane_id: intent.pane_id,
          terminal_generation: intent.terminal_generation,
          ownership_principal: intent.ownership_principal,
          agent_incarnation: intent.agent_incarnation,
        };
        const loc = await o.sink.locate(typedInto);
        if (loc.state === 'alive' && loc.target && sameTarget(loc.target, targetOf(typedInto)))
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
            null,
          );
        await ctx.store.updateIntent(intent.injection_id, {
          state: 'typed',
          updated_at: ctx.now(),
        });
        await this.ack(intent.injection_id);
        reconciled++;
      } else {
        await this.attention(q, 'crash_unreconciled', 'delivery-uncertain', intent.injection_id);
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
