import {
  LIMITS,
  type CommandReceipt,
  type DecisionContentV1,
  type SignedQuestion,
} from '@daintree/decisions-protocol';
import {
  buildSignedAction,
  buildSignedQuestion,
  encryptAttachment,
  encryptEnvelope,
  newId,
  nowIso,
  sniffImageMime,
} from '@daintree/decisions-crypto';
import {
  AskHumanInput,
  BridgeError,
  defaultKind,
  resolveExpiry,
  validateOptions,
} from './content.js';
import { gateHash, hostRef, paneRef, type BridgeContext } from './context.js';
import { currentEpochKey } from './identity.js';
import { RelayError } from './errors.js';
import { backoffMs } from './relay.js';
import type { OutboxItem, QuestionOrigin, QuestionRow } from './types.js';

export interface CreatePayload {
  signed: SignedQuestion;
  attachments: { attachment_id: string; ciphertext_bytes: number; sha256_ciphertext: string }[];
  uploaded: string[];
}
export interface ActionPayload {
  /** For proxy-answer: the decrypted-form content to sign at send time. */
  content?: Record<string, unknown>;
}

export interface RegisterResult {
  questionId: string;
  alias: number;
  requirement: QuestionRow['requirement'];
  status: 'queued';
  /** True when `correlation_id` matched an earlier call and the existing question was returned. */
  duplicate: boolean;
}

export class Publisher {
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
    const { ctx } = this;
    const gateId = input.workflow_gate_id ?? origin.workflow_gate_id ?? null;
    const { requirement, gate } = ctx.policy.resolve({
      gateId,
      requested: input.requested_requirement,
    });
    validateOptions(input, gate);

    // Idempotency by correlation id, scoped to the pane so one agent cannot collide with another.
    let questionId = newId(ctx.now());
    const corrKey = input.correlation_id
      ? `corr:${await paneRef(origin.host_id, origin.pane_id)}:${input.correlation_id}`
      : null;
    if (corrKey) {
      const existing = await ctx.store.getMeta(corrKey);
      if (existing) {
        const row = await ctx.store.getQuestion(existing);
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
    const expiresAt = resolveExpiry(input.expires_at, gate, now);

    // Attachments: encrypt now (so an offline desktop can publish later) and spool the ciphertext.
    const descriptors: DecisionContentV1['attachments'] = [];
    const attMeta: CreatePayload['attachments'] = [];
    const digests: string[] = [];
    let total = 0;
    for (const a of input.attachments ?? []) {
      if (!ctx.resolver)
        throw new BridgeError('attachment_error', 'attachments are not configured on this host');
      const res = await ctx.resolver.resolve(origin, a.local_resource_id);
      if (!res)
        throw new BridgeError('attachment_error', `unknown attachment "${a.local_resource_id}"`);
      const bytes = res.bytes;
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
      kind: defaultKind(input),
      options: input.options ?? [],
      attachments: descriptors,
      allow_text: true,
      project_label: origin.project_id.slice(0, 200),
      machine_label: origin.host_id.slice(0, 200),
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
      workflowGateIdHash: gateId && gate ? await gateHash(gateId) : null,
      policyVersion: gate?.policyVersion ?? null,
      expiresAt,
      attachmentIds: descriptors.map((d) => d.attachment_id),
      envelope,
      createdAt: nowIso(now),
    });

    const alias = await ctx.store.nextAlias();
    const row: QuestionRow = {
      question_id: questionId,
      alias,
      origin: { ...origin, workflow_gate_id: gate ? gateId : null },
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
      content_json: JSON.stringify(content),
      answers_json: '[]',
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

  /** Queue a cancellation; it is signed at send time against the then-current revision. */
  async enqueueCancel(questionId: string): Promise<void> {
    const { ctx } = this;
    const row = await ctx.store.getQuestion(questionId);
    if (!row) throw new BridgeError('not_found', 'unknown question');
    if (row.local_status === 'cancelled') return;
    const pendingCreate = (await ctx.store.outboxFor(questionId)).find((o) => o.kind === 'create');
    if (pendingCreate && row.local_status === 'queued') {
      // Never published: drop it entirely instead of publishing then cancelling.
      await ctx.store.deleteOutbox(pendingCreate.id);
      await this.dropSpool(pendingCreate.payload as CreatePayload);
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
    await this.ctx.store.putOutbox({
      id: newId(now),
      kind,
      question_id: questionId,
      payload: { content } satisfies ActionPayload,
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
      last_error: null,
    });
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
    for (const item of await ctx.store.dueOutbox(ctx.now(), 20)) {
      try {
        if (item.kind === 'create') {
          const receipt = await this.sendCreate(item);
          created.push(item.question_id);
          await ctx.store.updateQuestion(item.question_id, {
            local_status: 'open',
            remote_event_seq: receipt.event_seq,
            error_code: null,
          });
        } else {
          await this.sendAction(item);
        }
        await ctx.store.deleteOutbox(item.id);
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
        await ctx.store.deleteOutbox(item.id);
        if (item.kind === 'create') {
          await this.dropSpool(item.payload as CreatePayload);
          await ctx.store.updateQuestion(item.question_id, {
            local_status: 'publish-failed',
            error_code: err.code,
          });
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
    const receipt = await ctx.client.createQuestion(item.id, p.signed);
    for (const a of p.attachments) await ctx.spool.delete(a.attachment_id);
    await ctx.audit.log({
      event: 'question.published',
      question_id: item.question_id,
      result: 'ok',
    });
    return receipt;
  }

  private async sendAction(item: OutboxItem): Promise<void> {
    const { ctx } = this;
    const row = await ctx.store.getQuestion(item.question_id);
    if (!row) return;
    const kind = item.kind as 'cancel' | 'proxy-answer' | 'proxy-abstain';
    const run = async (revision: number) => {
      const epoch = currentEpochKey(ctx.identity);
      const payload = item.payload as ActionPayload;
      const envelope =
        kind === 'proxy-answer'
          ? await encryptEnvelope({
              epochKey: epoch,
              installationId: ctx.identity.config.installationId,
              questionId: item.question_id,
              recordId: newId(ctx.now()),
              recordType: 'answer',
              revision: revision + 1,
              senderDeviceId: ctx.identity.config.deviceId,
              purpose: 'answer-content',
              plaintext: payload.content ?? {},
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
      await ctx.client.postAction(kind, item.question_id, item.id, signed);
    };
    try {
      await run(row.question_revision);
    } catch (e) {
      // One transparent retry on a revision conflict, using the relay's authoritative revision.
      if (e instanceof RelayError && e.code === 'revision_conflict' && kind === 'cancel') {
        const latest = Number(e.details?.latest_revision);
        if (Number.isInteger(latest)) return run(latest);
      }
      throw e;
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
