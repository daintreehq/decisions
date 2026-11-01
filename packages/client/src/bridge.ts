import { LIMITS, type DecisionContentV1, type LedgerEvent } from '@daintreehq/decisions-protocol';
import { AuditLog } from './audit.js';
import { BridgeError } from './content.js';
import {
  MemorySpool,
  type AttachmentResolver,
  type AttachmentSpool,
  type BridgeContext,
} from './context.js';
import { DeliveryEngine, type DrainResult } from './delivery.js';
import { EventVerifier } from './inbound.js';
import { Inbox } from './inbox.js';
import { PolicyRegistry, gateAllowsText } from './policy.js';
import { Publisher, type RegisterResult } from './publisher.js';
import { sameDigests, type OpenAnswerEntry } from './answers.js';
import { openAnswers, openQuestionContent, sealStoredContent } from './at-rest.js';
import { RelayError } from './errors.js';
import { refreshHostGrants } from './host-enrollment.js';
import { MemoryKeyStore, loadIdentity, type Identity, type KeyStore } from './identity.js';
import type { DecisionLearner, ProxyEngine, ProxyOutcome } from './proxy.js';
import { Mutex, TransientError } from './mutex.js';
import { RelayClient } from './relay.js';
import type { AgentResumeAdapter, TerminalSink } from './sink.js';
import { RelaySocket, type SocketState, type WebSocketFactory } from './socket.js';
import type { LocalStore } from './store.js';
import type { QuestionOrigin, QuestionRow } from './types.js';

export interface BridgeOptions {
  identity: Identity;
  /** Needed to pick up epoch keys rotated by another process while this one is running. */
  keyStore?: KeyStore;
  store: LocalStore;
  sink: TerminalSink;
  policy?: PolicyRegistry;
  resolver?: AttachmentResolver;
  spool?: AttachmentSpool;
  proxy?: ProxyEngine;
  proxyTimeoutMs?: number;
  /**
   * The decision model's history (`asBridgeLearner(history)` from the decision-model package). Human answers
   * are offered to it, and it records them only if the user opted into learning, with its secrets filter
   * applied. Without it, no question or answer plaintext is stored anywhere.
   */
  learner?: DecisionLearner;
  adapters?: AgentResumeAdapter[];
  auditPath?: string;
  debugContent?: boolean;
  client?: RelayClient;
  fetch?: typeof fetch;
  webSocket?: WebSocketFactory;
  now?: () => number;
  batch?: boolean;
  /** Background retry cadence for the outbox and busy panes. Default 30 s; 0 disables. */
  pumpIntervalMs?: number;
}

export type BridgeState = 'created' | 'running' | 'revoked' | 'stopped';

export interface DecisionView {
  questionId: string;
  alias: number;
  status: QuestionRow['local_status'];
  requirement: QuestionRow['requirement'];
  deliveryStatus: QuestionRow['delivery_status'];
  revision: number;
  expiresAt: string | null;
  /** The trusted workflow gate that governs the question, if any. */
  workflowGateId: string | null;
  /**
   * Who put the answer in force: `human` (an answer, a correction, or a confirmed proxy answer) or `proxy`.
   * Null unless the question is answered (`human-answered` or `proxy-answered`): an open, expired or
   * cancelled question reports no provenance, no choice and no text, whatever its history holds.
   */
  provenance: 'human' | 'proxy' | null;
  /** The option id of the answer in force, or null for a text-only answer or no answer. */
  choice: string | null;
  /** The free text of the answer in force ('' when none). */
  text: string;
  /**
   * True only when the question carries attachments and the answer in force lists exactly their plaintext
   * SHA-256 digests as the images the phone displayed. A question with no attachments, a proxy answer
   * (which reviews nothing, even once a human confirms it) or an approval sent before every image loaded
   * reports false.
   */
  reviewedDigestsMatch: boolean;
  answers: {
    revision: number;
    source: 'human' | 'proxy' | 'system';
    choices: string[];
    text: string;
    correction: boolean;
    delivered: boolean;
    createdAt: string;
  }[];
}

/**
 * The COMPLETE trusted identity of the asking terminal. A relaunched terminal (new generation or new
 * ownership principal), a restarted agent (new incarnation), a new agent session or a different worktree
 * that happens to reuse a pane id is a different asker.
 */
export interface PaneIdentity {
  host_id: string;
  pane_id: string;
  terminal_generation: number;
  ownership_principal: string;
  agent_incarnation: string;
  agent_session_id: string | null;
  worktree_id: string;
}

/** The identity a pane presents, taken from the origin its credential resolves to. */
export function paneIdentityOf(o: QuestionOrigin): PaneIdentity {
  return {
    host_id: o.host_id,
    pane_id: o.pane_id,
    terminal_generation: o.terminal_generation,
    ownership_principal: o.ownership_principal,
    agent_incarnation: o.agent_incarnation,
    agent_session_id: o.agent_session_id,
    worktree_id: o.worktree_id,
  };
}

/** An empty principal or incarnation (a row migrated from before they existed) never matches anyone. */
const known = (a: string, b: string) => typeof a === 'string' && a !== '' && a === b;

function sameAsker(o: QuestionOrigin, p: PaneIdentity): boolean {
  return (
    o.host_id === p.host_id &&
    o.pane_id === p.pane_id &&
    o.terminal_generation === p.terminal_generation &&
    known(o.ownership_principal, p.ownership_principal) &&
    known(o.agent_incarnation, p.agent_incarnation) &&
    o.agent_session_id === p.agent_session_id &&
    o.worktree_id === p.worktree_id
  );
}

type Listener = {
  state: (s: BridgeState) => void;
  socket: (s: SocketState, detail?: string) => void;
  delivered: (questionId: string) => void;
  error: (e: Error) => void;
};

/**
 * The narrow host-level API Daintree calls: register a question for a pane, and deliver answers back.
 * Everything else (relay protocol, crypto, durable queues, verification) lives behind it.
 */
export class DecisionsBridge {
  readonly ctx: BridgeContext;
  readonly publisher: Publisher;
  readonly verifier: EventVerifier;
  readonly inbox: Inbox;
  readonly delivery: DeliveryEngine;
  readonly socket: RelaySocket;
  state: BridgeState = 'created';
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping: Promise<void> | null = null;
  private listeners: { [K in keyof Listener]: Listener[K][] } = {
    state: [],
    socket: [],
    delivered: [],
    error: [],
  };

  constructor(private readonly o: BridgeOptions) {
    const client =
      o.client ??
      new RelayClient({
        identity: o.identity,
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...(o.now ? { now: o.now } : {}),
      });
    this.ctx = {
      identity: o.identity,
      client,
      store: o.store,
      audit: new AuditLog(o.store, {
        ...(o.auditPath ? { jsonlPath: o.auditPath } : {}),
        ...(o.debugContent ? { debugContent: true } : {}),
        ...(o.now ? { now: () => new Date(o.now!()) } : {}),
      }),
      policy: o.policy ?? new PolicyRegistry(),
      spool: o.spool ?? new MemorySpool(),
      resolver: o.resolver,
      now: o.now ?? Date.now,
      lock: new Mutex(),
      ...(o.learner ? { learner: o.learner } : {}),
      refreshIdentity: () => this.refreshKeys(),
    };
    this.publisher = new Publisher(this.ctx);
    this.verifier = new EventVerifier(this.ctx);
    this.inbox = new Inbox(this.ctx, this.verifier, { onRevokedSelf: () => this.markRevoked() });
    this.delivery = new DeliveryEngine(this.ctx, {
      sink: o.sink,
      ...(o.adapters ? { adapters: o.adapters } : {}),
      ...(o.batch !== undefined ? { batch: o.batch } : {}),
    });
    this.socket = new RelaySocket({
      client,
      getCursor: () => this.ctx.store.getCursor(),
      ...(o.webSocket ? { webSocket: o.webSocket } : {}),
      handlers: {
        onEvent: (ev) => this.onSocketEvent(ev),
        onCaughtUp: (hw, more) => this.onCaughtUp(hw, more),
        onState: (s, d) => this.listeners.socket.forEach((l) => l(s, d)),
        onRevoked: () => this.markRevoked(),
        onError: (e) => this.emitError(e),
      },
    });
  }

  on<K extends keyof Listener>(event: K, cb: Listener[K]): () => void {
    (this.listeners[event] as Listener[K][]).push(cb);
    return () => {
      const arr = this.listeners[event] as Listener[K][];
      arr.splice(arr.indexOf(cb), 1);
    };
  }

  private emitError(e: Error): void {
    this.listeners.error.forEach((l) => l(e));
  }

  /** A Host without a persistent key store keeps the epochs it fetches here, seeded from its identity. */
  private hostKeys: KeyStore | null = null;

  /**
   * Pick up epoch keys rotated since the identity was loaded. The owner desktop holds every epoch key itself,
   * so it reloads them from the key store (another process may have rotated). A `desktop-host` holds only
   * what the owner sealed to it: it fetches its grants from the relay and opens them with the pinned owner.
   */
  private async refreshKeys(): Promise<void> {
    const { ctx, o } = this;
    if (ctx.identity.role === 'desktop-host') {
      let keyStore = o.keyStore ?? this.hostKeys;
      if (!keyStore) {
        keyStore = new MemoryKeyStore();
        await keyStore.save(ctx.identity.stored);
        this.hostKeys = keyStore;
      }
      ctx.client.identity = ctx.identity;
      let next: Identity;
      try {
        next = await refreshHostGrants(ctx.client, keyStore);
      } catch (e) {
        // Unreachable relay: retry the event later, in order. Anything else (a grant the pinned owner did not
        // seal, a changed identity) is permanent and fails closed.
        if (e instanceof RelayError && e.retryable)
          throw new TransientError(`epoch grants unavailable: ${e.message}`);
        throw e;
      }
      ctx.identity = next;
      return;
    }
    if (!o.keyStore) return;
    const id = await loadIdentity(o.keyStore);
    ctx.identity = id;
    ctx.client.identity = id;
  }

  /* ---------------- lifecycle ---------------- */

  /** Reconcile interrupted injections, connect the socket, start the retry timer. */
  async start(opts: { socket?: boolean } = {}): Promise<void> {
    if (this.state === 'running') return;
    this.state = 'running';
    this.listeners.state.forEach((l) => l(this.state));
    // A store migrated from before content was sealed still holds plaintext: seal it before anything else.
    // A failure is reported, not fatal: legacy rows stay readable, so delivery must not stop over it, and the
    // next start tries again.
    await sealStoredContent(this.ctx).catch((e) => this.emitError(e as Error));
    await this.delivery.recover();
    if (opts.socket !== false) this.socket.start();
    const every = this.o.pumpIntervalMs ?? 30_000;
    if (every > 0) {
      this.timer = setInterval(
        () => void this.pump().catch((e) => this.emitError(e as Error)),
        every,
      );
      (this.timer as { unref?: () => void }).unref?.();
    }
    void this.pump().catch((e) => this.emitError(e as Error));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket.stop();
    this.delivery.stopped = true;
    this.state = 'stopped';
    this.listeners.state.forEach((l) => l(this.state));
  }

  private markRevoked(): void {
    if (this.state === 'revoked') return;
    this.state = 'revoked';
    this.delivery.stopped = true;
    this.socket.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.state.forEach((l) => l('revoked'));
  }

  /* ---------------- Daintree-facing API ---------------- */

  /** Commits locally and returns immediately; publishing happens in the background. */
  async registerQuestion(args: {
    origin: QuestionOrigin;
    input: unknown;
  }): Promise<RegisterResult> {
    if (this.state === 'revoked')
      throw new BridgeError('forbidden', 'this device was revoked from the relay');
    const r = await this.publisher.register(args.origin, args.input);
    if (!r.duplicate) void this.pump().catch((e) => this.emitError(e as Error));
    return r;
  }

  async cancelQuestion(questionId: string, pane?: PaneIdentity): Promise<void> {
    await this.owned(questionId, pane);
    await this.publisher.enqueueCancel(questionId);
    void this.pump().catch((e) => this.emitError(e as Error));
  }

  async getDecision(questionId: string, pane?: PaneIdentity): Promise<DecisionView> {
    const row = await this.owned(questionId, pane);
    return this.view(row);
  }

  async listPending(pane?: PaneIdentity): Promise<DecisionView[]> {
    const rows = await this.ctx.store.listQuestions({
      status: ['queued', 'open', 'proxy-answered'],
    });
    return Promise.all(
      rows.filter((r) => !pane || sameAsker(r.origin, pane)).map((r) => this.view(r)),
    );
  }

  /** Only the owning pane may see or cancel a question; others get the same error as an unknown id. */
  private async owned(questionId: string, pane?: PaneIdentity): Promise<QuestionRow> {
    const row = await this.ctx.store.getQuestion(questionId);
    if (!row || (pane && !sameAsker(row.origin, pane))) {
      throw new BridgeError('not_found', 'unknown question');
    }
    return row;
  }

  /** Opens the answers in memory to build the view; nothing decrypted is written back. */
  private async view(row: QuestionRow): Promise<DecisionView> {
    const entries = await openAnswers(this.ctx, row);
    const answered = row.local_status === 'human-answered' || row.local_status === 'proxy-answered';
    // The answer in force is the last one that carried content; a later confirm-proxy makes it the human's.
    let current: OpenAnswerEntry | undefined;
    let confirmed = false;
    for (const e of entries) {
      if (e.kind !== 'answer') continue;
      if (e.action === 'confirm-proxy') confirmed = !!current;
      else {
        current = e;
        confirmed = false;
      }
    }
    const inForce = answered ? current : undefined;
    return {
      questionId: row.question_id,
      alias: row.alias,
      status: row.local_status,
      requirement: row.requirement,
      deliveryStatus: row.delivery_status,
      revision: row.question_revision,
      expiresAt: row.expires_at,
      workflowGateId: row.origin.workflow_gate_id,
      provenance: inForce
        ? confirmed
          ? 'human'
          : inForce.source === 'proxy'
            ? 'proxy'
            : 'human'
        : null,
      choice: inForce?.choices[0]?.id ?? null,
      text: inForce?.text ?? '',
      // Only a human answer that carried its own content attests to the images the phone displayed.
      reviewedDigestsMatch:
        !!inForce &&
        inForce.source === 'human' &&
        row.attachment_digests.length > 0 &&
        sameDigests(inForce.reviewed_attachment_digests, row.attachment_digests),
      answers: entries
        .filter((e) => e.kind === 'answer')
        .map((e) => ({
          revision: e.revision,
          source: e.source,
          choices: e.choices.map((c) => c.id),
          text: e.text,
          correction: e.correction,
          delivered: e.delivered,
          createdAt: e.created_at,
        })),
    };
  }

  /** The pane became idle (Daintree's wake gate): try pending deliveries now. */
  async notifyPaneIdle(): Promise<DrainResult> {
    return this.delivery.drain();
  }

  async retryDelivery(questionId: string): Promise<DrainResult> {
    await this.delivery.retry(questionId);
    return this.delivery.drain();
  }

  /* ---------------- pump ---------------- */

  /** Flush the outbox, run the proxy for new proxy-capable questions, apply inbound events, deliver. */
  pump(): Promise<void> {
    if (this.state === 'revoked' || this.state === 'stopped') return Promise.resolve();
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      try {
        const flushed = await this.publisher.flush();
        for (const id of flushed.created) await this.maybeRunProxy(id);
        if (flushed.created.length > 0) await this.publisher.flush();
        await this.inbox.processPending();
        await this.deliverNow();
        if (await this.inbox.hasGap()) await this.recoverGap();
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  private async deliverNow(): Promise<void> {
    const before = await this.ctx.store.listQuestions({
      status: ['open', 'proxy-answered', 'human-answered', 'expired'],
    });
    const r = await this.delivery.drain();
    if (r.delivered > 0) {
      for (const q of before) {
        const after = await this.ctx.store.getQuestion(q.question_id);
        if (
          after &&
          after.delivery_status === 'terminal-delivered' &&
          q.delivery_status !== 'terminal-delivered'
        ) {
          this.listeners.delivered.forEach((l) => l(q.question_id));
        }
      }
    }
  }

  /* ---------------- inbound ---------------- */

  private async onSocketEvent(ev: LedgerEvent): Promise<void> {
    const { cursor } = await this.inbox.persist(ev); // durable BEFORE the ack
    try {
      this.socket.ack(cursor);
    } catch {
      /* socket closed; the next sync re-sends from the stored cursor */
    }
    if (await this.inbox.processPending()) await this.deliverNow();
    if (await this.inbox.hasGap()) await this.recoverGap();
  }

  /** A replay segment finished: everything the relay holds up to `highWater` is now stored. */
  private async onCaughtUp(highWater: number, hasMore: boolean): Promise<void> {
    // Holes left by tombstoned (deleted) questions are legitimate; the relay's replay is authoritative.
    await this.ctx.store.forceCursor(highWater);
    const cursor = await this.ctx.store.getCursor();
    try {
      this.socket.ack(cursor);
    } catch {
      /* closed */
    }
    if (!hasMore) await this.pump();
    else if (await this.inbox.processPending()) await this.deliverNow();
  }

  private lastGap = { cursor: -1, at: 0 };

  /**
   * Events exist beyond the confirmed frontier: ask the relay for an authoritative replay of the hole
   * instead of acting on events that arrived out of order. Throttled so a persistent hole cannot loop.
   */
  async recoverGap(): Promise<void> {
    const cursor = await this.ctx.store.getCursor();
    if (cursor === this.lastGap.cursor && this.ctx.now() - this.lastGap.at < 5000) return;
    this.lastGap = { cursor, at: this.ctx.now() };
    try {
      if (this.socket.currentState === 'live' || this.socket.currentState === 'syncing')
        this.socket.syncFrom(cursor);
      else await this.catchUp();
    } catch (e) {
      this.emitError(e as Error);
    }
  }

  /**
   * HTTP catch-up (no socket): page through events after the stored cursor. After each fully persisted page
   * the cursor moves to `next_after`, which also steps over legitimate tombstone holes.
   */
  async catchUp(): Promise<number> {
    let after = await this.ctx.store.getCursor();
    for (;;) {
      const page = await this.ctx.client.events(after, LIMITS.eventPageSize);
      for (const ev of page.events) await this.inbox.persist(ev as LedgerEvent);
      await this.ctx.store.advanceCursor();
      if (page.next_after > after) {
        await this.ctx.store.forceCursor(page.next_after);
        after = page.next_after;
      } else if (page.has_more) {
        throw new Error('relay returned a page that does not advance the cursor');
      }
      if (!page.has_more) break;
    }
    const cursor = await this.ctx.store.getCursor();
    try {
      await this.ctx.client.deliveriesReceived(cursor);
    } catch {
      /* informational */
    }
    if (await this.inbox.processPending()) await this.deliverNow();
    return cursor;
  }

  /* ---------------- proxy ---------------- */

  private async maybeRunProxy(questionId: string): Promise<void> {
    const row = await this.ctx.store.getQuestion(questionId);
    if (!row || row.requirement === 'human-required' || !this.o.proxy) return;
    await this.runProxy(questionId);
  }

  /** Hard-fails for human-required questions: a proxy can never be asked about those. */
  async runProxy(questionId: string): Promise<'answered' | 'abstained' | 'skipped'> {
    const { ctx } = this;
    const row = await ctx.store.getQuestion(questionId);
    if (!row) throw new BridgeError('not_found', 'unknown question');
    if (row.requirement === 'human-required') {
      await ctx.audit.log({
        event: 'proxy.refused',
        question_id: questionId,
        requirement: row.requirement,
        result: 'human-required',
      });
      throw new BridgeError(
        'proxy_forbidden',
        'the decision model may never act on a human-required question',
      );
    }
    if (!this.o.proxy || row.local_status !== 'open') return 'skipped';
    const markerKey = `proxy:${questionId}`;
    if (await ctx.store.getMeta(markerKey)) return 'skipped';
    await ctx.store.setMeta(markerKey, 'started');

    let content: DecisionContentV1;
    try {
      content = (await openQuestionContent(ctx, row)) ?? ({} as DecisionContentV1);
    } catch {
      // Unreadable content: the model cannot see the question, so the human decides.
      await this.publisher.enqueueProxyAction('proxy-abstain', questionId);
      await ctx.store.setMeta(markerKey, 'abstained');
      await ctx.audit.log({
        event: 'proxy.abstain',
        question_id: questionId,
        requirement: row.requirement,
        result: 'content-unreadable',
      });
      return 'abstained';
    }
    // The gate is the origin's trusted one (registered by the host), never something the agent named.
    const gateId =
      row.origin.workflow_gate_id && ctx.policy.get(row.origin.workflow_gate_id)
        ? row.origin.workflow_gate_id
        : null;
    let outcome: ProxyOutcome;
    if (gateId && this.o.proxy.gateAware !== true) {
      // Fail closed: the engine cannot see the gate, so its gate-based blocks cannot run. Do not call it.
      outcome = { action: 'abstain', reason: 'engine-cannot-see-workflow-gate' };
    } else {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.o.proxyTimeoutMs ?? 25_000);
      try {
        outcome = await this.o.proxy.suggest(
          {
            questionId,
            question: content.question,
            ...(content.context ? { context: content.context } : {}),
            options: content.options ?? [],
            requirement: row.requirement,
            projectId: row.origin.project_id,
            createdAt: row.origin_created_at,
            kind: content.kind ?? 'mixed',
            ...(gateId ? { workflowGateId: gateId } : {}),
            attachments: (content.attachments ?? []).map((a) => ({
              role: a.role,
              sha256: a.sha256,
            })),
          },
          ac.signal,
        );
      } catch (e) {
        outcome = { action: 'abstain', reason: `model-error:${(e as Error).name}` };
      } finally {
        clearTimeout(timer);
      }
    }

    const optionIds = new Set((content.options ?? []).map((o) => o.id));
    const gate = ctx.policy.get(row.origin.workflow_gate_id);
    const textAllowed = content.allow_text !== false && gateAllowsText(gate);
    const valid =
      outcome.action === 'answer' &&
      outcome.risk_flags.length === 0 &&
      outcome.confidence >= 0 &&
      outcome.confidence <= 1 &&
      outcome.selected_option_ids.every(
        (id) =>
          optionIds.has(id) &&
          (!gate?.allowedOptionIds || gate.allowedOptionIds.includes(id)) &&
          (!gate?.choices || gate.choices.some((c) => c.id === id)),
      ) &&
      (!gate?.choices || outcome.selected_option_ids.length <= 1) &&
      (textAllowed || (!outcome.answer_text && outcome.selected_option_ids.length > 0)) &&
      (optionIds.size === 0 || outcome.selected_option_ids.length > 0 || !!outcome.answer_text);
    if (outcome.action === 'answer' && valid) {
      await this.publisher.enqueueProxyAction('proxy-answer', questionId, {
        content_version: 1,
        selected_option_ids: outcome.selected_option_ids,
        ...(outcome.answer_text ? { text: outcome.answer_text } : {}),
        reviewed_attachment_digests: [],
        model_id: outcome.model_id,
        prompt_template_version: outcome.prompt_template_version,
        confidence: outcome.confidence,
        retrieval_reference_ids: outcome.retrieval_reference_ids,
        ...(outcome.rationale ? { rationale: outcome.rationale } : {}),
      });
      await ctx.store.setMeta(markerKey, 'answered');
      await ctx.audit.log({
        event: 'proxy.answer',
        question_id: questionId,
        requirement: row.requirement,
        provenance: 'proxy',
        result: 'queued',
      });
      return 'answered';
    }
    await this.publisher.enqueueProxyAction('proxy-abstain', questionId);
    await ctx.store.setMeta(markerKey, 'abstained');
    await ctx.audit.log({
      event: 'proxy.abstain',
      question_id: questionId,
      requirement: row.requirement,
      // Only the reason's leading code: a model's own explanation can quote the question, so its prose is kept
      // only with debug content logging on.
      result: outcome.action === 'abstain' ? abstainCode(outcome.reason) : 'invalid-suggestion',
      ...(outcome.action === 'abstain' ? { content: outcome.reason } : {}),
    });
    return 'abstained';
  }
}

/** The machine-readable head of an abstention reason (`model-abstained: <prose>` → `model-abstained`). */
export function abstainCode(reason: string): string {
  const head = (reason.split(/[:\s]/, 1)[0] ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
  return head || 'abstained';
}
