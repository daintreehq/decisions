import {
  ADVISORY_ROUND_REVISION,
  AgentMessageContentV1,
  CREATE_NEVER_COMMITTED,
  DecisionContentV1,
  HumanAnswerContentV1,
  HumanMessageContentV1,
  LIMITS,
  MESSAGE_RECORD_TYPE,
  advisoryContentIssue,
  advisoryRefusal,
  canonicalize,
  knownFeatures,
  replyModeOf,
  stricter,
  type AdvisoryRefusal,
  type CommandReceipt,
  type ProtocolFeature,
  type ReplyMode,
  type Requirement,
  type SignedAction,
  type SignedMessage,
  type SignedQuestion,
} from '@daintreehq/decisions-protocol';
import {
  buildSignedAction,
  buildSignedMessage,
  buildSignedQuestion,
  decryptEnvelope,
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
  expiryOutcome,
  parseExpiresIn,
  type GatedShape,
  type PostMessageInput,
  shapeForGates,
  validateOptions,
} from './content.js';
import type { AdvisorySupport } from './advisory.js';
import {
  MemorySpool,
  gateHash,
  hostRef,
  originScope,
  paneRef,
  type BridgeContext,
} from './context.js';
import { QUESTION_EXPIRY_LIMIT_MS, answerRuleViolation, type WorkflowGate } from './policy.js';
import { parseAnswers, sameDigests, serializeAnswers } from './answers.js';
import { openProxyDraft, openQuestionContent, sealProxyDraft } from './at-rest.js';
import { currentEpochKey } from './identity.js';
import { RelayError } from './errors.js';
import { Mutex } from './mutex.js';
import {
  OWNER_ANSWER_FEATURE,
  OWNER_ANSWER_TIMEOUT_MS,
  ownerAnswerItemId,
  ownerAnswerKey,
  ownerAnswerRefusal,
  parseOwnerAnswerRecord,
  type AnswerQuestionRequest,
  type OwnerAnswerPayload,
  type OwnerAnswerRecord,
  type OwnerAnswerResult,
  type SettledOwnerAnswer,
} from './owner-answer.js';
import {
  OWNER_DECLINE_FEATURE,
  OWNER_DECLINE_TIMEOUT_MS,
  ownerDeclineFromDetail,
  ownerDeclineItemId,
  ownerDeclineKey,
  ownerDeclineRefusal,
  parseOwnerDeclineRecord,
  type DeclineQuestionRequest,
  type OwnerDeclinePayload,
  type OwnerDeclineRecord,
  type OwnerDeclineResult,
  type SettledOwnerDecline,
} from './owner-decline.js';
import {
  OWNER_MESSAGE_FEATURE,
  OWNER_MESSAGE_TIMEOUT_MS,
  ownerMessageCountKey,
  ownerMessageItemId,
  ownerMessageKey,
  ownerMessageRefusal,
  parseOwnerMessageRecord,
  type OwnerFollowUpResult,
  type OwnerMessagePayload,
  type OwnerMessageRecord,
  type SendFollowUpRequest,
  type SettledOwnerFollowUp,
} from './owner-message.js';
import { backoffMs } from './relay.js';
import type { OutboxItem, QuestionOrigin, QuestionRow } from './types.js';

/**
 * A queued create. Its publication is durable evidence: without `maybePublished` the question provably never reached
 * the relay; with it, the relay may hold the question whatever became of the reply; once a receipt or the relay's
 * history arrives, the row is no longer `queued` and the relay holds it.
 */
export interface CreatePayload {
  /**
   * Set and persisted under `ctx.lock` immediately before the create request is sent (`checkpointCreate`): the relay
   * may have committed it from then on, whatever becomes of the request. A failed request proves nothing (fetch can
   * retry a request it already sent), so it is cleared only when the relay shows it never took the question
   * (`withdrawUnpublished`).
   */
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
/** The person's follow-ups, answers and declines on the owner desktop: sent in the order they were made. */
const isPersonItem = (o: OutboxItem) =>
  o.kind === 'owner-answer' || o.kind === 'owner-decline' || o.kind === 'owner-message';
/** A person item's place on its question; an answer queued before the order was kept counts as first. */
const personSeq = (o: OutboxItem) => (o.payload as { seq?: number }).seq ?? 0;
/** A relay takes the owner desktop's follow-ups when it advertises threads and the feature itself. */
const takesOwnerMessages = (set: ReadonlySet<ProtocolFeature>) =>
  set.has(THREAD_FEATURE) && set.has(OWNER_MESSAGE_FEATURE);
/** Items one flush sends at most, and how many due rows it reads to find them. */
const OUTBOX_BATCH = 20;
const OUTBOX_SCAN = 1_000;
/**
 * How long a spooled image is kept without a create referring to it (`pruneSpool`): a question being registered,
 * here or by another process on the same store, spools its images before it commits, and a computer can sleep in
 * between.
 */
const SPOOL_GRACE_MS = 24 * 60 * 60_000;

/** A create's item went while it was being sent (withdrawn or settled): it is not written back, and not sent. */
class CreateWithdrawn extends Error {}
/** A create's deadline passed before it was first sent: it goes no further, and is settled as never published. */
class CreateOverdue extends Error {}

/**
 * Where trusted policy gave a question something other than what its agent asked for. `requested` is null when the
 * agent asked for nothing (the deadline then comes from policy); `effective` is null for a deadline that never comes.
 */
export interface PolicyAdjustment {
  field: 'expires_at' | 'requirement' | 'kind';
  requested: string | null;
  effective: string | null;
  /** The host's own policy, or a workflow gate (named by `gateId`). */
  source: 'host' | 'gate';
  gateId: string | null;
}

export interface RegisterResult {
  questionId: string;
  alias: number;
  requirement: QuestionRow['requirement'];
  status: 'queued';
  /**
   * True when `correlation_id` and the whole request matched an earlier call from this pane, and that question was
   * returned with its original deadline (it may have an answer, or have closed, since).
   */
  duplicate: boolean;
  /** The deadline the question was signed with, in UTC; null when it never expires. */
  expiresAt: string | null;
  /** The deadline the agent asked for, in UTC (`expires_in` converted once on the host clock); null if none. */
  requestedExpiresAt: string | null;
  /** `advisory` when the agent asked for advice (`planned_fallback`) and the host signed it so. */
  replyMode: ReplyMode;
  plannedFallback: string | null;
  /** Each change policy made to the request, in the order deadline, requirement, kind. */
  adjustments: PolicyAdjustment[];
}

/** What a correlated ask requested, by kind: the host default, a duration from asking, or a fixed time (UTC). */
type DeadlineRequest =
  { kind: 'default' } | { kind: 'relative'; ms: number } | { kind: 'absolute'; at: string };

/**
 * A correlated ask's registration (`reg:<question id>` in the store's meta): what it asked for beyond its signed content,
 * and the receipt it got, so an exact retry returns that receipt after a restart. No question text: the content
 * itself is compared, opened in memory (`sameRequest`).
 */
interface RegistrationRecord {
  v: 1;
  deadline: DeadlineRequest;
  /** The origin's gate id as the host bound it, registered or not. */
  originGateId: string | null;
  /** The governing gate's policy version when it was asked: a changed policy is another question. */
  policyVersion: number | null;
  namedGateId: string | null;
  requestedRequirement: Requirement | null;
  requestedExpiresAt: string | null;
  expiresAt: string | null;
  replyMode: ReplyMode;
  adjustments: PolicyAdjustment[];
}

const registrationKey = (questionId: string) => `reg:${questionId}`;

function parseRegistration(v: string | null): RegistrationRecord | null {
  if (v === null) return null;
  try {
    const r = JSON.parse(v) as Partial<RegistrationRecord> | null;
    return r && r.v === 1 && r.deadline && Array.isArray(r.adjustments)
      ? (r as RegistrationRecord)
      : null;
  } catch {
    return null;
  }
}

/**
 * The question a correlation id points at: `q`, the latest one committed, and `p`, one being committed now. A `p`
 * with a committed row wins (the process stopped before moving `q` on); one without is ignored. Before #154 the
 * value was the question id alone.
 */
function parseCorrelation(v: string | null): { q: string | null; p: string | null } {
  if (v === null) return { q: null, p: null };
  if (!v.startsWith('{')) return { q: v, p: null };
  try {
    const o = JSON.parse(v) as { q?: unknown; p?: unknown };
    return {
      q: typeof o.q === 'string' ? o.q : null,
      p: typeof o.p === 'string' ? o.p : null,
    };
  } catch {
    return { q: null, p: null };
  }
}

const sameDeadline = (a: DeadlineRequest, b: DeadlineRequest) =>
  a.kind === b.kind &&
  (a.kind !== 'relative' || a.ms === (b as typeof a).ms) &&
  (a.kind !== 'absolute' || a.at === (b as typeof a).at);

/** Why an advisory ask was refused, as the agent is told: the error code and what to do. */
const ADVISORY_REFUSALS: Record<
  AdvisoryRefusal | 'support-unknown',
  [BridgeError['code'], string]
> = {
  'relay-unsupported': ['not_supported', 'the relay does not support advisory questions yet'],
  'host-unsupported': ['not_supported', 'this host does not deliver advisory outcomes'],
  'policy-disallowed': ['forbidden', "the host's policy does not allow advisory questions"],
  'no-capable-reader': [
    'not_supported',
    'no phone or tablet the person uses can show an advisory question yet',
  ],
  gated: ['validation_error', 'a question under a workflow gate always waits for a decision'],
  approval: ['validation_error', 'an approval always waits for a decision'],
  'no-deadline': [
    'validation_error',
    "advice needs a deadline: give expires_in or expires_at, since this host's default never expires",
  ],
  'invalid-plan': [
    'validation_error',
    `planned_fallback must be 1 to ${LIMITS.plannedFallbackChars} characters and not blank`,
  ],
  'support-unknown': [
    'invalid_state',
    'whether the relay and the person’s devices support advisory questions is not known yet; try again in a minute',
  ],
};

function advisoryError(reason: AdvisoryRefusal | 'support-unknown'): BridgeError {
  const [code, why] = ADVISORY_REFUSALS[reason];
  return new BridgeError(
    code,
    `${reason}: ${why}. Nothing was asked. To have the person decide instead, ask again without planned_fallback.`,
  );
}

export interface PublisherHooks {
  /**
   * An owner-desktop answer reached its outcome (anything but `queued`), after the outcome was stored. Called once per
   * answer, from the send that settled it; an exception it throws is ignored.
   */
  onOwnerAnswer?(result: OwnerAnswerResult): void;
  /** As `onOwnerAnswer`, for a decline from `enqueueOwnerDecline`. */
  onOwnerDecline?(result: OwnerDeclineResult): void;
  /** As `onOwnerAnswer`, for the person's follow-up sent from the owner desktop. */
  onOwnerFollowUp?(result: OwnerFollowUpResult): void;
  /** One of this desktop's questions closed without ever being published. Must return without waiting. */
  onQuestionClosed?(questionId: string): void;
}

export class Publisher {
  /** Creates currently on the wire. A cancel arriving now must become a real cancel. */
  private readonly inflight = new Set<string>();
  /** The features the relay last advertised, and when (`ctx.now()`) they were read. */
  private features: { set: ReadonlySet<ProtocolFeature>; at: number } | null = null;
  private featuresRead: Promise<ReadonlySet<ProtocolFeature>> | null = null;
  /** One flush at a time, so an outbox item is never sent by two flushes at once. */
  private readonly flushing = new Mutex();

  /** Registrations under one correlation key, one at a time, so an identical retry sees the first one's question. */
  private readonly registering = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ctx: BridgeContext,
    private readonly hooks: PublisherHooks = {},
    /** Whether advice may be asked now (protocol section 21); without it every advisory ask is refused. */
    private readonly advisory?: AdvisorySupport,
  ) {}

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
    // Idempotency by correlation id, scoped to the pane so one agent cannot collide with another.
    const corrKey = input.correlation_id
      ? `corr:${await originScope(origin)}:${input.correlation_id}`
      : null;
    if (!corrKey) return this.registerParsed(origin, input, null);
    const prev = this.registering.get(corrKey) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.registerParsed(origin, input, corrKey));
    const tail = run.catch(() => undefined);
    this.registering.set(corrKey, tail);
    try {
      return await run;
    } finally {
      if (this.registering.get(corrKey) === tail) this.registering.delete(corrKey);
    }
  }

  private async registerParsed(
    origin: QuestionOrigin,
    input: AskHumanInput,
    corrKey: string | null,
  ): Promise<RegisterResult> {
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
    const replyMode: ReplyMode = input.planned_fallback !== undefined ? 'advisory' : 'blocking';
    const deadline: DeadlineRequest =
      input.expires_in !== undefined
        ? { kind: 'relative', ms: parseExpiresIn(input.expires_in)! }
        : input.expires_at !== undefined
          ? { kind: 'absolute', at: new Date(Date.parse(input.expires_at)).toISOString() }
          : { kind: 'default' };

    // An exact retry returns the question it asked, with the deadline it got then, whatever the clock or the host's
    // default says now. Anything else under the same id is a different question, and an answer to the old one must
    // never be returned for it, so it is asked afresh and the id moves to it once it is committed.
    let prior: QuestionRow | null = null;
    if (corrKey) {
      const pointer = parseCorrelation(await ctx.store.getMeta(corrKey));
      if (pointer.p) prior = await ctx.store.getQuestion(pointer.p);
      if (!prior && pointer.q) prior = await ctx.store.getQuestion(pointer.q);
      const reg = prior
        ? parseRegistration(await ctx.store.getMeta(registrationKey(prior.question_id)))
        : null;
      if (
        prior &&
        reg &&
        (await this.sameRequest(origin, input, prior, reg, {
          governingId,
          policyVersion: governing?.policyVersion ?? null,
          requirement,
          shape,
          deadline,
          replyMode,
        }))
      ) {
        return {
          questionId: prior.question_id,
          alias: prior.alias,
          requirement: prior.requirement,
          status: 'queued',
          duplicate: true,
          expiresAt: reg.expiresAt,
          requestedExpiresAt: reg.requestedExpiresAt,
          replyMode: reg.replyMode,
          plannedFallback: input.planned_fallback ?? null,
          adjustments: reg.adjustments,
        };
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

    const questionId = newId(ctx.now());
    const epoch = currentEpochKey(ctx.identity);
    // One reading of the clock: a relative deadline, the policy's caps and the signed times all count from it.
    const now = ctx.now();
    const requestedExpiresAt =
      deadline.kind === 'relative'
        ? new Date(now + deadline.ms).toISOString()
        : deadline.kind === 'absolute'
          ? deadline.at
          : null;
    // An origin gate is the host's policy. A gate the agent picked can only shorten the no-gate expiry. The
    // host's default expiry is read now, so a change to it applies from the next question on.
    const hostDefault = ctx.policy.defaultQuestionExpiryMs;
    const asked = requestedExpiresAt ?? undefined;
    let expiresAt: string | null;
    let expirySource: Pick<PolicyAdjustment, 'source' | 'gateId'> = {
      source: 'host',
      gateId: null,
    };
    if (gate) {
      expiresAt = expiryOutcome(asked, gate, now, hostDefault).expiresAt;
      // A gate without an expiry of its own leaves the host's default in place and caps nothing.
      if (gate.expiryMs !== undefined) expirySource = { source: 'gate', gateId };
    } else {
      const host = expiryOutcome(asked, undefined, now, hostDefault).expiresAt;
      const named = callerGate
        ? expiryOutcome(asked, callerGate, now, hostDefault).expiresAt
        : null;
      expiresAt = earliest(host, named);
      if (named !== null && (host === null || Date.parse(named) < Date.parse(host)))
        expirySource = { source: 'gate', gateId: callerGateId };
    }
    // The relay refuses a finite expiry too far ahead, and a refused question is dropped: say so now instead.
    if (expiresAt !== null && Date.parse(expiresAt) > now + QUESTION_EXPIRY_LIMIT_MS) {
      throw new BridgeError(
        'validation_error',
        'expires_at is too far ahead: the relay accepts at most 366 days, less two minutes for clock skew',
      );
    }
    const advisoryAsk = {
      originGateId: origin.workflow_gate_id,
      namedGateId: input.workflow_gate_id,
      kind: shape.kind,
      expiresAt,
      plannedFallback: input.planned_fallback,
    };
    if (replyMode === 'advisory') await this.admitAdvisory(advisoryAsk);
    const adjustments = policyAdjustments({
      input,
      requestedExpiresAt,
      expiresAt,
      expirySource,
      requirement,
      baseRequirement: base.requirement,
      shape,
      gates: [
        [gate, gateId],
        [callerGate, callerGateId],
      ],
    });

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

    // Reading the images waited on disk: what allowed advice may have changed meanwhile (the policy, a revoked reader,
    // a stopped bridge), so it is decided again where nothing waits before the signature.
    if (replyMode === 'advisory' && descriptors.length > 0) {
      try {
        await this.admitAdvisory(advisoryAsk);
      } catch (e) {
        for (const d of descriptors) await ctx.spool.delete(d.attachment_id).catch(() => undefined);
        throw e;
      }
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
      ...(input.preparation ? { preparation: input.preparation } : {}),
      ...(replyMode === 'advisory' ? { planned_fallback: input.planned_fallback } : {}),
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
      ...(replyMode === 'advisory' ? { replyMode: 'advisory' as const } : {}),
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
    if (corrKey) {
      const reg: RegistrationRecord = {
        v: 1,
        deadline,
        originGateId: origin.workflow_gate_id ?? null,
        policyVersion: governing?.policyVersion ?? null,
        namedGateId: input.workflow_gate_id ?? null,
        requestedRequirement: input.requested_requirement ?? null,
        requestedExpiresAt,
        expiresAt,
        replyMode,
        adjustments,
      };
      await ctx.store.setMeta(registrationKey(questionId), JSON.stringify(reg));
      // Staged beside the question it replaces, which stays in force unless this commit lands; a process that stops
      // after the commit finds the staged one committed and takes it.
      await ctx.store.setMeta(
        corrKey,
        JSON.stringify({ q: prior?.question_id ?? null, p: questionId }),
      );
    }
    await ctx.store.commitNewQuestion(row, item);
    // The staged id already names this question now that it is committed, so this only tidies the pointer.
    if (corrKey)
      await ctx.store.setMeta(corrKey, JSON.stringify({ q: questionId })).catch(() => undefined);
    await ctx.audit.log({
      event: 'question.queued',
      question_id: questionId,
      requirement,
      result: 'local-commit',
      content: input.question,
    });
    return {
      questionId,
      alias,
      requirement,
      status: 'queued',
      duplicate: false,
      expiresAt,
      requestedExpiresAt,
      replyMode,
      plannedFallback: input.planned_fallback ?? null,
      adjustments,
    };
  }

  /**
   * Refuses an advisory ask the host may not sign (protocol section 21, `advisoryRefusal`). The host's own rules are
   * checked first; then what the relay and the person's devices support, as last read in the background. Unknown
   * support refuses too, and starts a read, so a retry a moment later can be decided.
   */
  private async admitAdvisory(
    q: Pick<
      Parameters<typeof advisoryRefusal>[0],
      'originGateId' | 'namedGateId' | 'kind' | 'expiresAt' | 'plannedFallback'
    >,
  ): Promise<void> {
    const facts = {
      ...q,
      hostSupport: this.advisory?.hostSupport === true,
      policyAllows: this.ctx.policy.advisoryQuestions,
    };
    const local = advisoryRefusal({ ...facts, relaySupport: true, readerSupport: true });
    if (local) throw advisoryError(local);
    const known = await this.advisory!.known();
    if (known.relay === null || (known.relay && known.reader === null)) {
      void this.advisory!.refreshIfDue();
      throw advisoryError('support-unknown');
    }
    const remote = advisoryRefusal({
      ...facts,
      relaySupport: known.relay,
      readerSupport: known.reader === true,
    });
    if (remote) throw advisoryError(remote);
  }

  private async resolveAttachment(origin: QuestionOrigin, id: string): Promise<Uint8Array> {
    if (!this.ctx.resolver)
      throw new BridgeError('attachment_error', 'attachments are not configured on this host');
    const res = await this.ctx.resolver.resolve(origin, id);
    if (!res) throw new BridgeError('attachment_error', `unknown attachment "${id}"`);
    return res.bytes;
  }

  /**
   * Whether a repeat call asks exactly what `row` asked: the same governing gate, enforced level, named gate and
   * requested level, the same deadline request and reply mode, and the same content the person would see (question,
   * context, kind, options, text rule, preparation, plan, and the images in order with their roles and captions,
   * by plaintext digest). The stored content is opened in memory with the keys this identity holds; content it
   * cannot open is never taken as the same.
   */
  private async sameRequest(
    origin: QuestionOrigin,
    input: AskHumanInput,
    row: QuestionRow,
    reg: RegistrationRecord,
    asked: {
      governingId: string | null;
      policyVersion: number | null;
      requirement: QuestionRow['requirement'];
      shape: GatedShape;
      deadline: DeadlineRequest;
      replyMode: ReplyMode;
    },
  ): Promise<boolean> {
    if (row.origin.workflow_gate_id !== asked.governingId || row.requirement !== asked.requirement)
      return false;
    if (
      // Raw ids, registered or not: a gate bound since, even one the policy does not know, makes it another question.
      reg.originGateId !== (origin.workflow_gate_id ?? null) ||
      reg.policyVersion !== asked.policyVersion ||
      reg.namedGateId !== (input.workflow_gate_id ?? null) ||
      reg.requestedRequirement !== (input.requested_requirement ?? null) ||
      reg.replyMode !== asked.replyMode ||
      !sameDeadline(reg.deadline, asked.deadline)
    )
      return false;
    const images = input.attachments ?? [];
    if (images.length !== row.attachment_digests.length) return false;
    const digests: string[] = [];
    for (const a of images)
      digests.push(await sha256Hex(await this.resolveAttachment(origin, a.local_resource_id)));
    if (!sameDigests(digests, row.attachment_digests)) return false;
    let stored: DecisionContentV1 | null;
    try {
      // The identity alone: deciding whether a retry is the same must never fetch keys from the relay.
      stored = await openQuestionContent({ identity: this.ctx.identity }, row);
    } catch {
      return false;
    }
    if (!stored) return false;
    try {
      return (
        canonicalize(requestOf(stored)) ===
        canonicalize(
          requestOf({
            question: input.question,
            ...(input.context ? { context: input.context } : {}),
            kind: asked.shape.kind,
            options: asked.shape.options,
            allow_text: asked.shape.allowText,
            ...(input.preparation ? { preparation: input.preparation } : {}),
            ...(input.planned_fallback !== undefined
              ? { planned_fallback: input.planned_fallback }
              : {}),
            attachments: images.map((a, i) => ({
              sha256: digests[i]!,
              role: a.role ?? 'other',
              ...(a.alt ? { alt: a.alt } : {}),
            })),
          }),
        )
      );
    } catch {
      return false;
    }
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
      // Provably never sent: drop it entirely instead of publishing then cancelling. The row closes first, so a
      // crash before the create goes leaves one the next flush drops (`closeCreate`), never one it sends. A create
      // being uploaded right now finds its item gone and stops (`checkpointCreate`).
      await ctx.store.updateQuestion(questionId, { local_status: 'cancelled' });
      await this.dropMessages(questionId, 'never-published');
      await ctx.store.deleteOutbox(pendingCreate.id);
      await this.dropSpool(pendingCreate.payload as CreatePayload);
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
   * Commit the person's answer, given on the owner desktop, and return. NOTHING here touches the network: the answer is
   * encrypted and signed now, against the revision the person reviewed, and the outbox posts it, replaying the same
   * body on every retry. It needs no local row, so a Remote Host's question is answered the same way; the owner's own
   * question is first checked against its rules, so an answer its desktop would refuse is not sent. An answer id seen
   * before returns that submission (with its outcome once it has one) instead of signing a second answer, and is
   * refused for any other answer. Runs under `ctx.lock`, as settling does, so the two never interleave.
   */
  enqueueOwnerAnswer(
    input: AnswerQuestionRequest,
  ): Promise<{ answerId: string; settled: OwnerAnswerResult | null }> {
    return this.ctx.lock.run(async () => {
      const { ctx } = this;
      if (ctx.identity.role !== 'owner-desktop') {
        throw new BridgeError(
          'forbidden',
          "only the owner desktop answers for the person; a Remote Host never signs the person's answer",
        );
      }
      const qid = input.questionId;
      const text = input.text?.trim() ? input.text : undefined;
      if (input.selectedOptionIds.length === 0 && !text)
        throw new BridgeError('validation_error', 'choose an option or write an answer');
      const parsed = HumanAnswerContentV1.safeParse({
        content_version: 1,
        selected_option_ids: input.selectedOptionIds,
        ...(text ? { text } : {}),
        reviewed_attachment_digests: input.reviewedAttachmentDigests,
        ...(input.explicitApproval !== undefined
          ? { explicit_approval: input.explicitApproval }
          : {}),
        ...(input.reason?.trim() ? { reason: input.reason } : {}),
      });
      if (!parsed.success) {
        throw new BridgeError(
          'validation_error',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const content = parsed.data;
      const answerId = input.answerId ?? newId(ctx.now());
      const key = ownerAnswerKey(answerId);
      const itemId = ownerAnswerItemId(answerId);
      const record = parseOwnerAnswerRecord(await ctx.store.getMeta(key));
      if (record) {
        if (!(await this.sameOwnerAnswer(record, qid, input.expectedRevision, content))) {
          throw new BridgeError(
            'validation_error',
            'this answer id was already used for a different answer',
          );
        }
        if (record.result) return { answerId, settled: record.result };
        if ((await ctx.store.outboxFor(qid)).some((o) => o.id === itemId))
          return { answerId, settled: null };
        // Reserved but never queued (the record is written first and the item deleted only once settled): nothing
        // was sent, so it is signed again below.
      }

      // The owner's own question: hold the answer to the rules its desktop checks it against (inbox.ts). Content it
      // cannot open here, its desktop cannot open either, and would refuse the answer for.
      const row = await ctx.store.getQuestion(qid);
      if (row && !row.history_only) {
        let question: Partial<DecisionContentV1>;
        try {
          question = (await openQuestionContent(ctx, row)) ?? {};
        } catch {
          throw new BridgeError(
            'invalid_state',
            "this question's content cannot be opened on this computer, so it cannot be answered here",
          );
        }
        const broken = answerRuleViolation(
          question,
          ctx.policy.get(row.origin.workflow_gate_id),
          content.selected_option_ids,
          content.text ?? '',
        );
        if (broken) {
          throw new BridgeError(
            'validation_error',
            `the answer breaks the question's rules: ${broken.replace(/_/g, ' ')}`,
          );
        }
      }

      const envelope = await encryptEnvelope({
        epochKey: currentEpochKey(ctx.identity),
        installationId: ctx.identity.config.installationId,
        questionId: qid,
        recordId: answerId,
        recordType: 'answer',
        revision: input.expectedRevision + 1,
        senderDeviceId: ctx.identity.config.deviceId,
        purpose: 'answer-content',
        plaintext: content,
      });
      const signed = await buildSignedAction({
        installationId: ctx.identity.config.installationId,
        questionId: qid,
        action: 'answer',
        signerDeviceId: ctx.identity.config.deviceId,
        signingKey: ctx.identity.keys.signing.privateKey,
        expectedRevision: input.expectedRevision,
        envelope,
        actionId: answerId,
      });
      const now = ctx.now();
      // The id is reserved before the item exists, so a crash in between leaves a record that is signed again.
      const reserved: OwnerAnswerRecord = {
        question_id: qid,
        expected_revision: input.expectedRevision,
        envelope,
        result: null,
      };
      await ctx.store.setMeta(key, JSON.stringify(reserved));
      const payload: OwnerAnswerPayload = { signed, seq: await this.nextPersonSeq(qid) };
      await ctx.store.putOutbox({
        id: itemId,
        kind: 'owner-answer',
        question_id: qid,
        payload,
        attempts: 0,
        next_attempt_at: now,
        created_at: now,
        last_error: null,
      });
      await ctx.audit.log({
        event: 'owner-answer.queued',
        question_id: qid,
        provenance: 'human-desktop',
        result: 'queued',
      });
      return { answerId, settled: null };
    });
  }

  /** Whether a stored submission is this answer: the same question and revision, and the same content once opened. */
  private async sameOwnerAnswer(
    record: OwnerAnswerRecord,
    questionId: string,
    expectedRevision: number,
    content: unknown,
  ): Promise<boolean> {
    if (record.question_id !== questionId || record.expected_revision !== expectedRevision)
      return false;
    try {
      const prior = await decryptEnvelope(record.envelope, this.ctx.identity.epochs, {
        installationId: this.ctx.identity.config.installationId,
        questionId,
        recordType: 'answer',
        revision: expectedRevision + 1,
      });
      return canonicalize(prior) === canonicalize(content);
    } catch {
      return false;
    }
  }

  /** Where an owner-desktop answer stands, by its id; null for an id never submitted (or never queued) on this store. */
  ownerAnswerResult(answerId: string): Promise<OwnerAnswerResult | null> {
    // Under `ctx.lock`, so it never sees an answer between its reservation and its item, or its outcome and removal.
    return this.ctx.lock.run(async () => {
      const r = parseOwnerAnswerRecord(await this.ctx.store.getMeta(ownerAnswerKey(answerId)));
      if (!r) return null;
      if (r.result) return r.result;
      // Reserved but never queued (a crash in between): nothing was sent, and a repeat of the id signs it again.
      const itemId = ownerAnswerItemId(answerId);
      if (!(await this.ctx.store.outboxFor(r.question_id)).some((o) => o.id === itemId))
        return null;
      return {
        answerId,
        questionId: r.question_id,
        expectedRevision: r.expected_revision,
        status: 'queued',
      };
    });
  }

  /**
   * Commit the person's decline, made on the owner desktop, and return. NOTHING here touches the network: the decline is
   * signed now, a `cancel` carrying `decline: true` against the revision the person saw (section 6.1), and the outbox
   * posts it, replaying the same body on every retry. It needs no local row, so a Remote Host's question is declined the
   * same way. A decline id seen before returns that submission (with its outcome once it has one) instead of signing a
   * second decline, and is refused for any other question or revision. Runs under `ctx.lock`, as settling does.
   */
  enqueueOwnerDecline(
    input: DeclineQuestionRequest,
  ): Promise<{ declineId: string; settled: OwnerDeclineResult | null }> {
    return this.ctx.lock.run(async () => {
      const { ctx } = this;
      if (ctx.identity.role !== 'owner-desktop') {
        throw new BridgeError(
          'forbidden',
          "only the owner desktop declines for the person; a Remote Host never signs the person's decline",
        );
      }
      const qid = input.questionId;
      const declineId = input.declineId ?? newId(ctx.now());
      const key = ownerDeclineKey(declineId);
      const itemId = ownerDeclineItemId(declineId);
      const record = parseOwnerDeclineRecord(await ctx.store.getMeta(key));
      if (record) {
        if (record.question_id !== qid || record.expected_revision !== input.expectedRevision) {
          throw new BridgeError(
            'validation_error',
            'this decline id was already used for a different question or revision',
          );
        }
        if (record.result) return { declineId, settled: record.result };
        if ((await ctx.store.outboxFor(qid)).some((o) => o.id === itemId))
          return { declineId, settled: null };
        // Reserved but never queued: nothing was sent, so it is signed again below.
      }
      const signed = await buildSignedAction({
        installationId: ctx.identity.config.installationId,
        questionId: qid,
        action: 'cancel',
        signerDeviceId: ctx.identity.config.deviceId,
        signingKey: ctx.identity.keys.signing.privateKey,
        expectedRevision: input.expectedRevision,
        decline: true,
        actionId: declineId,
      });
      const now = ctx.now();
      // The id is reserved before the item exists, so a crash in between leaves a record that is signed again.
      const reserved: OwnerDeclineRecord = {
        question_id: qid,
        expected_revision: input.expectedRevision,
        result: null,
      };
      await ctx.store.setMeta(key, JSON.stringify(reserved));
      const payload: OwnerDeclinePayload = { signed, seq: await this.nextPersonSeq(qid) };
      await ctx.store.putOutbox({
        id: itemId,
        kind: 'owner-decline',
        question_id: qid,
        payload,
        attempts: 0,
        next_attempt_at: now,
        created_at: now,
        last_error: null,
      });
      await ctx.audit.log({ event: 'owner-decline.queued', question_id: qid, result: 'queued' });
      return { declineId, settled: null };
    });
  }

  /** Where an owner-desktop decline stands, by its id; null for an id never submitted (or never queued) on this store. */
  ownerDeclineResult(declineId: string): Promise<OwnerDeclineResult | null> {
    return this.ctx.lock.run(async () => {
      const r = parseOwnerDeclineRecord(await this.ctx.store.getMeta(ownerDeclineKey(declineId)));
      if (!r) return null;
      if (r.result) return r.result;
      const itemId = ownerDeclineItemId(declineId);
      if (!(await this.ctx.store.outboxFor(r.question_id)).some((o) => o.id === itemId))
        return null;
      return {
        declineId,
        questionId: r.question_id,
        expectedRevision: r.expected_revision,
        status: 'queued',
      };
    });
  }

  /**
   * Commit the person's follow-up, written on the owner desktop, and return. NOTHING here touches the network: the
   * message is encrypted and signed now as the person's (`side: human`, no images, never expecting a reply, as a phone
   * sends it), and the outbox posts it, replaying the same body on every retry. It needs no local row, so a Remote
   * Host's question takes one the same way. A follow-up id seen before returns that submission (with its outcome once
   * it has one) instead of signing a second message, and is refused for any other text or question. Runs under
   * `ctx.lock`, as settling does, so the two never interleave.
   */
  enqueueOwnerMessage(
    input: SendFollowUpRequest,
  ): Promise<{ messageId: string; settled: OwnerFollowUpResult | null }> {
    return this.ctx.lock.run(async () => {
      const { ctx } = this;
      if (ctx.identity.role !== 'owner-desktop') {
        throw new BridgeError(
          'forbidden',
          "only the owner desktop sends the person's follow-up; a Remote Host never speaks for the person",
        );
      }
      const qid = input.questionId;
      const parsed = HumanMessageContentV1.safeParse({
        content_version: 1,
        side: 'human',
        text: input.text,
        images: [],
      });
      if (!parsed.success) {
        throw new BridgeError(
          'validation_error',
          parsed.error.issues
            .map((i) => `${[...i.path].join('.') || 'text'}: ${i.message}`)
            .join('; '),
        );
      }
      const content = parsed.data;
      const messageId = input.messageId ?? newId(ctx.now());
      const key = ownerMessageKey(messageId);
      const record = parseOwnerMessageRecord(await ctx.store.getMeta(key));
      if (record) {
        if (record.question_id !== qid || !(await this.sameOwnerMessage(record, content))) {
          throw new BridgeError(
            'validation_error',
            'this follow-up id was already used for a different follow-up',
          );
        }
        if (record.result) return { messageId, settled: record.result };
        // Reserved but never queued (the record is written first and the item deleted only once settled): queue the
        // message that was signed then, so a retry is the same message.
        if (!(await ctx.store.outboxFor(qid)).some((o) => o.id === ownerMessageItemId(messageId)))
          await this.queueOwnerMessage(record);
        return { messageId, settled: null };
      }

      const now = ctx.now();
      const envelope = await encryptEnvelope({
        epochKey: currentEpochKey(ctx.identity),
        installationId: ctx.identity.config.installationId,
        questionId: qid,
        recordId: messageId,
        recordType: MESSAGE_RECORD_TYPE,
        revision: 0,
        senderDeviceId: ctx.identity.config.deviceId,
        purpose: 'message-content',
        plaintext: content,
      });
      const signed = await buildSignedMessage({
        installationId: ctx.identity.config.installationId,
        questionId: qid,
        messageId,
        side: 'human',
        expectsReply: false,
        attachmentIds: [],
        signerDeviceId: ctx.identity.config.deviceId,
        signingKey: ctx.identity.keys.signing.privateKey,
        envelope,
        createdAt: nowIso(now),
      });
      const seq = await this.nextPersonSeq(qid);
      // The id is reserved with its signed message before the item exists: a crash in between queues that message.
      const reserved: OwnerMessageRecord = { question_id: qid, signed, seq, result: null };
      await ctx.store.setMeta(key, JSON.stringify(reserved));
      await this.queueOwnerMessage(reserved);
      await ctx.audit.log({
        event: 'owner-message.queued',
        question_id: qid,
        provenance: 'human-desktop',
        result: 'queued',
      });
      return { messageId, settled: null };
    });
  }

  private async queueOwnerMessage(r: OwnerMessageRecord): Promise<void> {
    const now = this.ctx.now();
    const payload: OwnerMessagePayload = { signed: r.signed, seq: r.seq };
    await this.ctx.store.putOutbox({
      id: ownerMessageItemId(r.signed.record.message_id),
      kind: 'owner-message',
      question_id: r.question_id,
      payload,
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
      last_error: null,
    });
  }

  /** Whether a stored follow-up says the same as this one, once its ciphertext is opened. */
  private async sameOwnerMessage(record: OwnerMessageRecord, content: unknown): Promise<boolean> {
    try {
      const prior = await decryptEnvelope(record.signed.envelope, this.ctx.identity.epochs, {
        installationId: this.ctx.identity.config.installationId,
        questionId: record.question_id,
        recordType: MESSAGE_RECORD_TYPE,
        revision: 0,
      });
      return canonicalize(prior) === canonicalize(content);
    } catch {
      return false;
    }
  }

  /** Where a follow-up from the owner desktop stands, by its id; null for an id never submitted (or never queued). */
  ownerMessageResult(messageId: string): Promise<OwnerFollowUpResult | null> {
    // Under `ctx.lock`, so it never sees a follow-up between its reservation and its item, or its outcome and removal.
    return this.ctx.lock.run(async () => {
      const r = parseOwnerMessageRecord(await this.ctx.store.getMeta(ownerMessageKey(messageId)));
      if (!r) return null;
      if (r.result) return r.result;
      const itemId = ownerMessageItemId(messageId);
      if (!(await this.ctx.store.outboxFor(r.question_id)).some((o) => o.id === itemId))
        return null;
      return { messageId, questionId: r.question_id, status: 'queued' };
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
          const info = await this.ctx.client.info(OWNER_ANSWER_TIMEOUT_MS);
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

  /**
   * The next place among the person's follow-ups, answers and declines from this computer on a question, whatever
   * the clock says. Call under `ctx.lock`.
   */
  private async nextPersonSeq(questionId: string): Promise<number> {
    const key = ownerMessageCountKey(questionId);
    const seq = (Number(await this.ctx.store.getMeta(key)) || 0) + 1;
    await this.ctx.store.setMeta(key, String(seq));
    return seq;
  }

  private async dropSpool(p: CreatePayload): Promise<void> {
    for (const a of p.attachments) await this.ctx.spool.delete(a.attachment_id);
  }

  /**
   * Send everything that is due, or with `only` that one item if it is due and nothing it must wait for is pending.
   * Stops at the first transient failure so ordering is preserved. One flush runs at a time; `proceed`, asked once
   * this flush's turn comes, can call it off (a bridge stopped while it waited).
   */
  flush(
    opts: { only?: string; proceed?: () => boolean } = {},
  ): Promise<{ sent: number; failed: number; created: string[] }> {
    return this.flushing.run(() =>
      opts.proceed && !opts.proceed()
        ? Promise.resolve({ sent: 0, failed: 0, created: [] })
        : this.flushDue(opts.only, opts.proceed),
    );
  }

  private async flushDue(
    only: string | undefined,
    proceed?: () => boolean,
  ): Promise<{ sent: number; failed: number; created: string[] }> {
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
    /** Drop a settled owner-desktop answer's item and tell the host (`PublisherHooks`). */
    const finish = async (item: OutboxItem, result: OwnerAnswerResult) => {
      await ctx.lock.run(() => remove(item));
      try {
        this.hooks.onOwnerAnswer?.(result);
      } catch {
        /* the host's listener; the outcome is stored either way */
      }
    };
    /**
     * Store an owner-desktop answer's outcome, then drop its item and tell the host. Under `ctx.lock`, like
     * `enqueueOwnerAnswer`, so a repeated submission never sees the item gone without its outcome.
     */
    const settle = async (item: OutboxItem, outcome: SettledOwnerAnswer) => {
      const { signed } = item.payload as OwnerAnswerPayload;
      const result = {
        answerId: signed.record.action_id,
        questionId: item.question_id,
        expectedRevision: signed.record.expected_revision,
        ...outcome,
      } as OwnerAnswerResult;
      const record: OwnerAnswerRecord = {
        question_id: item.question_id,
        expected_revision: result.expectedRevision,
        envelope: signed.envelope!,
        result,
      };
      await ctx.lock.run(async () => {
        await ctx.store.setMeta(ownerAnswerKey(result.answerId), JSON.stringify(record));
        await remove(item);
      });
      try {
        this.hooks.onOwnerAnswer?.(result);
      } catch {
        /* the host's listener; the outcome is stored either way */
      }
      await ctx.audit
        .log({
          event:
            outcome.status === 'sent' ? 'question.owner-answer' : 'outbox.owner-answer.rejected',
          question_id: item.question_id,
          provenance: 'human-desktop',
          result:
            outcome.status === 'closed'
              ? `closed:${outcome.reason}`
              : outcome.status === 'unsupported'
                ? `unsupported:${outcome.by}`
                : outcome.status === 'rejected'
                  ? outcome.code
                  : outcome.status,
        })
        .catch(() => undefined);
    };
    /** Drop a settled follow-up's item and tell the host, as `finish` does for an answer. */
    const finishMessage = async (item: OutboxItem, result: OwnerFollowUpResult) => {
      await ctx.lock.run(() => remove(item));
      try {
        this.hooks.onOwnerFollowUp?.(result);
      } catch {
        /* the host's listener; the outcome is stored either way */
      }
    };
    /** Store a follow-up's outcome, then drop its item and tell the host, as `settle` does for an answer. */
    const settleMessage = async (item: OutboxItem, outcome: SettledOwnerFollowUp) => {
      const { signed, seq } = item.payload as OwnerMessagePayload;
      const result = {
        messageId: signed.record.message_id,
        questionId: item.question_id,
        ...outcome,
      } as OwnerFollowUpResult;
      const record: OwnerMessageRecord = { question_id: item.question_id, signed, seq, result };
      await ctx.lock.run(async () => {
        await ctx.store.setMeta(ownerMessageKey(result.messageId), JSON.stringify(record));
        await remove(item);
      });
      try {
        this.hooks.onOwnerFollowUp?.(result);
      } catch {
        /* the host's listener; the outcome is stored either way */
      }
      await ctx.audit
        .log({
          event:
            outcome.status === 'sent' ? 'question.owner-message' : 'outbox.owner-message.rejected',
          question_id: item.question_id,
          provenance: 'human-desktop',
          result:
            outcome.status === 'closed'
              ? `closed:${outcome.reason}`
              : outcome.status === 'unsupported'
                ? `unsupported:${outcome.by}`
                : outcome.status === 'rejected'
                  ? outcome.code
                  : outcome.status,
        })
        .catch(() => undefined);
    };
    // Read well past the batch: items that must wait their turn are skipped without counting, so a long thread
    // queued behind a backed-off create never crowds other questions out of the batch.
    const due: OutboxItem[] = [];
    for (const item of await ctx.store.dueOutbox(ctx.now(), OUTBOX_SCAN)) {
      // Local work first, whatever the network does: a create no send could change is settled or dropped here,
      // never left behind a transient failure that stops this flush.
      if (item.kind === 'create' && (await this.closeCreate(item))) continue;
      due.push(item);
    }
    for (const item of due) {
      if (only !== undefined && item.id !== only) continue;
      if (attempted >= OUTBOX_BATCH) break;
      if (item.kind !== 'create') {
        // Per-question ordering: an action must never overtake its own (possibly backed-off) create, a message
        // never overtakes an earlier message in its thread, or a later "no reply needed" could land before the
        // question it settles, and the person's answer, decline or follow-up never overtakes a withdrawal already queued
        // or one of their own made before it (a clarification queued offline reaches the agent before the approval).
        const pending = await pendingOf(item.question_id);
        if (!pending.some((o) => o.id === item.id)) continue; // dropped earlier in this flush
        const person = isPersonItem(item);
        if (pending.some((o) => o.kind === 'create' || (person && o.kind === 'cancel'))) continue;
        if (
          item.kind === 'message' &&
          pending.some((o) => o.kind === 'message' && messageSeq(o) < messageSeq(item))
        )
          continue;
        if (person && pending.some((o) => isPersonItem(o) && personSeq(o) < personSeq(item)))
          continue;
      }
      if (
        (item.kind === 'cancel' || item.kind === 'proxy-answer' || item.kind === 'proxy-abstain') &&
        (await this.unpublishedQuestion(item.question_id))
      ) {
        // Left by a crash after its question closed unpublished: there is nothing on the relay to act on.
        await remove(item);
        await ctx.audit.log({
          event: `outbox.${item.kind}.dropped`,
          question_id: item.question_id,
          result: 'never-published',
        });
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
      // The person's item on one of this desktop's questions that never reached the relay: nothing there can take it,
      // so it closes here, with no network, once any outcome it already had is kept.
      const unpublished = isPersonItem(item) && (await this.unpublishedQuestion(item.question_id));
      if (item.kind === 'owner-decline') {
        const step = await this.flushOwnerDecline(
          item,
          () => (features ??= this.relayFeatures()),
          remove,
          proceed,
          unpublished,
        );
        if (step === 'declined') sent++;
        else failed++;
        if (step === 'stop') break;
        continue;
      }
      if (item.kind === 'owner-answer') {
        // Settled before a crash kept it from being dropped: its outcome stands, and it is never sent again.
        const { signed } = item.payload as OwnerAnswerPayload;
        const stored = parseOwnerAnswerRecord(
          await ctx.store.getMeta(ownerAnswerKey(signed.record.action_id)),
        );
        if (stored?.result) {
          await finish(item, stored.result);
          continue;
        }
        if (unpublished) {
          failed++;
          await settle(item, { status: 'closed', reason: 'not-found' });
          continue;
        }
        // A relay that does not advertise owner-desktop answers would refuse the role: it is never sent one.
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
        if (!set.has(OWNER_ANSWER_FEATURE)) {
          failed++;
          await settle(item, { status: 'unsupported', by: 'relay' });
          continue;
        }
      }
      if (item.kind === 'owner-message') {
        // Settled before a crash kept it from being dropped: its outcome stands, and it is never sent again.
        const { signed } = item.payload as OwnerMessagePayload;
        const stored = parseOwnerMessageRecord(
          await ctx.store.getMeta(ownerMessageKey(signed.record.message_id)),
        );
        if (stored?.result) {
          await finishMessage(item, stored.result);
          continue;
        }
        if (unpublished) {
          failed++;
          await settleMessage(item, { status: 'closed', reason: 'not-found' });
          continue;
        }
        // A relay that does not advertise threads and the owner desktop's follow-ups would refuse it: never sent one.
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
        if (!takesOwnerMessages(set)) {
          failed++;
          await settleMessage(item, { status: 'unsupported', by: 'relay' });
          continue;
        }
      }
      // A bridge stopped while this flush read the relay's features sends nothing more.
      if (proceed && !proceed()) break;
      try {
        if (item.kind === 'create') {
          const receipt = await this.sendCreate(item);
          created.push(item.question_id);
          // A retry after a lost reply replays the original receipt, which can be older than the history already
          // applied (an answer, an expiry): only a question still queued takes it. Under the lock, like the inbox.
          await ctx.lock.run(async () => {
            const row = await ctx.store.getQuestion(item.question_id);
            if (row?.local_status !== 'queued') return;
            await ctx.store.updateQuestion(item.question_id, {
              local_status: 'open',
              remote_event_seq: receipt.event_seq,
              error_code: null,
            });
          });
        } else if (item.kind === 'message') {
          await this.sendMessage(item);
        } else if (item.kind === 'owner-answer') {
          await this.sendOwnerAnswer(item);
          await settle(item, { status: 'sent' });
          sent++;
          continue;
        } else if (item.kind === 'owner-message') {
          await this.sendOwnerMessage(item);
          await settleMessage(item, { status: 'sent' });
          sent++;
          continue;
        } else {
          await this.sendAction(item);
        }
        await remove(item);
        sent++;
      } catch (e) {
        if (e instanceof CreateWithdrawn) {
          pendingByQuestion.delete(item.question_id);
          continue;
        }
        failed++;
        if (e instanceof CreateOverdue) {
          await this.settleUnpublished(item.question_id, true);
          pendingByQuestion.delete(item.question_id);
          continue;
        }
        const err =
          e instanceof RelayError ? e : new RelayError('network_error', (e as Error).message, 0);
        if (err.retryable) {
          let next =
            ctx.now() +
            Math.max(err.retryAfterMs ?? 0, backoffMs(item.attempts + 1, 2000, 300_000));
          // A create still provably unsent is due again by its deadline at the latest, where it is settled with no
          // network at all (`closeCreate`): backing off never moves the outcome past the deadline.
          const p = item.payload as CreatePayload;
          const deadline = item.kind === 'create' ? deadlineOf(p) : null;
          if (deadline !== null && !p.maybePublished) next = Math.min(next, deadline);
          await ctx.store.recordOutboxFailure(item.id, err.code, next);
          break;
        }
        if (item.kind === 'owner-answer') {
          let outcome = ownerAnswerRefusal(err);
          if (err.status === 403) {
            // The role refused: a relay that stopped advertising owner-desktop answers no longer takes them.
            this.features = null;
            const set = await this.relayFeatures().catch(() => null);
            if (set && !set.has(OWNER_ANSWER_FEATURE))
              outcome = { status: 'unsupported', by: 'relay' };
          }
          await settle(item, outcome);
          continue;
        }
        if (item.kind === 'owner-message') {
          let outcome = ownerMessageRefusal(err);
          if (err.status === 403) {
            // The role refused: a relay that stopped advertising the owner desktop's follow-ups no longer takes them.
            this.features = null;
            const set = await this.relayFeatures().catch(() => null);
            if (set && !takesOwnerMessages(set)) outcome = { status: 'unsupported', by: 'relay' };
          }
          await settleMessage(item, outcome ?? (await this.diagnoseOwnerMessage(item.question_id)));
          continue;
        }
        // Permanent rejection: surface on the question and stop retrying it.
        if (item.kind === 'create') {
          const p = item.payload as CreatePayload;
          // The relay shows it never took a question by this id, past the deadline (protocol section 6).
          const never = err.status === 400 && err.details?.reason === CREATE_NEVER_COMMITTED;
          if (!(never && (await this.settleUnpublished(item.question_id, false)))) {
            // Under the lock, so a message being committed for this question sees `publish-failed` or is dropped.
            // The row closes before the create goes, so a crash in between is finished by `closeCreate`. A row the
            // relay's history has already moved on (a receipt lost, then its answer or expiry applied) keeps that
            // outcome: only the leftover create goes.
            const refused = await ctx.lock.run(async () => {
              const row = await ctx.store.getQuestion(item.question_id);
              const queued = row?.local_status === 'queued';
              if (queued) {
                await ctx.store.updateQuestion(item.question_id, {
                  local_status: 'publish-failed',
                  error_code: err.code,
                });
                await this.dropMessages(item.question_id, 'never-published');
              }
              await ctx.store.deleteOutbox(item.id);
              return queued;
            });
            await this.dropSpool(p);
            if (refused) this.closed(item.question_id);
          }
          pendingByQuestion.delete(item.question_id);
        } else {
          await remove(item);
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

  /**
   * Upload a create's images, then send it. Each step is checked against the item as stored, under `ctx.lock`: a
   * create withdrawn or settled meanwhile is never written back or sent (`CreateWithdrawn`), and one whose deadline
   * passed before it was first sent goes no further, with no stale image uploaded (`CreateOverdue`). Once claimed
   * (`maybePublished`), the relay may hold the question whatever becomes of the reply.
   */
  private async sendCreate(item: OutboxItem): Promise<CommandReceipt> {
    const { ctx } = this;
    const p = item.payload as CreatePayload;
    for (const a of p.attachments) {
      if (p.uploaded.includes(a.attachment_id)) continue;
      if (!p.maybePublished && this.overdue(p)) throw new CreateOverdue();
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
      // The reservation may have answered after the deadline: no image goes up once it has passed.
      if (!p.maybePublished && this.overdue(p)) throw new CreateOverdue();
      try {
        await ctx.client.uploadAttachment(reservation.upload_path, bytes, a.sha256_ciphertext);
      } catch (e) {
        // Uploaded before a crash kept it from being recorded: the relay takes no second upload, and completing it
        // (idempotent once it is available) answers for it.
        if (!(e instanceof RelayError && e.code === 'invalid_state')) throw e;
      }
      await ctx.client.completeAttachment(a.attachment_id);
      p.uploaded.push(a.attachment_id);
      await this.checkpointCreate(item, p, false);
    }
    // From here on the relay may have committed the question even if we never see the reply.
    await this.checkpointCreate(item, p, true);
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

  /**
   * Store a create's progress, or with `claim` mark it possibly published, against the item as stored now, under
   * `ctx.lock` (as `enqueueCancel` reads it). An item gone meanwhile is never written back. A claim of a create never
   * sent before is refused once its deadline has passed. A claim already stored, by an earlier send or another
   * sender, stands.
   */
  private checkpointCreate(item: OutboxItem, p: CreatePayload, claim: boolean): Promise<void> {
    return this.ctx.lock.run(async () => {
      const live = (await this.ctx.store.outboxFor(item.question_id)).find((o) => o.id === item.id);
      if (!live) throw new CreateWithdrawn();
      const stored = live.payload as CreatePayload;
      if (claim && !stored.maybePublished && this.overdue(p)) throw new CreateOverdue();
      if (claim || stored.maybePublished) p.maybePublished = true;
      await this.ctx.store.putOutbox({ ...live, payload: p });
    });
  }

  /**
   * Under `ctx.lock`: close a question withdrawn before it was ever published, as `enqueueCancel` does for a create it
   * finds unsent, or one the relay has shown it never took. The row closes first; then its queued work goes, the person's own items aside (they close on their
   * next turn, `unpublishedQuestion`). The caller drops the spooled images.
   */
  private async withdrawUnpublished(questionId: string, items: OutboxItem[]): Promise<void> {
    // Its creates are unsent first, so a crash before they go leaves ones the next flush drops (`closeCreate`), never
    // ones it sends.
    for (const o of items) {
      const p = o.payload as CreatePayload;
      if (o.kind !== 'create' || !p.maybePublished) continue;
      const { maybePublished: _claimed, ...unsent } = p;
      await this.ctx.store.putOutbox({ ...o, payload: unsent });
    }
    await this.ctx.store.updateQuestion(questionId, { local_status: 'cancelled' });
    await this.dropMessages(questionId, 'never-published');
    for (const o of items)
      if (o.kind !== 'message' && !isPersonItem(o)) await this.ctx.store.deleteOutbox(o.id);
    await this.ctx.audit.log({
      event: 'question.cancelled',
      question_id: questionId,
      result: 'never-published',
    });
  }

  /** The create's signed deadline has passed on this computer's clock. */
  private overdue(p: CreatePayload): boolean {
    const deadline = deadlineOf(p);
    return deadline !== null && deadline <= this.ctx.now();
  }

  /**
   * Settle or drop a create no send could change, with no network. True when its item is gone. A create whose row
   * already closed is what a crash left of a settlement, refusal or withdrawal: it goes with its images. One never
   * sent whose deadline has passed is settled as never published (`settleUnpublished`). A create that may have
   * reached the relay is never concluded here: only the relay's answer to its retry settles it. Every decision reads
   * the row and the item again under `ctx.lock`, so a claim another process has made since is seen.
   */
  private async closeCreate(item: OutboxItem): Promise<boolean> {
    if (!this.overdue(item.payload as CreatePayload)) {
      const row = await this.ctx.store.getQuestion(item.question_id);
      if (row && row.local_status !== 'publish-failed' && row.local_status !== 'cancelled')
        return false;
    }
    const dropped = await this.ctx.lock.run(async () => {
      const row = await this.ctx.store.getQuestion(item.question_id);
      const live = (await this.ctx.store.outboxFor(item.question_id)).find((o) => o.id === item.id);
      if (!live) return 'gone' as const;
      const p = live.payload as CreatePayload;
      if (
        !row ||
        row.local_status === 'publish-failed' ||
        (row.local_status === 'cancelled' && !p.maybePublished)
      ) {
        await this.ctx.store.deleteOutbox(item.id);
        return p;
      }
      return row.local_status === 'queued' && !p.maybePublished && this.overdue(p)
        ? ('overdue' as const)
        : null;
    });
    if (dropped === null) return false;
    if (dropped === 'overdue') return this.settleUnpublished(item.question_id, true);
    if (dropped !== 'gone') await this.dropSpool(dropped);
    return true;
  }

  /**
   * Close a question whose deadline passed before it reached the relay: `publish-failed`, with an `unpublished`
   * system entry that tells its agent no answer could be recorded. The row closes in one write before any of its items
   * go, so a crash in between is finished by the next flush (`closeCreate`, `unpublishedQuestion`). What waited for the
   * create goes with it: agent messages, proxy work, the spooled images; the person's own items from the owner desktop
   * close on their next turn. A withdrawal queued for it wins: the question closes as withdrawn, with no notice. The
   * original deadline is kept. With `unsent`, it settles only a question whose create is still provably unsent when
   * read again under `ctx.lock`; without, the relay has just shown it never took the create. True when the question
   * is closed (or already was).
   */
  private async settleUnpublished(questionId: string, unsent: boolean): Promise<boolean> {
    const { ctx } = this;
    let creates: OutboxItem[] = [];
    let fallbackDue = false;
    const settled = await ctx.lock.run(async () => {
      const row = await ctx.store.getQuestion(questionId);
      // A question the relay's history has reached meanwhile is the relay's to settle: nothing of it is touched.
      if (row && row.local_status !== 'queued' && row.local_status !== 'publish-failed')
        return false;
      const items = await ctx.store.outboxFor(questionId);
      creates = items.filter((o) => o.kind === 'create');
      // Claimed since it was read (another process sending it): it may be on the relay now.
      if (unsent && creates.some((o) => (o.payload as CreatePayload).maybePublished)) return false;
      if (row?.local_status !== 'queued') {
        await this.dropMessages(questionId, 'never-published');
        for (const o of items)
          if (o.kind !== 'message' && !isPersonItem(o)) await ctx.store.deleteOutbox(o.id);
        return 'cleaned' as const;
      }
      if (items.some((o) => o.kind === 'cancel')) {
        await this.withdrawUnpublished(questionId, items);
        return 'withdrawn' as const;
      }
      // The host's policy is read as the question closes, as the relay judges an expiry at its deadline.
      fallbackDue = creates[0] ? await this.advisoryFallbackDue(row, creates[0]) : false;
      const entries = parseAnswers(row.answers_json);
      entries.push({
        entry_id: `unpublished-${questionId}`,
        kind: 'unpublished',
        action: 'expire',
        revision: row.question_revision,
        source: 'system',
        ...(fallbackDue ? { fallback_due: true } : {}),
        correction: false,
        created_at: nowIso(ctx.now()),
        deliver: true,
        delivered: false,
        sealed: null,
      });
      await ctx.store.updateQuestion(questionId, {
        local_status: 'publish-failed',
        delivery_status: 'desktop-received',
        error_code: 'never_published',
        answers_json: serializeAnswers(entries),
      });
      await this.dropMessages(questionId, 'never-published');
      for (const o of items)
        if (o.kind !== 'message' && !isPersonItem(o)) await ctx.store.deleteOutbox(o.id);
      return 'settled' as const;
    });
    if (!settled) return false;
    for (const o of creates) await this.dropSpool(o.payload as CreatePayload);
    if (settled === 'settled') {
      await ctx.audit.log({
        event: 'question.unpublished',
        question_id: questionId,
        result: fallbackDue ? 'deadline-passed:fallback-due' : 'deadline-passed',
      });
    }
    if (settled !== 'cleaned') this.closed(questionId);
    return true;
  }

  /**
   * One of this desktop's own questions that never reached the relay: settled so at its deadline
   * (`settleUnpublished`), or withdrawn before it was ever sent (`cancelled`, with no relay event ever applied).
   */
  private async unpublishedQuestion(questionId: string): Promise<boolean> {
    const row = await this.ctx.store.getQuestion(questionId);
    if (!row || row.history_only) return false;
    if (row.local_status === 'cancelled') return row.remote_event_seq === null;
    return (
      row.local_status === 'publish-failed' &&
      parseAnswers(row.answers_json).some((e) => e.kind === 'unpublished')
    );
  }

  /**
   * Whether an advisory question that never reached the relay may still tell its agent its plan is due (protocol
   * section 21). Read from the create as it was signed: advisory content at round 0 under no gate, whose decrypted
   * content parses with a valid plan, and a host that both delivers advisory outcomes and, by its trusted policy now,
   * allows advisory questions. A blocking question, and every advisory one the policy does not allow, authorises
   * nothing.
   */
  private async advisoryFallbackDue(row: QuestionRow, create: OutboxItem): Promise<boolean> {
    if (!this.advisory?.hostSupport || !this.ctx.policy.advisoryQuestions) return false;
    const { signed } = create.payload as CreatePayload;
    const envelope = signed.envelope;
    if (
      replyModeOf(envelope) !== 'advisory' ||
      envelope.aad.revision !== ADVISORY_ROUND_REVISION ||
      row.question_revision !== ADVISORY_ROUND_REVISION ||
      signed.record.workflow_gate_id_hash !== null ||
      row.origin.workflow_gate_id !== null ||
      signed.record.expires_at === null
    )
      return false;
    try {
      const raw = await openQuestionContent(this.ctx, {
        question_id: row.question_id,
        content_sealed: JSON.stringify(envelope),
      });
      const content = DecisionContentV1.safeParse(raw);
      return content.success && advisoryContentIssue({ envelope }, content.data) === null;
    } catch {
      return false;
    }
  }

  private closed(questionId: string): void {
    try {
      this.hooks.onQuestionClosed?.(questionId);
    } catch {
      /* the host's listener */
    }
  }

  /**
   * Delete spooled images no queued create needs (`AttachmentSpool.prune`): what a crash left between spooling an
   * image and committing its question, or between dropping a create and its images. An image spooled in the last
   * `SPOOL_GRACE_MS` is kept, for a question still being registered. Returns how many were deleted.
   */
  async pruneSpool(): Promise<number> {
    const { spool, store } = this.ctx;
    if (!spool.prune) return 0;
    const keep = new Set<string>();
    for (const o of await store.dueOutbox(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) {
      if (o.kind !== 'create') continue;
      for (const a of (o.payload as CreatePayload).attachments) keep.add(a.attachment_id);
    }
    // File times are wall-clock time, whatever clock the bridge was given.
    const n = await spool.prune(keep, Date.now() - SPOOL_GRACE_MS);
    if (n > 0) await this.ctx.audit.log({ event: 'spool.pruned', result: String(n) });
    return n;
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

  /**
   * One flush's turn for an owner-desktop decline. It is posted exactly as it was signed, never signed again. Once the
   * relay has answered the post, it is settled from the question's action log (`ownerDeclineFromDetail`), because a
   * cancel the relay takes, a retry of one it took and a cancel of a question already closed all answer alike. A
   * transient failure keeps the item for the outbox's retries: `stop` when the flush should stop there, as for every
   * other item, and `retry` when only this item backs off.
   */
  private async flushOwnerDecline(
    item: OutboxItem,
    features: () => Promise<ReadonlySet<ProtocolFeature>>,
    remove: (it: OutboxItem) => Promise<void>,
    proceed?: () => boolean,
    /** Its question is one of this desktop's that never reached the relay: it closes with no network. */
    unpublished = false,
  ): Promise<'declined' | 'settled' | 'retry' | 'stop'> {
    const { ctx } = this;
    const payload = item.payload as OwnerDeclinePayload;
    const { signed } = payload;
    const declineId = signed.record.action_id;
    const backOff = (e: unknown) => {
      const err = e instanceof RelayError ? e : null;
      return ctx.store.recordOutboxFailure(
        item.id,
        err?.code ?? 'network_error',
        ctx.now() + Math.max(err?.retryAfterMs ?? 0, backoffMs(item.attempts + 1, 2000, 300_000)),
      );
    };
    const tell = (result: OwnerDeclineResult) => {
      try {
        this.hooks.onOwnerDecline?.(result);
      } catch {
        /* the host's listener; the outcome is stored either way */
      }
    };
    /** Store the outcome, then drop the item and tell the host, under `ctx.lock` like `enqueueOwnerDecline`. */
    const settle = async (outcome: SettledOwnerDecline) => {
      const result = {
        declineId,
        questionId: item.question_id,
        expectedRevision: signed.record.expected_revision,
        ...outcome,
      } as OwnerDeclineResult;
      const record: OwnerDeclineRecord = {
        question_id: item.question_id,
        expected_revision: result.expectedRevision,
        result,
      };
      await ctx.lock.run(async () => {
        await ctx.store.setMeta(ownerDeclineKey(declineId), JSON.stringify(record));
        await remove(item);
      });
      tell(result);
      await ctx.audit
        .log({
          event:
            outcome.status === 'declined'
              ? 'question.owner-decline'
              : 'outbox.owner-decline.rejected',
          question_id: item.question_id,
          result:
            outcome.status === 'closed'
              ? `closed:${outcome.reason}`
              : outcome.status === 'unsupported'
                ? `unsupported:${outcome.by}`
                : outcome.status === 'rejected'
                  ? outcome.code
                  : outcome.status,
        })
        .catch(() => undefined);
      return outcome.status === 'declined' ? ('declined' as const) : ('settled' as const);
    };

    // Settled before a crash kept it from being dropped: its outcome stands, and it is never sent again.
    const stored = parseOwnerDeclineRecord(await ctx.store.getMeta(ownerDeclineKey(declineId)));
    if (stored?.result) {
      await ctx.lock.run(() => remove(item));
      tell(stored.result);
      return stored.result.status === 'declined' ? 'declined' : 'settled';
    }
    if (unpublished) return settle({ status: 'closed', reason: 'not-found' });

    // Set when the relay no longer takes declines but this one was sent before and may have been taken then (its answer
    // lost): only the question can say, and anything but finding it there is `unsupported`.
    let unsupported = false;
    if (!payload.confirming) {
      const wasSent = payload.sent === true;
      // A relay that does not advertise owner-desktop declines would refuse the flag: it is never sent one.
      let set: ReadonlySet<ProtocolFeature>;
      try {
        set = await features();
      } catch (e) {
        await backOff(e);
        return 'retry';
      }
      if (!set.has(OWNER_DECLINE_FEATURE)) {
        if (!wasSent) return settle({ status: 'unsupported', by: 'relay' });
        unsupported = true;
      } else {
        // A bridge stopped while this flush read the relay's features sends nothing more, as for every other item.
        if (proceed && !proceed()) return 'stop';
        if (!wasSent) {
          // Marked before the first post, so a send whose answer is lost is never taken for one that never went.
          payload.sent = true;
          await ctx.store.putOutbox({ ...item, payload });
          if (proceed && !proceed()) return 'stop';
        }
        try {
          await ctx.client.postAction('cancel', item.question_id, declineId, signed, {
            retry: false,
            timeoutMs: OWNER_DECLINE_TIMEOUT_MS,
          });
        } catch (e) {
          const err =
            e instanceof RelayError ? e : new RelayError('network_error', (e as Error).message, 0);
          if (err.retryable) {
            await backOff(err);
            return 'stop';
          }
          let outcome = ownerDeclineRefusal(err);
          if (err.status === 403) {
            // The flag refused: a relay that stopped advertising owner-desktop declines no longer takes them.
            this.features = null;
            const now = await this.relayFeatures().catch(() => null);
            if (now && !now.has(OWNER_DECLINE_FEATURE))
              outcome = { status: 'unsupported', by: 'relay' };
            else if (!now && wasSent) {
              // Whether it took this decline before it stopped taking them can wait until it can be asked.
              await backOff(err);
              return 'retry';
            }
          }
          if (outcome?.status === 'unsupported' && outcome.by === 'relay' && wasSent)
            unsupported = true;
          else if (outcome) return settle(outcome);
          // Otherwise refused for a state the error does not name: the question says which.
        }
        if (!unsupported) {
          // From here on it is settled from the question alone, and never posted again.
          payload.confirming = true;
          await ctx.store.putOutbox({ ...item, payload });
        }
      }
    }

    if (proceed && !proceed()) return 'stop';
    let detail: unknown;
    try {
      detail = await ctx.client.getQuestion(item.question_id, {
        retry: false,
        timeoutMs: OWNER_DECLINE_TIMEOUT_MS,
      });
    } catch (e) {
      const err =
        e instanceof RelayError ? e : new RelayError('network_error', (e as Error).message, 0);
      if (err.retryable) {
        await backOff(err);
        return 'stop';
      }
      return settle(
        err.code === 'not_found'
          ? { status: 'closed', reason: 'not-found' }
          : { status: 'rejected', code: err.code },
      );
    }
    const found = ownerDeclineFromDetail(detail, signed) ?? {
      status: 'rejected' as const,
      code: 'malformed_question',
    };
    return settle(
      unsupported && found.status !== 'declined' ? { status: 'unsupported', by: 'relay' } : found,
    );
  }

  /**
   * Post the owner desktop's answer exactly as it was signed. It is never signed again: a conflict means the question
   * moved on from what the person reviewed, which only they can answer again. The outbox retries a transient failure,
   * so the request itself does not.
   */
  private async sendOwnerAnswer(item: OutboxItem): Promise<void> {
    const { signed } = item.payload as OwnerAnswerPayload;
    await this.ctx.client.postAction('answer', item.question_id, signed.record.action_id, signed, {
      retry: false,
      timeoutMs: OWNER_ANSWER_TIMEOUT_MS,
    });
  }

  /**
   * Post the person's follow-up exactly as it was signed. A message never moves the revision, so there is nothing to
   * sign again; the outbox retries a transient failure, so the request itself does not.
   */
  private async sendOwnerMessage(item: OutboxItem): Promise<void> {
    const { signed } = item.payload as OwnerMessagePayload;
    await this.ctx.client.postMessage(item.question_id, signed.record.message_id, signed, {
      retry: false,
      timeoutMs: OWNER_MESSAGE_TIMEOUT_MS,
    });
  }

  /**
   * Tell a bare `invalid_state` refusal of a follow-up apart by reading the question: closed when the relay now
   * reports it cancelled or expired, and otherwise (a thread at its message limit, a desktop that takes no messages,
   * or a question that cannot be read) `rejected` with that code. Never by the refusal's message.
   */
  private async diagnoseOwnerMessage(questionId: string): Promise<SettledOwnerFollowUp> {
    try {
      const q = await this.ctx.client.getQuestion(questionId, {
        retry: false,
        timeoutMs: OWNER_MESSAGE_TIMEOUT_MS,
      });
      if (q?.status === 'cancelled') return { status: 'closed', reason: 'cancelled' };
      if (q?.status === 'expired') return { status: 'closed', reason: 'expired' };
    } catch {
      /* unreadable now: the refusal stands as it was */
    }
    return { status: 'rejected', code: 'invalid_state' };
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
/** The parts of a question's content its agent chose, for comparing a retry with the question it may repeat. */
function requestOf(c: {
  question: string;
  context?: string | undefined;
  kind: string;
  options: readonly { id: string; label: string; description?: string | undefined }[];
  allow_text?: boolean | undefined;
  preparation?: unknown;
  planned_fallback?: string | undefined;
  attachments: readonly { sha256: string; role: string; alt?: string | undefined }[];
}): unknown {
  return {
    question: c.question,
    context: c.context ?? null,
    kind: c.kind,
    options: c.options.map((o) => ({
      id: o.id,
      label: o.label,
      description: o.description ?? null,
    })),
    allow_text: c.allow_text !== false,
    preparation: c.preparation ?? null,
    planned_fallback: c.planned_fallback ?? null,
    attachments: c.attachments.map((a) => ({ sha256: a.sha256, role: a.role, alt: a.alt ?? null })),
  };
}

/**
 * What trusted policy changed in a request: a deadline it capped or chose, a level it raised, a kind its gates set.
 * Each change names the policy that made it: an origin gate, a gate the agent named, or the host's own.
 */
function policyAdjustments(a: {
  input: AskHumanInput;
  requestedExpiresAt: string | null;
  expiresAt: string | null;
  expirySource: Pick<PolicyAdjustment, 'source' | 'gateId'>;
  requirement: Requirement;
  /** The level the origin's gate, or the host, gave before any gate the agent named. */
  baseRequirement: Requirement;
  shape: GatedShape;
  gates: [WorkflowGate | undefined, string | null][];
}): PolicyAdjustment[] {
  const out: PolicyAdjustment[] = [];
  const host = { source: 'host', gateId: null } as const;
  const gate = (id: string | null) => ({ source: 'gate', gateId: id }) as const;
  if (a.expiresAt !== a.requestedExpiresAt)
    out.push({
      field: 'expires_at',
      requested: a.requestedExpiresAt,
      effective: a.expiresAt,
      ...a.expirySource,
    });
  const asked = a.input.requested_requirement;
  if (asked && asked !== a.requirement) {
    const [origin, originId] = a.gates[0]!;
    const [, namedId] = a.gates[1]!;
    // Named for the level that applies: the named gate when it raised the level further, else the origin's gate (or
    // the host, with none).
    out.push({
      field: 'requirement',
      requested: asked,
      effective: a.requirement,
      ...(a.requirement !== a.baseRequirement ? gate(namedId) : origin ? gate(originId) : host),
    });
  }
  const kind = a.input.kind;
  if (kind && kind !== a.shape.kind) {
    // The rule that set the kind: images bound to the answer make it an approval, a gate that takes no text makes it
    // a choice, and a gate's choices turn a text question into one with options.
    const by =
      a.shape.kind === 'approval'
        ? a.gates.find(([g]) => g?.bindArtifacts)
        : a.shape.kind === 'choice'
          ? a.gates.find(([g]) => g && (g.allowText ?? !g.choices) === false)
          : a.gates.find(([g]) => g?.choices);
    out.push({
      field: 'kind',
      requested: kind,
      effective: a.shape.kind,
      ...(by ? gate(by[1]) : host),
    });
  }
  return out;
}

/** A create's signed deadline in ms, or null for a question that never expires. */
function deadlineOf(p: CreatePayload): number | null {
  const at = p.signed.record.expires_at;
  return at ? Date.parse(at) : null;
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}
