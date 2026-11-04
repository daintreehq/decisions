import {
  AgentMessageContentV1,
  LIMITS,
  MESSAGE_RECORD_TYPE,
  knownFeatures,
  stricter,
  type CommandReceipt,
  type DecisionContentV1,
  type ProtocolFeature,
  type SignedAction,
  type SignedMessage,
  type SignedQuestion,
} from '@daintreehq/decisions-protocol';
import {
  buildSignedAction,
  buildSignedMessage,
  buildSignedQuestion,
  encryptAttachment,
  encryptEnvelope,
  newId,
  nowIso,
  sha256Hex,
  sniffImageMime,
} from '@daintreehq/decisions-crypto';
import {
  AskHumanInput,
  BridgeError,
  resolveExpiry,
  type PostMessageInput,
  shapeForGates,
  validateOptions,
} from './content.js';
import {
  MemorySpool,
  gateHash,
  hostRef,
  originScope,
  paneRef,
  type BridgeContext,
} from './context.js';
import { QUESTION_EXPIRY_LIMIT_MS } from './policy.js';
import { sameDigests } from './answers.js';
import { openProxyDraft, sealProxyDraft } from './at-rest.js';
import { currentEpochKey } from './identity.js';
import { RelayError } from './errors.js';
import { backoffMs } from './relay.js';
import type { OutboxItem, QuestionOrigin, QuestionRow } from './types.js';

export interface CreatePayload {
  /** Set (and persisted) immediately before the create request is sent: the relay may have committed it. */
  maybePublished?: boolean;
  signed: SignedQuestion;
  attachments: { attachment_id: string; ciphertext_bytes: number; sha256_ciphertext: string }[];
  uploaded: string[];
}
export interface PreparedAction {
  signed: SignedAction;
  idem: string;
  revision: number;
}
export interface ActionPayload {
  prepared?: PreparedAction;
  /** For proxy-answer: the content to encrypt and sign at send time, sealed until then (at-rest.ts). */
  sealed?: string;
  /** Plaintext form written by stores from before drafts were sealed; `sealStoredContent` replaces it. */
  content?: Record<string, unknown>;
}

/** An agent message waiting to be posted, encrypted and signed when the agent wrote it. */
export interface MessagePayload {
  /** Replayed byte for byte on every retry, so a retry after a lost reply is the same message. */
  signed: SignedMessage;
  /** The message's local number in its question's thread, from 1: one thread's messages go out in this order. */
  seq: number;
}

export interface PostMessageResult {
  questionId: string;
  messageId: string;
  alias: number;
  status: 'queued';
  expectsReply: boolean;
}

/** The relay feature that carries thread messages (docs/protocol.md section 19). */
const THREAD_FEATURE: ProtocolFeature = 'thread-messages-v1';
/** How long what the relay advertised in `GET /info` is trusted before it is read again. */
const FEATURES_TTL_MS = 60_000;
/** Agent messages committed for one question, ever: the local share of `LIMITS.messagesPerQuestion`. */
const messageCountKey = (questionId: string) => `thread-messages:${questionId}`;
const messageSeq = (o: OutboxItem) => (o.payload as MessagePayload).seq;
/** Items one flush sends at most, and how many due rows it reads to find them. */
const OUTBOX_BATCH = 20;
const OUTBOX_SCAN = 1_000;

export interface RegisterResult {
  questionId: string;
  alias: number;
  requirement: QuestionRow['requirement'];
  status: 'queued';
  /** True when `correlation_id` matched an earlier call and the existing question was returned. */
  duplicate: boolean;
}

export class Publisher {
  /** Creates currently on the wire. A cancel arriving now must become a real cancel. */
  private readonly inflight = new Set<string>();
  /** The features the relay last advertised, and when (`ctx.now()`) they were read. */
  private features: { set: ReadonlySet<ProtocolFeature>; at: number } | null = null;
  private featuresRead: Promise<ReadonlySet<ProtocolFeature>> | null = null;

  constructor(private readonly ctx: BridgeContext) {}

  /** Commit locally and return. NOTHING here touches the network. */
  async register(origin: QuestionOrigin, rawInput: unknown): Promise<RegisterResult> {
    const parsed = AskHumanInput.safeParse(rawInput);
    if (!parsed.success) {
      throw new BridgeError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const input = parsed.data;
    // The run identity comes from the host, never the agent. Without it a relaunched pane that reuses the
    // pane id could not be told apart from the run that asked, so refuse rather than guess.
    for (const k of ['ownership_principal', 'agent_incarnation'] as const) {
      const v: unknown = origin[k];
      if (typeof v !== 'string' || v.length === 0)
        throw new BridgeError('validation_error', `origin.${k} is required (set by the host)`);
    }
    const { ctx } = this;
    // The origin's gate is trusted (registered by the host) and is the floor. A gate the agent names can only
    // make the question STRICTER; it can never replace the origin's gate or relax its level.
    const gateId = origin.workflow_gate_id ?? null;
    const base = ctx.policy.resolve({ gateId, requested: input.requested_requirement });
    const gate = base.gate;
    let requirement = base.requirement;
    const callerGateId =
      input.workflow_gate_id && input.workflow_gate_id !== gateId ? input.workflow_gate_id : null;
    const callerGate = callerGateId ? ctx.policy.get(callerGateId) : undefined;
    if (callerGate) {
      requirement = stricter(
        requirement,
        ctx.policy.resolve({ gateId: callerGateId, requested: input.requested_requirement })
          .requirement,
      );
      validateOptions(input, callerGate);
    }
    validateOptions(input, gate);
    // The gate that governs the question: the origin's, or else a registered gate the agent named. Either way
    // it only adds constraints (choices, no free text, artifact binding); the level was settled above.
    const governingId = gate ? gateId : callerGate ? callerGateId : null;
    const governing = gate ?? callerGate;
    const shape = shapeForGates(input, [gate, callerGate], input.attachments?.length ?? 0);

    // Idempotency by correlation id, scoped to the pane so one agent cannot collide with another.
    let questionId = newId(ctx.now());
    const corrKey = input.correlation_id
      ? `corr:${await originScope(origin)}:${input.correlation_id}`
      : null;
    if (corrKey) {
      const existing = await ctx.store.getMeta(corrKey);
      const row = existing ? await ctx.store.getQuestion(existing) : null;
      if (row && !(await this.sameBinding(origin, input, row, governingId, requirement))) {
        // Different images, a different gate or a different level under the same correlation id are a
        // different question: an answer to the old one must never be returned for the new one. Re-point the
        // id at a fresh question.
        await ctx.store.setMeta(corrKey, questionId);
      } else if (existing) {
        if (row) {
          return {
            questionId: row.question_id,
            alias: row.alias,
            requirement: row.requirement,
            status: 'queued',
            duplicate: true,
          };
        }
        questionId = existing; // crashed between the meta write and the commit: reuse the id
      } else {
        await ctx.store.setMeta(corrKey, questionId);
      }
    }

    if (
      (await ctx.store.countOpenForPane(origin.host_id, origin.pane_id)) >=
      LIMITS.openQuestionsPerPane
    ) {
      throw new BridgeError(
        'too_many_open_questions',
        `this pane already has ${LIMITS.openQuestionsPerPane} open questions`,
      );
    }

    const epoch = currentEpochKey(ctx.identity);
    const now = ctx.now();
    // An origin gate is the host's policy. A gate the agent picked can only shorten the no-gate expiry. The
    // host's default expiry is read now, so a change to it applies from the next question on.
    const hostDefault = ctx.policy.defaultQuestionExpiryMs;
    const expiresAt = gate
      ? resolveExpiry(input.expires_at, gate, now, hostDefault)
      : earliest(
          resolveExpiry(input.expires_at, undefined, now, hostDefault),
          callerGate ? resolveExpiry(input.expires_at, callerGate, now, hostDefault) : null,
        );
    // The relay refuses a finite expiry too far ahead, and a refused question is dropped: say so now instead.
    if (expiresAt !== null && Date.parse(expiresAt) > now + QUESTION_EXPIRY_LIMIT_MS) {
      throw new BridgeError(
        'validation_error',
        'expires_at is too far ahead: the relay accepts at most 366 days, less two minutes for clock skew',
      );
    }

    // Attachments: encrypt now (so an offline desktop can publish later) and spool the ciphertext.
    const descriptors: DecisionContentV1['attachments'] = [];
    const attMeta: CreatePayload['attachments'] = [];
    const digests: string[] = [];
    let total = 0;
    for (const a of input.attachments ?? []) {
      if (ctx.store.durable && ctx.spool instanceof MemorySpool) {
        throw new BridgeError(
          'not_configured',
          'a persistent store needs a durable attachment spool (FileSpool), or queued attachments would be lost on restart',
        );
      }
      const bytes = await this.resolveAttachment(origin, a.local_resource_id);
      if (bytes.length === 0 || bytes.length > LIMITS.attachmentBytes) {
        throw new BridgeError('attachment_error', 'attachment is empty or larger than 20 MiB');
      }
      total += bytes.length;
      if (total > LIMITS.attachmentTotalBytes)
        throw new BridgeError('attachment_error', 'attachments exceed 64 MiB in total');
      const mime = sniffImageMime(bytes);
      if (!mime)
        throw new BridgeError('attachment_error', 'only PNG, JPEG and WebP images are supported');
      const attachmentId = newId(now);
      const enc = await encryptAttachment(
        epoch,
        {
          installationId: ctx.identity.config.installationId,
          questionId,
          attachmentId,
          keyEpoch: epoch.epoch,
        },
        bytes,
      );
      await ctx.spool.put(attachmentId, enc.ciphertext);
      descriptors.push({
        attachment_id: attachmentId,
        role: a.role ?? 'other',
        ...(a.alt ? { alt: a.alt } : {}),
        mime,
        size: bytes.length,
        sha256: enc.sha256Plaintext,
        nonce: enc.nonce,
        key_epoch: epoch.epoch,
      });
      digests.push(enc.sha256Plaintext);
      attMeta.push({
        attachment_id: attachmentId,
        ciphertext_bytes: enc.ciphertext.length,
        sha256_ciphertext: enc.sha256Ciphertext,
      });
    }

    const content: DecisionContentV1 = {
      content_version: 1,
      question: input.question,
      ...(input.context ? { context: input.context } : {}),
      kind: shape.kind,
      options: shape.options,
      attachments: descriptors,
      allow_text: shape.allowText,
      project_label: (origin.project_label?.trim() || origin.project_id).slice(0, 200),
      machine_label: (origin.machine_label?.trim() || origin.host_id).slice(0, 200),
      origin_summary: `${origin.agent_kind} · ${origin.worktree_id}`.slice(0, 500),
    };
    const envelope = await encryptEnvelope({
      epochKey: epoch,
      installationId: ctx.identity.config.installationId,
      questionId,
      recordId: questionId,
      recordType: 'question',
      revision: 0,
      senderDeviceId: ctx.identity.config.deviceId,
      purpose: 'question-content',
      plaintext: content,
    });
    const signed = await buildSignedQuestion({
      installationId: ctx.identity.config.installationId,
      questionId,
      signerDeviceId: ctx.identity.config.deviceId,
      signingKey: ctx.identity.keys.signing.privateKey,
      targetHostId: await hostRef(origin.host_id),
      originRef: await paneRef(origin.host_id, origin.pane_id),
      requirement,
      workflowGateIdHash: governingId ? await gateHash(governingId) : null,
      policyVersion: governing?.policyVersion ?? null,
      expiresAt,
      attachmentIds: descriptors.map((d) => d.attachment_id),
      envelope,
      createdAt: nowIso(now),
    });

    const alias = await ctx.store.nextAlias();
    const row: QuestionRow = {
      question_id: questionId,
      alias,
      origin: { ...origin, workflow_gate_id: governingId },
      requirement,
      question_revision: 0,
      remote_event_seq: null,
      origin_created_at: nowIso(now),
      expires_at: expiresAt,
      local_status: 'queued',
      delivery_status: 'not-sent',
      last_injection_id: null,
      last_attempt_at: null,
      agent_resume_strategy: null,
      error_code: null,
      // The ciphertext the relay will hold, never the plaintext: see at-rest.ts.
      content_sealed: JSON.stringify(envelope),
      answers_json: '[]',
      messages_json: '[]',
      history_only: false,
      delivered_revision: 0,
      attachment_digests: digests,
    };
    const item: OutboxItem = {
      id: newId(now),
      kind: 'create',
      question_id: questionId,
      payload: { signed, attachments: attMeta, uploaded: [] } satisfies CreatePayload,
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
      last_error: null,
    };
    await ctx.store.commitNewQuestion(row, item);
    await ctx.audit.log({
      event: 'question.queued',
      question_id: questionId,
      requirement,
      result: 'local-commit',
      content: input.question,
    });
    return { questionId, alias, requirement, status: 'queued', duplicate: false };
  }

  private async resolveAttachment(origin: QuestionOrigin, id: string): Promise<Uint8Array> {
    if (!this.ctx.resolver)
      throw new BridgeError('attachment_error', 'attachments are not configured on this host');
    const res = await this.ctx.resolver.resolve(origin, id);
    if (!res) throw new BridgeError('attachment_error', `unknown attachment "${id}"`);
    return res.bytes;
  }

  /**
   * Whether a repeat call is bound like the question it would return: the same governing gate, the same
   * enforced level and the same images (by plaintext digest).
   */
  private async sameBinding(
    origin: QuestionOrigin,
    input: AskHumanInput,
    row: QuestionRow,
    gateId: string | null,
    requirement: QuestionRow['requirement'],
  ): Promise<boolean> {
    if (row.origin.workflow_gate_id !== gateId || row.requirement !== requirement) return false;
    const asked = input.attachments ?? [];
    if (asked.length !== row.attachment_digests.length) return false;
    if (asked.length === 0) return true;
    const digests: string[] = [];
    for (const a of asked)
      digests.push(await sha256Hex(await this.resolveAttachment(origin, a.local_resource_id)));
    return sameDigests(digests, row.attachment_digests);
  }

  /**
   * Queue a cancellation; it is signed at send time against the then-current revision. Runs under `ctx.lock`, so
   * a message being committed for the same question either lands before (and is dropped with a never-sent
   * create) or sees the cancellation.
   */
  enqueueCancel(questionId: string): Promise<void> {
    return this.ctx.lock.run(() => this.enqueueCancelLocked(questionId));
  }

  private async enqueueCancelLocked(questionId: string): Promise<void> {
    const { ctx } = this;
    const row = await ctx.store.getQuestion(questionId);
    if (!row) throw new BridgeError('not_found', 'unknown question');
    if (row.local_status === 'cancelled') return;
    const pendingCreate = (await ctx.store.outboxFor(questionId)).find((o) => o.kind === 'create');
    const maybeOnRelay =
      this.inflight.has(questionId) ||
      (pendingCreate?.payload as CreatePayload | undefined)?.maybePublished === true;
    if (pendingCreate && row.local_status === 'queued' && !maybeOnRelay) {
      // Provably never sent: drop it entirely instead of publishing then cancelling.
      await ctx.store.deleteOutbox(pendingCreate.id);
      await this.dropSpool(pendingCreate.payload as CreatePayload);
      await this.dropMessages(questionId, 'never-published');
      await ctx.store.updateQuestion(questionId, { local_status: 'cancelled' });
      await ctx.audit.log({
        event: 'question.cancelled',
        question_id: questionId,
        result: 'never-published',
      });
      return;
    }
    const existing = (await ctx.store.outboxFor(questionId)).find((o) => o.kind === 'cancel');
    if (existing) return;
    const now = ctx.now();
    await ctx.store.putOutbox({
      id: newId(now),
      kind: 'cancel',
      question_id: questionId,
      payload: {},
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
      last_error: null,
    });
  }

  async enqueueProxyAction(
    kind: 'proxy-answer' | 'proxy-abstain',
    questionId: string,
    content?: Record<string, unknown>,
  ): Promise<void> {
    const now = this.ctx.now();
    const id = newId(now);
    const payload: ActionPayload = content
      ? { sealed: await sealProxyDraft(this.ctx, questionId, id, content) }
      : {};
    await this.ctx.store.putOutbox({
      id,
      kind,
      question_id: questionId,
      payload,
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
      last_error: null,
    });
  }

  /**
   * Commit an agent message for a question's thread and return. NOTHING here touches the network: the message
   * is encrypted and signed now, and the outbox posts it. The caller has already checked that the asking pane
   * owns the question. A message never changes the question's state, answer or gate.
   */
  async enqueueMessage(questionId: string, input: PostMessageInput): Promise<PostMessageResult> {
    const { ctx } = this;
    const known = this.features;
    if (known && !known.set.has(THREAD_FEATURE)) {
      // Read the relay again in the background, so an upgraded relay is picked up for the next call.
      if (ctx.now() - known.at >= FEATURES_TTL_MS) void this.relayFeatures().catch(() => undefined);
      throw new BridgeError(
        'not_supported',
        'the relay does not support follow-up messages yet; it needs updating before a follow-up can be sent',
      );
    }
    const content = AgentMessageContentV1.parse({
      content_version: 1,
      side: 'agent',
      text: input.text,
    });
    const result = await ctx.lock.run(async () => {
      const row = await ctx.store.getQuestion(questionId);
      if (!row || row.history_only) throw new BridgeError('not_found', 'unknown question');
      const q = `q-${row.alias}`;
      if (row.local_status === 'expired')
        throw new BridgeError('expired', `${q} expired, so its thread takes no more messages`);
      if (row.local_status === 'cancelled')
        throw new BridgeError(
          'invalid_state',
          `${q} was cancelled, so its thread takes no more messages`,
        );
      if (row.local_status === 'publish-failed')
        throw new BridgeError('invalid_state', `${q} was never published, so it has no thread`);
      if ((await ctx.store.outboxFor(questionId)).some((o) => o.kind === 'cancel'))
        throw new BridgeError(
          'invalid_state',
          `${q} is being cancelled, so its thread takes no more messages`,
        );
      // The relay counts both sides against one lifetime budget; here only this desktop's own messages are
      // known, so this refuses early what the relay would refuse anyway. The count is reserved before the
      // outbox write: a crash between the two wastes one message, never exceeds the budget.
      const key = messageCountKey(questionId);
      const count = Number(await ctx.store.getMeta(key)) || 0;
      if (count >= LIMITS.messagesPerQuestion)
        throw new BridgeError(
          'invalid_state',
          `${q} has reached its limit of ${LIMITS.messagesPerQuestion} messages`,
        );

      const now = ctx.now();
      const messageId = newId(now);
      const envelope = await encryptEnvelope({
        epochKey: currentEpochKey(ctx.identity),
        installationId: ctx.identity.config.installationId,
        questionId,
        recordId: messageId,
        recordType: MESSAGE_RECORD_TYPE,
        revision: 0,
        senderDeviceId: ctx.identity.config.deviceId,
        purpose: 'message-content',
        plaintext: content,
      });
      const signed = await buildSignedMessage({
        installationId: ctx.identity.config.installationId,
        questionId,
        messageId,
        side: 'agent',
        expectsReply: input.expects_reply,
        signerDeviceId: ctx.identity.config.deviceId,
        signingKey: ctx.identity.keys.signing.privateKey,
        envelope,
        createdAt: nowIso(now),
      });
      await ctx.store.setMeta(key, String(count + 1));
      await ctx.store.putOutbox({
        id: newId(now),
        kind: 'message',
        question_id: questionId,
        payload: { signed, seq: count + 1 } satisfies MessagePayload,
        attempts: 0,
        next_attempt_at: now,
        created_at: now,
        last_error: null,
      });
      return { questionId, messageId, alias: row.alias, status: 'queued' as const };
    });
    await ctx.audit.log({
      event: 'message.queued',
      question_id: questionId,
      result: 'local-commit',
      detail: { message_id: result.messageId, expects_reply: input.expects_reply },
      content: input.text,
    });
    return { ...result, expectsReply: input.expects_reply };
  }

  /** Drop a question's queued messages, which can never be posted once their question will not be. */
  private async dropMessages(questionId: string, result: string): Promise<void> {
    for (const o of await this.ctx.store.outboxFor(questionId)) {
      if (o.kind !== 'message') continue;
      await this.ctx.store.deleteOutbox(o.id);
      await this.ctx.audit.log({
        event: 'outbox.message.dropped',
        question_id: questionId,
        result,
      });
    }
  }

  /**
   * The features the relay advertises in `GET /info`, read again after `FEATURES_TTL_MS`. A relay that answers
   * `/info` with a client error advertises nothing; a network failure or 5xx throws, so the caller retries.
   */
  private relayFeatures(): Promise<ReadonlySet<ProtocolFeature>> {
    const known = this.features;
    if (known && this.ctx.now() - known.at < FEATURES_TTL_MS) return Promise.resolve(known.set);
    this.featuresRead ??= (async () => {
      try {
        let set: ReadonlySet<ProtocolFeature>;
        try {
          const info = await this.ctx.client.info();
          set = knownFeatures(Array.isArray(info?.features) ? info.features : null);
        } catch (e) {
          if (!(e instanceof RelayError) || e.retryable) throw e;
          set = new Set();
        }
        this.features = { set, at: this.ctx.now() };
        return set;
      } finally {
        this.featuresRead = null;
      }
    })();
    return this.featuresRead;
  }

  private async dropSpool(p: CreatePayload): Promise<void> {
    for (const a of p.attachments) await this.ctx.spool.delete(a.attachment_id);
  }

  /** Send everything that is due. Stops at the first transient failure so ordering is preserved. */
  async flush(): Promise<{ sent: number; failed: number; created: string[] }> {
    const { ctx } = this;
    let sent = 0;
    let failed = 0;
    const created: string[] = [];
    let features: Promise<ReadonlySet<ProtocolFeature>> | null = null; // read at most once per flush
    let attempted = 0;
    // Each question's pending items, read once per flush and kept in step with what this flush deletes, so
    // skipping a long thread costs one read rather than one per message.
    const pendingByQuestion = new Map<string, OutboxItem[]>();
    const pendingOf = async (questionId: string) => {
      let p = pendingByQuestion.get(questionId);
      if (!p) pendingByQuestion.set(questionId, (p = await ctx.store.outboxFor(questionId)));
      return p;
    };
    const remove = async (it: OutboxItem) => {
      await ctx.store.deleteOutbox(it.id);
      const p = pendingByQuestion.get(it.question_id);
      if (p)
        pendingByQuestion.set(
          it.question_id,
          p.filter((o) => o.id !== it.id),
        );
    };
    // Read well past the batch: items that must wait their turn are skipped without counting, so a long thread
    // queued behind a backed-off create never crowds other questions out of the batch.
    for (const item of await ctx.store.dueOutbox(ctx.now(), OUTBOX_SCAN)) {
      if (attempted >= OUTBOX_BATCH) break;
      if (item.kind !== 'create') {
        // Per-question ordering: an action must never overtake its own (possibly backed-off) create, and a
        // message never overtakes an earlier message in its thread, or a later "no reply needed" could land
        // before the question it settles.
        const pending = await pendingOf(item.question_id);
        if (!pending.some((o) => o.id === item.id)) continue; // dropped earlier in this flush
        if (pending.some((o) => o.kind === 'create')) continue;
        if (
          item.kind === 'message' &&
          pending.some((o) => o.kind === 'message' && messageSeq(o) < messageSeq(item))
        )
          continue;
      }
      attempted++;
      if (item.kind === 'message') {
        // Its question must still be one this desktop published and that takes messages. With no create left,
        // a question still `queued` was never published (its create was dropped or refused).
        const row = await ctx.store.getQuestion(item.question_id);
        const closed = !row
          ? 'unknown-question'
          : row.history_only
            ? 'history-only'
            : ['queued', 'cancelled', 'expired', 'publish-failed'].includes(row.local_status)
              ? row.local_status
              : null;
        if (closed) {
          failed++;
          await remove(item);
          await ctx.audit.log({
            event: 'outbox.message.dropped',
            question_id: item.question_id,
            result: closed,
          });
          continue;
        }
        // A relay that does not advertise threads is never sent one (protocol section 19). Failing to read
        // `/info` backs off this message alone, so it never holds up other questions behind it.
        let set: ReadonlySet<ProtocolFeature>;
        try {
          set = await (features ??= this.relayFeatures());
        } catch (e) {
          failed++;
          await ctx.store.recordOutboxFailure(
            item.id,
            e instanceof RelayError ? e.code : 'network_error',
            ctx.now() + backoffMs(item.attempts + 1, 2000, 300_000),
          );
          continue;
        }
        if (!set.has(THREAD_FEATURE)) {
          failed++;
          await remove(item);
          await ctx.audit.log({
            event: 'outbox.message.rejected',
            question_id: item.question_id,
            result: 'not_supported',
          });
          continue;
        }
      }
      try {
        if (item.kind === 'create') {
          const receipt = await this.sendCreate(item);
          created.push(item.question_id);
          await ctx.store.updateQuestion(item.question_id, {
            local_status: 'open',
            remote_event_seq: receipt.event_seq,
            error_code: null,
          });
        } else if (item.kind === 'message') {
          await this.sendMessage(item);
        } else {
          await this.sendAction(item);
        }
        await remove(item);
        sent++;
      } catch (e) {
        failed++;
        const err =
          e instanceof RelayError ? e : new RelayError('network_error', (e as Error).message, 0);
        if (err.retryable) {
          await ctx.store.recordOutboxFailure(
            item.id,
            err.code,
            ctx.now() +
              Math.max(err.retryAfterMs ?? 0, backoffMs(item.attempts + 1, 2000, 300_000)),
          );
          break;
        }
        // Permanent rejection: surface on the question and stop retrying it.
        await remove(item);
        if (item.kind === 'create') {
          await this.dropSpool(item.payload as CreatePayload);
          // Under the lock, so a message being committed for this question sees `publish-failed` or is dropped.
          await ctx.lock.run(async () => {
            await ctx.store.updateQuestion(item.question_id, {
              local_status: 'publish-failed',
              error_code: err.code,
            });
            await this.dropMessages(item.question_id, 'never-published');
          });
          pendingByQuestion.delete(item.question_id);
        }
        // A relay that advertised threads but has no route for them: read `/info` again next time.
        if (item.kind === 'message' && (err.status === 404 || err.status === 405)) {
          this.features = null;
        }
        await ctx.audit.log({
          event: `outbox.${item.kind}.rejected`,
          question_id: item.question_id,
          result: err.code,
        });
      }
    }
    return { sent, failed, created };
  }

  private async sendCreate(item: OutboxItem): Promise<CommandReceipt> {
    const { ctx } = this;
    const p = item.payload as CreatePayload;
    for (const a of p.attachments) {
      if (p.uploaded.includes(a.attachment_id)) continue;
      const bytes = await ctx.spool.get(a.attachment_id);
      if (!bytes) throw new RelayError('validation_error', 'spooled attachment missing', 400);
      const reservation = await ctx.client.reserveAttachment({
        idempotency_key: `att-${a.attachment_id}`.slice(0, 64),
        question_id: item.question_id,
        ciphertext_bytes: a.ciphertext_bytes,
        sha256_ciphertext: a.sha256_ciphertext,
        attachment_id: a.attachment_id,
      });
      if (reservation.attachment_id !== a.attachment_id) {
        throw new RelayError(
          'validation_error',
          'relay returned a different attachment id than the one reserved',
          400,
        );
      }
      await ctx.client.uploadAttachment(reservation.upload_path, bytes, a.sha256_ciphertext);
      await ctx.client.completeAttachment(a.attachment_id);
      p.uploaded.push(a.attachment_id);
      await ctx.store.putOutbox({ ...item, payload: p });
    }
    // From here on the relay may have committed the question even if we never see the reply.
    p.maybePublished = true;
    await ctx.store.putOutbox({ ...item, payload: p });
    this.inflight.add(item.question_id);
    let receipt;
    try {
      receipt = await ctx.client.createQuestion(item.id, p.signed);
    } finally {
      this.inflight.delete(item.question_id);
    }
    for (const a of p.attachments) await ctx.spool.delete(a.attachment_id);
    await ctx.audit.log({
      event: 'question.published',
      question_id: item.question_id,
      result: 'ok',
    });
    return receipt;
  }

  /** Post one agent message. A message never moves the revision, so there is nothing to re-sign on a retry. */
  private async sendMessage(item: OutboxItem): Promise<void> {
    const p = item.payload as MessagePayload;
    await this.ctx.client.postMessage(item.question_id, item.id, p.signed);
    await this.ctx.audit.log({
      event: 'message.published',
      question_id: item.question_id,
      result: 'ok',
      detail: { message_id: p.signed.record.message_id },
    });
  }

  private async sendAction(item: OutboxItem): Promise<void> {
    const { ctx } = this;
    const row = await ctx.store.getQuestion(item.question_id);
    if (!row) return;
    const kind = item.kind as 'cancel' | 'proxy-answer' | 'proxy-abstain';
    const payload = item.payload as ActionPayload;

    const prepare = async (revision: number, idem: string): Promise<PreparedAction> => {
      const plaintext =
        kind !== 'proxy-answer'
          ? {}
          : payload.sealed
            ? await openProxyDraft(ctx, item.question_id, item.id, payload.sealed)
            : (payload.content ?? {});
      const epoch = currentEpochKey(ctx.identity);
      const envelope =
        kind === 'proxy-answer'
          ? await encryptEnvelope({
              epochKey: epoch,
              installationId: ctx.identity.config.installationId,
              questionId: item.question_id,
              recordId: newId(ctx.now()),
              recordType: kind,
              revision: revision + 1,
              senderDeviceId: ctx.identity.config.deviceId,
              purpose: 'answer-content',
              plaintext,
            })
          : null;
      const signed = await buildSignedAction({
        installationId: ctx.identity.config.installationId,
        questionId: item.question_id,
        action: kind,
        signerDeviceId: ctx.identity.config.deviceId,
        signingKey: ctx.identity.keys.signing.privateKey,
        expectedRevision: revision,
        envelope,
      });
      return { signed, idem, revision };
    };
    // The exact signed body is persisted BEFORE the first send and replayed byte for byte. If the relay
    // committed it but the answer was lost, the retry is a true idempotent replay (same action id, signature and
    // ciphertext under the same key) instead of a different body that would collide.
    const persist = async (p: PreparedAction) => {
      payload.prepared = p;
      await ctx.store.putOutbox({ ...item, payload });
    };
    let prepared = payload.prepared;
    if (!prepared) {
      prepared = await prepare(row.question_revision, item.id);
      await persist(prepared);
    }
    try {
      await ctx.client.postAction(kind, item.question_id, prepared.idem, prepared.signed);
    } catch (e) {
      // A revision conflict means the relay did NOT commit this body, so a fresh one (new idempotency key)
      // against the authoritative revision is safe.
      if (e instanceof RelayError && e.code === 'revision_conflict' && kind === 'cancel') {
        const latest = Number(e.details?.latest_revision);
        if (Number.isInteger(latest)) {
          prepared = await prepare(latest, newId(ctx.now()));
          await persist(prepared);
          await ctx.client.postAction(kind, item.question_id, prepared.idem, prepared.signed);
        } else throw e;
      } else throw e;
    }
    await ctx.audit.log({
      event: `question.${kind}`,
      question_id: item.question_id,
      requirement: row.requirement,
      provenance: kind === 'proxy-answer' ? 'proxy' : undefined,
      result: 'sent',
    });
  }
}

/** The earlier of two expiry times; null means never. */
function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}
