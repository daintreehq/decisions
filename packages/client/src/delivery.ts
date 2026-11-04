import {
  MAX_NOTICE_BYTES,
  formatAnswerNotice,
  formatFollowupNotice,
  noticeChunk,
} from './notice.js';
import { parseAnswers, serializeAnswers, type AnswerContent, type AnswerEntry } from './answers.js';
import { openAnswerContent, openMessageContent, openQuestionContent } from './at-rest.js';
import { RelayError } from './errors.js';
import { TransientError } from './mutex.js';
import type { BridgeContext } from './context.js';
import { hostRef } from './context.js';
import { newId, sha256Hex } from '@daintreehq/decisions-crypto';
import { messageDeliveryKey } from '@daintreehq/decisions-protocol';
import {
  isPendingMessage,
  isUndeliveredMessage,
  parseMessages,
  serializeMessages,
  unreportedStatuses,
  type LocalMessageStatus,
  type MessageContent,
  type MessageDelivery,
  type StoredMessage,
} from './messages.js';
import type { MessageReceiptInput } from './relay.js';
import { pickResumeAdapter, unsupportedResumeAdapter } from './resume.js';
import {
  resolvePhoneImages,
  type PhoneImageStore,
  type ResolvedPhoneImage,
} from './phone-images.js';
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
  /** Where verified phone images go on the host's disk. Without it, each is listed as unavailable. */
  phoneImages?: PhoneImageStore;
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

const enc = new TextEncoder();
const byteLen = (s: string): number => enc.encode(s).length;

/** An answer entry's place in its question's thread: its ledger seq, or 0 for one stored before threads. */
const seqOf = (e: AnswerEntry): number => e.event_seq ?? 0;

/** The wire form of a local error code (`MessageReceiptBody` and `deliveries/failed` take `[a-z0-9_.-]{1,48}`). */
const wireCode = (code: string): string =>
  code.replace(/[^a-z0-9_.-]/g, '_').slice(0, 48) || 'unknown';

interface ItemBase {
  q: QuestionRow;
  /** The question as asked, quoted in the block; absent when its sealed content can't be opened now. */
  question?: string;
  intentId: string;
  /** The carrier's phone images, resolved for this attempt once the pane is idle. */
  images?: ResolvedPhoneImage[];
  /** The item's place in its question's thread (ledger seq). */
  seq: number;
}

interface AnswerItem extends ItemBase {
  kind: 'answer';
  entry: AnswerEntry;
  /** The answer's content, opened in memory for this attempt only. */
  content: AnswerContent;
}

interface MessageItem extends ItemBase {
  kind: 'message';
  message: StoredMessage;
  /** The message's content, opened in memory for this attempt only. */
  content: MessageContent;
  /** The question had an answer before this message, in thread order. */
  answered: boolean;
}

type Item = AnswerItem | MessageItem;

/** What one question has to type on this pass. */
interface Thread {
  q: QuestionRow;
  /** Pending answers, or none while the question's answers are held for a human. */
  answers: AnswerEntry[];
  /** Pending human messages in thread order, none after anything earlier in the thread that is held. */
  messages: StoredMessage[];
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
    const rows = (await ctx.store.listQuestions()).filter((q) => !q.history_only);
    await this.flushMessageReceipts(rows);
    // An unresolved uncertain injection blocks a question's answers even if its status flag was lost in a crash.
    // So does an intent still in state `intent`: passes are serialised, so one found here belongs to an attempt
    // that failed before it was settled. The text may be on screen; recover() reconciles it at start. A
    // follow-up's unsettled intent holds that message (and what follows it in its thread), never the answers.
    const open = (await ctx.store.openIntents()).filter((i) => i.state === 'intent');
    const unsettled = new Set(open.filter((i) => i.message_id == null).map((i) => i.question_id));
    const unsettledMessages = new Set(
      open
        .filter((i) => i.message_id != null)
        .map((i) => messageDeliveryKey(i.question_id, i.message_id!)),
    );
    const threads: Thread[] = [];
    for (const q of rows) {
      const t = await this.thread(q, unsettled, unsettledMessages);
      if (t.answers.length > 0 || t.messages.length > 0) threads.push(t);
    }
    // One lane per pane: questions go in creation order (alias is monotonic), each in its thread's order.
    const lanes = new Map<string, Thread[]>();
    for (const t of threads) {
      const k = `${t.q.origin.host_id}\u0000${t.q.origin.pane_id}`;
      (lanes.get(k) ?? lanes.set(k, []).get(k)!).push(t);
    }
    for (const ts of lanes.values()) {
      if (this.stopped) break;
      ts.sort((a, b) => a.q.alias - b.q.alias);
      add(out, await this.laneDeliver(ts));
    }
    return out;
  }

  /**
   * What `q` may type now. Its answers follow the rules they always had. A follow-up never overtakes anything
   * before it in the thread: it waits behind a held answer and behind an earlier follow-up that is held. An
   * answer never waits for a follow-up, so a message can never hold back or change an answer's delivery.
   */
  private async thread(
    q: QuestionRow,
    unsettled: ReadonlySet<string>,
    unsettledMessages: ReadonlySet<string>,
  ): Promise<Thread> {
    const pending = this.pending(q);
    const held =
      pending.length > 0 &&
      (q.delivery_status === 'needs-attention' ||
        q.delivery_status === 'delivery-uncertain' ||
        unsettled.has(q.question_id) ||
        (await this.ctx.store.hasUncertainIntent(q.question_id)));
    const barrier = held ? Math.min(...pending.map(seqOf)) : Infinity;
    const messages: StoredMessage[] = [];
    const waiting = parseMessages(q.messages_json)
      .filter(isUndeliveredMessage)
      .sort((a, b) => a.event_seq - b.event_seq);
    for (const m of waiting) {
      if (m.event_seq > barrier) break;
      if (!isPendingMessage(m)) break;
      if (unsettledMessages.has(messageDeliveryKey(q.question_id, m.message_id))) break;
      messages.push(m);
    }
    return { q, answers: held ? [] : pending, messages };
  }

  private async resolveTarget(
    t: Thread,
  ): Promise<{ target: TerminalTarget } | { defer: true } | { attention: string }> {
    const { q } = t;
    const loc = await this.o.sink.locate(q.origin);
    if (loc.state === 'alive') {
      if (!loc.target) return { attention: 'no_target' };
      // Defence in depth: whatever the sink believes, the engine only types into the exact origin.
      if (!sameTarget(loc.target, targetOf(q.origin))) return { attention: 'target_mismatch' };
      return { target: loc.target };
    }
    return this.unavailable(q, loc.state, t.answers.length > 0);
  }

  /**
   * Route a destination that cannot take the text: wait, resume through a verified path, or attention. Only a
   * wait for an answer shows on the question (`pending-host`); a follow-up waits in its own `received` state.
   */
  private async unavailable(
    q: QuestionRow,
    reason: string,
    answers: boolean,
  ): Promise<{ target: TerminalTarget } | { defer: true } | { attention: string }> {
    const { o } = this;
    if (reason === 'host-offline') {
      if (answers) await this.setStatus(q, 'pending-host');
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

  /** Every pending answer and follow-up of `t` goes to a human: answers as before, each message on its own. */
  private async threadAttention(
    t: Pick<Thread, 'q' | 'answers' | 'messages'>,
    code: string,
  ): Promise<number> {
    let n = 0;
    if (t.answers.length > 0) {
      await this.attention(t.q, code, 'needs-attention');
      n++;
    }
    for (const m of t.messages) {
      await this.messageAttention(t.q, m, code, 'needs-attention');
      n++;
    }
    return n;
  }

  /**
   * Open everything `t` will type before anything is typed. An answer that cannot be opened is never typed as an
   * empty answer: the question needs a human instead, and the follow-ups after it wait with it. A message that
   * cannot be opened needs a human too, and holds the follow-ups after it. A missing epoch key (rotated by
   * another process, not yet reloaded) just waits for a later pass.
   */
  private async openThread(t: Thread): Promise<{ items: Item[]; attention: number } | 'transient'> {
    const { ctx } = this;
    const { q } = t;
    // Only a reference for the agent: nothing is held back because its question can't be read.
    const question = await openQuestionContent(ctx, q)
      .then((c) => c?.question)
      .catch(() => undefined);
    const quoted = question ? { question } : {};
    let items: Item[] = [];
    let attention = 0;
    let barrier = Infinity;
    for (const entry of t.answers) {
      try {
        const content = await openAnswerContent(ctx, q.question_id, entry);
        items.push({
          kind: 'answer',
          q,
          entry,
          content,
          intentId: newId(ctx.now()),
          seq: seqOf(entry),
          ...quoted,
        });
      } catch (e) {
        if (e instanceof TransientError) return 'transient';
        await this.attention(q, 'answer_unreadable', 'needs-attention');
        attention++;
        items = [];
        barrier = Math.min(...t.answers.map(seqOf));
        break;
      }
    }
    const answeredBefore = (seq: number) =>
      parseAnswers(q.answers_json).some((e) => e.kind === 'answer' && seqOf(e) < seq);
    for (const m of t.messages) {
      if (m.event_seq > barrier) break;
      try {
        const content = await openMessageContent(ctx, q.question_id, m);
        items.push({
          kind: 'message',
          q,
          message: m,
          content,
          answered: answeredBefore(m.event_seq),
          intentId: newId(ctx.now()),
          seq: m.event_seq,
          ...quoted,
        });
      } catch (e) {
        if (e instanceof TransientError) return 'transient';
        await this.messageAttention(q, m, 'message_unreadable', 'needs-attention');
        attention++;
        break;
      }
    }
    items.sort((a, b) => a.seq - b.seq);
    return { items, attention };
  }

  private async laneDeliver(threads: Thread[]): Promise<DrainResult> {
    const { o } = this;
    const res = EMPTY();
    let target: TerminalTarget | null = null;
    const items: Item[] = [];
    for (const t of threads) {
      const r = await this.resolveTarget(t);
      if ('defer' in r) {
        res.deferred++;
        break; // preserve ordering: nothing later in the lane may overtake
      }
      if ('attention' in r) {
        res.needsAttention += await this.threadAttention(t, r.attention);
        continue;
      }
      if (target && !sameTarget(target, r.target)) {
        break; // a different destination (pane, generation, session or worktree): handle on the next pass
      }
      const opened = await this.openThread(t);
      if (opened === 'transient') {
        res.deferred++;
        break;
      }
      res.needsAttention += opened.attention;
      if (opened.items.length === 0) continue;
      target = r.target;
      items.push(...opened.items);
    }
    if (!target || items.length === 0) return res;
    if (!(await o.sink.isIdle(target))) {
      res.deferred++;
      return res;
    }
    // Only now, with something about to be typed, are images fetched: a busy pane costs no downloads. They are
    // resolved before chunking, so the batches are measured with their image lines.
    await this.resolveImages(items);
    const chunks = o.batch === false ? items.map((i) => [i]) : this.chunk(items);
    for (const chunk of chunks) {
      if (this.stopped) break;
      const r = await this.injectChunk(target, chunk);
      add(res, r);
      if (r.delivered === 0) break; // anything but delivered stops the lane: ordering is preserved
    }
    return res;
  }

  /** Consecutive items, in order, grouped so no typed chunk exceeds the byte cap (a lone item always fits). */
  private chunk(items: Item[]): Item[][] {
    const max = this.o.maxBatchBytes ?? MAX_NOTICE_BYTES;
    const groups: Item[][] = [];
    let cur: Item[] = [];
    for (const i of items) {
      const next = [...cur, i];
      if (cur.length > 0 && byteLen(this.text(next)) > max) {
        groups.push(cur);
        cur = [i];
      } else {
        cur = next;
      }
    }
    if (cur.length > 0) groups.push(cur);
    return groups;
  }

  /** The text typed for one chunk. */
  private text(chunk: Item[]): string {
    return noticeChunk(chunk.map((i) => this.block(i)));
  }

  private block(i: Item): string {
    if (i.kind === 'message') {
      return formatFollowupNotice({
        questionId: i.q.question_id,
        alias: i.q.alias,
        messageId: i.message.message_id,
        ...(i.question ? { question: i.question } : {}),
        text: i.content.text,
        answered: i.answered,
        ...(i.images?.length ? { images: i.images } : {}),
        injectionId: i.intentId,
      });
    }
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
      ...(i.images?.length ? { images: i.images } : {}),
      injectionId: i.intentId,
    });
  }

  /**
   * Fetch, check and store each pending answer's or message's phone images, and keep the host's paths with it so
   * a retried delivery (a busy pane, a held write, a restart) reuses the files instead of fetching and storing
   * them again. Failures are not kept: the next attempt tries again, and the block typed lists them as
   * unavailable, never holding back the words.
   */
  private async resolveImages(items: Item[]): Promise<void> {
    for (const i of items) {
      if (this.stopped) return;
      const images = i.content.images ?? [];
      const signedIds =
        i.kind === 'answer' ? (i.content.image_ids ?? []) : i.message.attachment_ids;
      if (images.length === 0 && signedIds.length === 0) continue;
      const prior = i.kind === 'answer' ? i.entry.stored_images : i.message.delivery?.stored_images;
      const stored = new Map((prior ?? []).map((s) => [s.attachment_id, s.path]));
      i.images = await resolvePhoneImages(this.ctx, this.o.phoneImages, {
        questionId: i.q.question_id,
        carrier:
          i.kind === 'answer'
            ? { kind: 'answer', actionId: i.entry.entry_id }
            : { kind: 'message', messageId: i.message.message_id },
        origin: i.q.origin,
        signedIds,
        images,
        stored,
        stopped: () => this.stopped,
      });
      const fresh: { attachment_id: string; path: string }[] = [];
      for (const m of i.images) {
        if ('path' in m) {
          if (stored.get(m.attachmentId) !== m.path)
            fresh.push({ attachment_id: m.attachmentId, path: m.path });
        } else {
          await this.ctx.audit.log({
            event: 'phone-image.unavailable',
            question_id: i.q.question_id,
            result: m.unavailable,
          });
        }
      }
      if (fresh.length > 0) await this.rememberImages(i, fresh);
    }
  }

  /** Record the host's paths on the answer entry or message, re-read inside the shared lock like `markDelivered`. */
  private async rememberImages(
    i: Item,
    fresh: { attachment_id: string; path: string }[],
  ): Promise<void> {
    const merge = (prev: AnswerEntry['stored_images']) => {
      const ids = new Set(fresh.map((f) => f.attachment_id));
      return [...(prev ?? []).filter((s) => !ids.has(s.attachment_id)), ...fresh];
    };
    await this.ctx.lock.run(async () => {
      const row = await this.ctx.store.getQuestion(i.q.question_id);
      if (!row) return;
      if (i.kind === 'answer') {
        const entries = parseAnswers(row.answers_json).map((e) =>
          e.entry_id === i.entry.entry_id ? { ...e, stored_images: merge(e.stored_images) } : e,
        );
        await this.ctx.store.updateQuestion(i.q.question_id, {
          answers_json: serializeAnswers(entries),
        });
      } else {
        const messages = this.withDelivery(row, i.message.message_id, (d) => ({
          stored_images: merge(d.stored_images),
        }));
        await this.ctx.store.updateQuestion(i.q.question_id, { messages_json: messages });
      }
    });
    if (i.kind === 'answer') i.entry = { ...i.entry, stored_images: merge(i.entry.stored_images) };
    else if (i.message.delivery)
      i.message = {
        ...i.message,
        delivery: { ...i.message.delivery, stored_images: merge(i.message.delivery.stored_images) },
      };
    for (const f of fresh) {
      await this.ctx.audit.log({
        event: 'phone-image.stored',
        question_id: i.q.question_id,
        result: f.attachment_id,
      });
    }
  }

  /** `row`'s messages with one message's delivery patched, serialised. */
  private withDelivery(
    row: QuestionRow,
    messageId: string,
    patch: (d: MessageDelivery) => Partial<MessageDelivery>,
  ): string {
    return serializeMessages(
      parseMessages(row.messages_json).map((m) =>
        m.message_id === messageId && m.delivery
          ? { ...m, delivery: { ...m.delivery, ...patch(m.delivery) } }
          : m,
      ),
    );
  }

  private async injectChunk(target: TerminalTarget, chunk: Item[]): Promise<DrainResult> {
    const { ctx, o } = this;
    const res = EMPTY();
    const text = this.text(chunk);
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
    // 0b. Every answer and message must still be one to type: fetching images takes time, and a cancellation,
    //     deletion or another delivery may have settled one meanwhile. The check and the intents share the lock
    //     the inbox applies cancellations and deletions under, so none lands between them.
    const admitted = await ctx.lock.run(async () => {
      for (const q of questions) {
        const row = await ctx.store.getQuestion(q.question_id);
        const answers = new Set(row ? this.pending(row).map((e) => e.entry_id) : ([] as string[]));
        const messages = new Set(
          row
            ? parseMessages(row.messages_json)
                .filter(isPendingMessage)
                .map((m) => m.message_id)
            : ([] as string[]),
        );
        for (const i of chunk) {
          if (i.q.question_id !== q.question_id) continue;
          const live =
            i.kind === 'answer'
              ? answers.has(i.entry.entry_id)
              : messages.has(i.message.message_id);
          if (!live) return false;
        }
      }
      const now = ctx.now();
      // 1. Persist the intent BEFORE touching the terminal.
      for (const i of chunk) {
        await ctx.store.putIntent({
          injection_id: i.intentId,
          question_id: i.q.question_id,
          answer_revision: i.kind === 'answer' ? i.entry.revision : 0,
          message_id: i.kind === 'message' ? i.message.message_id : null,
          host_id: target.hostId,
          pane_id: target.paneId,
          terminal_generation: target.terminalGeneration,
          ownership_principal: target.ownershipPrincipal,
          agent_incarnation: target.agentIncarnation,
          state: 'intent',
          created_at: now,
          updated_at: now,
        });
        // The question's attempt fields describe its answers; a follow-up's attempt is its own intent.
        if (i.kind === 'answer') {
          await ctx.store.updateQuestion(i.q.question_id, {
            last_injection_id: i.intentId,
            last_attempt_at: new Date(now).toISOString(),
          });
        }
      }
      return true;
    });
    if (!admitted) {
      // Stale: another pass rebuilds the lane from the store, without what was settled, so the pane's other
      // answers are not left waiting for an unrelated wake-up.
      this.again = true;
      res.deferred++;
      return res;
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
          if (i.kind === 'answer') {
            await ctx.store.updateIntent(i.intentId, { state: 'typed', updated_at: ctx.now() });
            await this.markDelivered(
              i.q.question_id,
              i.entry.entry_id,
              i.intentId,
              i.entry.revision,
              result.proof,
            );
          } else {
            await this.markMessageDelivered(
              i.q.question_id,
              i.message.message_id,
              i.intentId,
              result.proof,
            );
          }
          await this.ack(i.intentId);
        }
        res.delivered += chunk.length;
        return res;
      case 'ambiguous': {
        // The terminal may or may not have received the text: never retry blindly.
        const code = result.code ?? 'inject_ambiguous';
        for (const i of chunk) {
          if (i.kind === 'answer')
            await this.attention(i.q, code, 'delivery-uncertain', i.intentId);
          else await this.messageAttention(i.q, i.message, code, 'delivery-uncertain', i.intentId);
        }
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
          const mine = chunk.filter((i) => i.q.question_id === q.question_id);
          const answers = mine.some((i) => i.kind === 'answer');
          const routed = await this.unavailable(q, result.reason, answers);
          if ('attention' in routed) {
            const code = result.code ?? routed.attention;
            if (answers) await this.attention(q, code, 'needs-attention');
            for (const i of mine)
              if (i.kind === 'message')
                await this.messageAttention(q, i.message, code, 'needs-attention');
            res.needsAttention += mine.length;
          } else {
            res.deferred += mine.length; // waiting for the host, or resumed: a later pass delivers it
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

  /**
   * A follow-up was typed: the message and its intent change in ONE atomic write, so a crash can never leave it
   * typed but still waiting (it would be typed twice). Nothing about the question's answers changes.
   */
  private async markMessageDelivered(
    questionId: string,
    messageId: string,
    injectionId: string,
    /** The sink's proof of the write; null when a crash-recovery marker was found instead. */
    proof: string | null,
  ): Promise<void> {
    const { ctx } = this;
    const q = await ctx.lock.run(async () => {
      const now = ctx.now();
      const row = await ctx.store.getQuestion(questionId);
      if (!row) {
        await ctx.store.updateIntent(injectionId, { state: 'typed', updated_at: now });
        return null;
      }
      const messages = this.withDelivery(row, messageId, () => ({
        status: 'terminal-delivered',
        injection_id: injectionId,
        terminal_delivered_at: new Date(now).toISOString(),
        error_code: null,
      }));
      await ctx.store.settleIntent(injectionId, { state: 'typed', updated_at: now }, questionId, {
        messages_json: messages,
      });
      return row;
    });
    if (!q) return;
    await ctx.audit.log({
      event: 'message.delivered',
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
    if (intent.message_id != null) {
      // A follow-up's receipts ride on its own delivery state, retried by flushMessageReceipts: once it is
      // recorded as typed, the intent is done.
      await ctx.store.updateIntent(injectionId, { state: 'acked', updated_at: ctx.now() });
      await this.reportMessage(intent.question_id, intent.message_id);
      return;
    }
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

  /** Send every follow-up receipt still owed, oldest question first; stop at the first the relay can't take now. */
  private async flushMessageReceipts(rows: QuestionRow[]): Promise<void> {
    for (const q of rows) {
      for (const m of parseMessages(q.messages_json)) {
        if (!m.delivery || unreportedStatuses(m.delivery).length === 0) continue;
        if (!(await this.reportMessage(q.question_id, m.message_id))) return;
      }
    }
  }

  /**
   * Report a follow-up's delivery to the relay (`POST /deliveries/messages`, protocol section 16.4): `received`
   * first, then each later status once. Every receipt is idempotent: the same status of the same message always
   * sends the same body under the same key, so a reply lost after the relay took it is harmless to resend.
   * False while the relay is unreachable (retried on the next pass); a refusal is final and audited, so one bad
   * receipt never blocks the others. A receipt never changes anything about the question's answers.
   */
  private async reportMessage(questionId: string, messageId: string): Promise<boolean> {
    const { ctx } = this;
    const row = await ctx.store.getQuestion(questionId);
    const m = row ? parseMessages(row.messages_json).find((x) => x.message_id === messageId) : null;
    if (!row || !m?.delivery) return true;
    for (const status of unreportedStatuses(m.delivery)) {
      const body = await this.receipt(row, m, m.delivery, status);
      if (body) {
        try {
          await ctx.client.deliveriesMessages(body);
        } catch (e) {
          if (e instanceof RelayError && e.retryable) return false;
          await ctx.audit.log({
            event: 'message.receipt-refused',
            question_id: questionId,
            result: `${status}:${e instanceof RelayError ? e.code : 'invalid'}`.slice(0, 80),
          });
        }
      }
      await ctx.lock.run(async () => {
        const fresh = await ctx.store.getQuestion(questionId);
        if (fresh)
          await ctx.store.updateQuestion(questionId, {
            messages_json: this.withDelivery(fresh, messageId, () => ({ reported: status })),
          });
      });
    }
    return true;
  }

  /** The receipt body for one status of a follow-up, or null when it lacks what that status must carry. */
  private async receipt(
    row: QuestionRow,
    m: StoredMessage,
    d: MessageDelivery,
    status: LocalMessageStatus,
  ): Promise<MessageReceiptInput | null> {
    const detail =
      status === 'terminal-delivered'
        ? d.injection_id
        : status === 'received'
          ? ''
          : wireCode(d.error_code ?? 'unknown');
    if (detail === null) return null;
    const base = {
      idempotency_key: await sha256Hex(
        JSON.stringify(['message-receipt', row.question_id, m.message_id, status, detail]),
      ),
      question_id: row.question_id,
      message_id: m.message_id,
      // The relay keys the delivery by the host it was published for, even after a resume moved the question.
      host_id: m.target_host_id || (await hostRef(row.origin.host_id)),
    };
    switch (status) {
      case 'received':
        return { ...base, status };
      case 'terminal-delivered':
        return { ...base, status, injection_id: detail };
      case 'needs-attention':
      case 'delivery-uncertain':
        return { ...base, status, error_code: detail };
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
        error_code: wireCode(code),
      });
    } catch {
      /* informational for the phone; local state is authoritative */
    }
  }

  /**
   * One follow-up goes to a human: nothing was typed (`needs-attention`), or it may have been
   * (`delivery-uncertain`, never typed again automatically). Only that message changes; the question's answers
   * and their delivery state stay as they are. An uncertain intent and the message change in one atomic write.
   */
  private async messageAttention(
    q: QuestionRow,
    m: StoredMessage,
    code: string,
    status: 'needs-attention' | 'delivery-uncertain',
    uncertainIntentId?: string,
  ): Promise<void> {
    const { ctx } = this;
    await ctx.lock.run(async () => {
      const now = ctx.now();
      const row = await ctx.store.getQuestion(q.question_id);
      if (!row) {
        if (uncertainIntentId)
          await ctx.store.updateIntent(uncertainIntentId, { state: 'uncertain', updated_at: now });
        return;
      }
      const messages = this.withDelivery(row, m.message_id, () => ({
        status,
        error_code: code,
        ...(uncertainIntentId ? { injection_id: uncertainIntentId } : {}),
      }));
      if (uncertainIntentId) {
        await ctx.store.settleIntent(
          uncertainIntentId,
          { state: 'uncertain', updated_at: now },
          q.question_id,
          { messages_json: messages },
        );
      } else {
        await ctx.store.updateQuestion(q.question_id, { messages_json: messages });
      }
    });
    await ctx.audit.log({
      event: 'message.attention',
      question_id: q.question_id,
      requirement: q.requirement,
      result: code,
    });
    await this.reportMessage(q.question_id, m.message_id);
  }

  /** Whether the text carrying `intent`'s injection id is in the exact run it was typed into. */
  private async markerFound(q: QuestionRow, intent: InjectionIntent): Promise<boolean> {
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
      const loc = await this.o.sink.locate(typedInto);
      if (loc.state === 'alive' && loc.target && sameTarget(loc.target, targetOf(typedInto)))
        return await this.o.sink.hasMarker(loc.target, intent.injection_id);
    } catch {
      /* proves nothing */
    }
    return false;
  }

  /**
   * Startup reconciliation for injections interrupted by a crash. A marker found in the terminal means the
   * text was typed (mark delivered, do not repeat). No marker proves nothing, so the answer or follow-up is
   * flagged `delivery-uncertain` for a human; it is NEVER re-injected automatically. Each block in a batch
   * carries its own injection id, so each is reconciled on its own.
   */
  async recover(): Promise<{ reconciled: number; uncertain: number }> {
    const { ctx } = this;
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
      if (intent.message_id != null) {
        const r = await this.recoverMessage(q, intent, intent.message_id);
        if (r === 'reconciled') reconciled++;
        else if (r === 'uncertain') uncertain++;
        continue;
      }
      if (await this.markerFound(q, intent)) {
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

  /** Reconcile one follow-up's interrupted injection, found by its own `(question_id, message_id)`. */
  private async recoverMessage(
    q: QuestionRow,
    intent: InjectionIntent,
    messageId: string,
  ): Promise<'reconciled' | 'uncertain' | 'skipped'> {
    const { ctx } = this;
    const m = parseMessages(q.messages_json).find((x) => x.message_id === messageId);
    if (!m?.delivery) {
      await ctx.store.updateIntent(intent.injection_id, {
        state: 'abandoned',
        updated_at: ctx.now(),
      });
      return 'skipped';
    }
    // `typed` was recorded with the message in one write: it was typed, and only its receipt may be owed.
    if (intent.state === 'typed' || (await this.markerFound(q, intent))) {
      if (m.delivery.status !== 'terminal-delivered')
        await this.markMessageDelivered(q.question_id, messageId, intent.injection_id, null);
      await this.ack(intent.injection_id);
      return 'reconciled';
    }
    await this.messageAttention(
      q,
      m,
      'crash_unreconciled',
      'delivery-uncertain',
      intent.injection_id,
    );
    return 'uncertain';
  }

  /**
   * Explicit human action: allow a stuck question to be delivered again with a fresh injection id. Its follow-ups
   * held for a human (needing attention or uncertain) go back to waiting for the pane too.
   */
  async retry(questionId: string): Promise<void> {
    const q = await this.ctx.store.getQuestion(questionId);
    if (!q) return;
    // Only answers that still have somewhere to go: a retry for a follow-up leaves a delivered answer's state alone.
    if (
      this.pending(q).length > 0 ||
      q.delivery_status === 'needs-attention' ||
      q.delivery_status === 'delivery-uncertain'
    ) {
      const entries = parseAnswers(q.answers_json).map((e) => (e.deliver && !e.delivered ? e : e));
      await this.ctx.store.updateQuestion(questionId, {
        delivery_status: 'desktop-received',
        error_code: null,
        answers_json: serializeAnswers(entries),
      });
    }
    await this.ctx.lock.run(async () => {
      const row = await this.ctx.store.getQuestion(questionId);
      if (!row) return;
      const messages = parseMessages(row.messages_json).map((m) =>
        m.delivery?.deliver &&
        (m.delivery.status === 'needs-attention' || m.delivery.status === 'delivery-uncertain')
          ? { ...m, delivery: { ...m.delivery, status: 'received' as const, error_code: null } }
          : m,
      );
      await this.ctx.store.updateQuestion(questionId, {
        messages_json: serializeMessages(messages),
      });
    });
    await this.ctx.audit.log({ event: 'delivery.retry-requested', question_id: questionId });
  }
}

export type { InjectionIntent };
