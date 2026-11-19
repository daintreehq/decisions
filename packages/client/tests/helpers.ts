import {
  AgentStoppedPushBody,
  ApiError,
  CREATOR_MISSING_FEATURE,
  EventData,
  LIMITS,
  applyAction,
  applyMessage,
  type QuestionStatus,
  PROTOCOL_VERSION,
  type ActionKind,
  type CryptoEnvelope,
  type DeviceCert,
  type EpochGrant,
  type InvolvementRecord,
  type LedgerEvent,
  type Provenance,
  type SignedAction,
  type SignedMessage,
  type SignedQuestion,
} from '@daintreehq/decisions-protocol';
import {
  buildSignedAction,
  buildSignedMessage,
  createEpochGrant,
  decryptEnvelope,
  encryptEnvelope,
  exportPublicKey,
  generateDeviceKeys,
  generateEpochKeyBytes,
  issueDeviceCert,
  newId,
  serializeDeviceKeys,
  type DeviceKeys,
  type EpochKey,
} from '@daintreehq/decisions-crypto';
import { base64UrlToBytes, bytesToBase64Url } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  MemoryKeyStore,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  importIdentity,
  type BridgeOptions,
  type Identity,
  type InjectResult,
  type LocateResult,
  type QuestionOrigin,
  type TerminalSink,
  type TerminalTarget,
  type UnavailableReason,
  type WebSocketLike,
} from '../src/index.js';

export async function makeIdentity(): Promise<Identity> {
  const keys = await generateDeviceKeys(true);
  const raw = generateEpochKeyBytes();
  const deviceId = newId();
  return importIdentity({
    v: 1,
    config: {
      relayOrigin: 'https://relay.test',
      installationId: newId(),
      deviceId,
      label: 'Test Mac',
    },
    keys: await serializeDeviceKeys(keys),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(raw) }],
    currentEpoch: 1,
  });
}

export interface Phone {
  deviceId: string;
  keys: DeviceKeys;
  cert: DeviceCert;
}

export async function makePhone(
  owner: Identity,
  role: 'phone' | 'tablet' | 'owner-desktop' | 'desktop-host' = 'phone',
): Promise<Phone> {
  const keys = await generateDeviceKeys(false);
  const deviceId = newId();
  const cert = await issueDeviceCert({
    issuerDeviceId: owner.config.deviceId,
    issuerSigningKey: owner.keys.signing.privateKey,
    installationId: owner.config.installationId,
    deviceId,
    role,
    label: 'Test phone',
    signingPub: await exportPublicKey(keys.signing.publicKey),
    exchangePub: await exportPublicKey(keys.exchange.publicKey),
  });
  return { deviceId, keys, cert };
}

export const origin = (over: Partial<QuestionOrigin> = {}): QuestionOrigin => ({
  host_id: 'host-local',
  pane_id: 'pane-1',
  terminal_generation: 1,
  ownership_principal: 'principal-1',
  agent_incarnation: 'inc-1',
  agent_kind: 'claude',
  agent_session_id: 'sess-1',
  project_id: 'proj-1',
  worktree_id: 'wt-1',
  worktree_root: '/work/proj-1',
  workflow_gate_id: null,
  ...over,
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** In-memory relay behind `fetch`. It does not verify HTTP signatures (the Worker tests do that). */
export class FakeRelay {
  questions = new Map<string, { signed: SignedQuestion; idem: string }>();
  events: LedgerEvent[] = [];
  calls: {
    method: string;
    path: string;
    query: string;
    body: unknown;
    headers: Record<string, string>;
  }[] = [];
  devices: DeviceCert[] = [];
  down = 0; // number of upcoming requests that should fail with a network error
  status5xx = 0;
  rejectCreate: number | null = null;
  receipts = new Map<string, unknown>();
  seqCounter = 0;
  /** Number of upcoming action POSTs the relay COMMITS (and records) but whose reply is lost. */
  dropAfterReceive = 0;
  /** Number of upcoming question creates the relay COMMITS but whose reply is lost. */
  dropCreateReply = 0;
  /**
   * The relay's clock for a create's deadline. When set, a new question already past its signed `expires_at` is
   * refused (saying it was never committed when no event names it), while a retry of one already taken replays its
   * receipt, as the relay does. Unset, no deadline is checked.
   */
  createNow: (() => number) | null = null;
  uploads: { path: string; bytes: number; sha: string | null }[] = [];
  /** The relay's current key epoch and every device's sealed grants (`GET /devices/{id}/key-grants`). */
  epoch = 1;
  grants = new Map<string, EpochGrant[]>();
  /** Number of upcoming key-grant fetches that fail with a network error. */
  failGrants = 0;
  /** Phone image ciphertext served by `GET /attachments/{id}/content`, and the ids each download asked for. */
  blobs = new Map<string, Uint8Array>();
  downloads: string[] = [];
  /** What `GET /info` advertises; undefined leaves `features` out, like a 0.3.0 relay. */
  features: string[] | undefined = ['thread-messages-v1'];
  /** Number of upcoming `GET /info` reads that fail with a network error. */
  failInfo = 0;
  /** While set, `GET /info` waits for it before answering (a slow relay). */
  holdInfo: Promise<void> | null = null;
  /** Thread messages the relay committed, in commit order. */
  messages: { idem: string; message: SignedMessage }[] = [];
  /** The status, code and details every upcoming message POST is refused with, until cleared. */
  rejectMessage: { status: number; code: string; details?: Record<string, unknown> } | null = null;
  /**
   * Publishing desktops that have not declared `owner-desktop-messages-v1`: their questions refuse the person's
   * message from the owner desktop, as the relay does.
   */
  undeclaredMessages = new Set<string>();
  /** Number of upcoming message POSTs the relay COMMITS but whose reply is lost. */
  dropMessageReply = 0;
  /** While set, message POSTs wait for it before the relay looks at them (a slow relay). */
  holdMessages: Promise<void> | null = null;
  /** Commit each new posted message to the ledger as `decision.message.posted`, as the relay does. */
  postMessageEvents = false;
  /** The next `message_seq` of each question's thread, shared by posted and built messages. */
  messageSeqs = new Map<string, number>();
  /** Each committed message's receipt, returned unchanged for a retry, as the relay does. */
  messageReceipts = new Map<string, unknown>();
  /** Number of upcoming `POST /deliveries/messages` that fail with a network error after being recorded. */
  failReceipts = 0;
  /** While set, every `POST /deliveries/messages` is refused with this status and code. */
  rejectReceipts: { status: number; code: string } | null = null;
  /** Every accepted `PUT /questions/{id}/snapshot` body, in order. */
  snapshots: { questionId: string; body: unknown }[] = [];
  /** Replies for upcoming snapshot PUTs, in order; when empty the relay accepts. */
  snapshotReplies: { status: number; body: Record<string, unknown> }[] = [];
  /** What `GET /involvement` serves; null makes both routes unknown (404), like a relay from before them. */
  involvement: { preference: unknown; received_at: string | null } | null = {
    preference: null,
    received_at: null,
  };
  /** While set, `GET /involvement` waits for it before answering (a slow relay). */
  holdInvolvement: Promise<void> | null = null;
  /** Every `PUT /involvement` body, retries included, in order. */
  involvementPuts: { idem: string; preference: InvolvementRecord }[] = [];
  /**
   * Each committed `PUT /involvement` receipt and the record it took, by idempotency key: returned unchanged for a
   * retry of the same record, and a collision for a different one, as the relay does.
   */
  involvementReceipts = new Map<string, { record: string; receipt: unknown }>();
  /** While set, a committed `PUT /involvement` waits for it before replying (a slow reply). */
  holdInvolvementReply: Promise<void> | null = null;
  /** Bodies sent with HTTP 200 in place of the receipt for upcoming committed `PUT /involvement` (raw text as given). */
  involvementReplyBodies: string[] = [];
  /** Number of upcoming `PUT /involvement` the relay COMMITS but whose reply is lost. */
  dropInvolvementReply = 0;
  /** Refusals for upcoming `PUT /involvement`, in order; when empty the relay compare-and-swaps as it does. */
  rejectInvolvement: { status: number; code: string; details?: Record<string, unknown> }[] = [];
  /** Called as each `PUT /involvement` arrives, before the relay looks at it. */
  onInvolvementPut: (() => void | Promise<void>) | null = null;
  /** While set, `GET /devices` waits for it before answering (a directory that does not answer). */
  holdDevices: Promise<void> | null = null;
  /** While true, `GET /devices` fails as an unreachable relay would. */
  devicesFail = false;
  /** While set, `GET /devices` answers 200 with this body in place of the directory (a broken reply). */
  devicesBody: Record<string, unknown> | null = null;
  /** Called once the relay has committed a new question, before its receipt is sent (a slow reply). */
  onCreated: ((questionId: string) => void | Promise<void>) | null = null;
  /**
   * Whether `PUT /presence` exists; false makes it unknown (404), like a relay from before `presence-v1`. Advertising
   * the feature is `features`' job, so a test can make the two disagree.
   */
  presenceRoute = true;
  /** When the presence lease ends (relay epoch ms), or null when none was started or it was ended. */
  presenceUntil: number | null = null;
  /** The relay's clock for presence leases. */
  presenceNow: () => number = Date.now;
  /** Replies for upcoming presence PUTs, in order; when empty the relay accepts. */
  presenceReplies: { status: number; body: Record<string, unknown> }[] = [];
  /** While set, presence PUTs wait for it before the relay looks at them (a slow relay). */
  holdPresence: Promise<void> | null = null;
  /** Number of upcoming presence PUTs the relay COMMITS but whose reply is lost. */
  dropPresenceReply = 0;
  /**
   * Whether `POST /push/agent-stopped` exists; false makes it unknown (404), like a relay from before
   * `agent-stopped-push-v1`. Advertising the feature is `features`' job, so a test can make the two disagree.
   */
  agentStoppedRoute = true;
  /**
   * Replies for upcoming agent-stopped POSTs, in order, each with any headers (a string body is sent as given), or
   * `reset` for a connection lost before the reply; when empty the relay answers `sent`.
   */
  agentStoppedReplies: (
    | { status: number; body: Record<string, unknown> | string; headers?: Record<string, string> }
    | 'reset'
  )[] = [];
  /** The features each device declared on its latest socket ticket, as `GET /devices` lists them, by device id. */
  deviceFeatures = new Map<string, string[]>();
  /** Each device's `revoked_at` in `GET /devices`, by device id. */
  revokedAt = new Map<string, string>();
  /** Every `POST /questions/{id}/answer` body, retries included, in order. */
  answers: { idem: string; action: SignedAction }[] = [];
  /** Refusals for upcoming answer POSTs, in order; when empty the relay decides from the question's state. */
  rejectAnswer: { status: number; code: string; details?: Record<string, unknown> }[] = [];
  /**
   * Each question's status and revision as an answer POST sees them, by question id (open at revision 0 until set
   * or answered). Answer POSTs move them through `applyAction`, as the relay does.
   */
  answerState = new Map<string, { status: QuestionStatus; revision: number }>();
  /** Publishing desktops that have not declared `owner-desktop-answers-v1`: their questions refuse the owner. */
  undeclared = new Set<string>();
  /** Called as each answer POST arrives, before the relay looks at it. */
  onAnswer: (() => void) | null = null;
  /** Number of upcoming answer POSTs the relay COMMITS but whose reply is lost. */
  dropAnswerReply = 0;
  /** While set, answer POSTs wait for it before the relay looks at them (a slow relay). */
  holdAnswers: Promise<void> | null = null;
  /** Each committed answer's receipt, by action id, returned unchanged for a retry. */
  answerReceipts = new Map<string, unknown>();
  /** Every flagged `POST /questions/{id}/cancel` body (an owner-desktop decline), retries included, in order. */
  declines: { idem: string; action: SignedAction }[] = [];
  /** Refusals for upcoming decline POSTs, in order; when empty the relay decides from the question's state. */
  rejectDecline: { status: number; code: string; details?: Record<string, unknown> }[] = [];
  /** Publishing desktops that have not declared `owner-desktop-declines-v1`: their questions refuse the decline. */
  undeclaredDeclines = new Set<string>();
  /** Number of upcoming decline POSTs the relay COMMITS but whose reply is lost. */
  dropDeclineReply = 0;
  /** Number of upcoming `GET /questions/{id}` reads that fail with a network error. */
  failDetail = 0;
  /** The signature each committed answer or decline carried, by action id. */
  committedSignatures = new Map<string, string>();
  /** Each question's committed cancels, as `GET /questions/{id}` lists them in its action log. */
  cancelLog = new Map<string, { action_id: string; action: 'cancel'; record: unknown }[]>();

  constructor(private readonly owner: Identity) {}

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url,
    );
    const method = init?.method ?? 'GET';
    if (this.down > 0) {
      this.down--;
      throw new TypeError('fetch failed');
    }
    if (this.status5xx > 0) {
      this.status5xx--;
      return json(503, { code: 'temporarily_unavailable', message: 'down' });
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    else if (init?.body) body = { bytes: (init.body as Uint8Array).length };
    this.calls.push({ method, path: url.pathname, query: url.search, body, headers });
    const p = url.pathname;
    let m: RegExpMatchArray | null;
    if (
      this.dropAfterReceive > 0 &&
      method === 'POST' &&
      /\/(cancel|proxy-answer|proxy-abstain)$/.test(p)
    ) {
      this.dropAfterReceive--;
      throw new TypeError('connection reset after the relay committed');
    }
    if (
      method === 'POST' &&
      (/^\/api\/v1\/devices\/[^/]+\/revoke$/.test(p) || p === '/api/v1/epoch/rotate')
    ) {
      return json(200, { ok: true });
    }

    if (method === 'GET' && p === '/api/v1/info') {
      if (this.holdInfo) await this.holdInfo;
      if (this.failInfo > 0) {
        this.failInfo--;
        throw new TypeError('fetch failed');
      }
      return json(200, {
        name: 'daintree-decisions',
        protocol_min: 1,
        protocol_max: 1,
        worker_version: 'test',
        claimed: true,
        claim_configured: true,
        voice: { xai: false, anthropic: false, openai: false },
        ...(this.features ? { features: this.features } : {}),
      });
    }
    if (method === 'POST' && (m = p.match(/^\/api\/v1\/questions\/([^/]+)\/messages$/))) {
      if (this.holdMessages) await this.holdMessages;
      if (this.rejectMessage)
        return json(this.rejectMessage.status, {
          code: this.rejectMessage.code,
          message: 'no',
          ...(this.rejectMessage.details ? { details: this.rejectMessage.details } : {}),
        });
      const b = body as { idempotency_key: string; message: SignedMessage };
      const id = b.message.record.message_id;
      // The person's message is held to the question's state and its desktop's features, as the relay does, in the
      // relay's order; a retry of a committed one is recognised first, and a refusal commits nothing.
      if (b.message.record.side === 'human' && !this.messageReceipts.has(id)) {
        const qid = m[1]!;
        const q = this.questions.get(qid);
        if (!q) return json(404, { code: 'not_found', message: 'no such question' });
        const signer = b.message.record.signer_device_id;
        const role =
          signer === this.owner.config.deviceId
            ? ('owner-desktop' as const)
            : (this.devices.find((d) => d.device_id === signer)?.role ?? 'phone');
        try {
          applyMessage(
            {
              ...(this.answerState.get(qid) ?? { status: 'open' as const, revision: 0 }),
              requirement: q.signed.record.requirement,
              proxyAbstained: false,
            },
            {
              side: 'human',
              role,
              signerIsPublisher: signer === q.signed.record.originating_device_id,
              messageCount: this.messages.filter((x) => x.message.record.question_id === qid)
                .length,
            },
          );
          if (
            role === 'owner-desktop' &&
            this.undeclaredMessages.has(q.signed.record.originating_device_id)
          )
            throw new ApiError(
              'invalid_state',
              "the question's desktop does not accept messages from the computer",
              {
                details: {
                  reason: CREATOR_MISSING_FEATURE,
                  required_feature: 'owner-desktop-messages-v1',
                },
              },
            );
          if (role === 'owner-desktop' && b.message.record.attachment_ids.length > 0)
            throw new ApiError('forbidden', `role ${role} may not attach phone images`);
        } catch (e) {
          const err = e as ApiError;
          return json(err.status, {
            code: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          });
        }
      }
      let i = this.messages.findIndex((x) => x.message.record.message_id === id);
      if (i >= 0 && JSON.stringify(this.messages[i]!.message) !== JSON.stringify(b.message))
        return json(409, { code: 'idempotency_collision', message: 'different message' });
      const fresh = i < 0;
      if (i < 0) i = this.messages.push({ idem: b.idempotency_key, message: b.message }) - 1;
      const prior = this.messageReceipts.get(id);
      if (prior) return json(201, prior);
      const committedAt = new Date().toISOString();
      // Without `postMessageEvents` the seq is not a ledger seq of this fake: a burnt seq would look like a gap.
      let eventSeq = 10_000 + i;
      let messageSeq = i + 1;
      if (this.postMessageEvents && fresh) {
        const qid = b.message.record.question_id;
        messageSeq = (this.messageSeqs.get(qid) ?? 0) + 1;
        this.messageSeqs.set(qid, messageSeq);
        eventSeq = this.push('decision.message.posted', qid, null, {
          message_seq: messageSeq,
          committed_at: committedAt,
          record: b.message.record,
          envelope: b.message.envelope,
          target_host_id: this.questions.get(qid)!.signed.record.target_host_id,
        }).seq;
      }
      const receipt = {
        question_id: m[1],
        message_id: id,
        message_seq: messageSeq,
        event_seq: eventSeq,
        committed_at: committedAt,
      };
      this.messageReceipts.set(id, receipt);
      if (this.dropMessageReply > 0) {
        this.dropMessageReply--;
        throw new TypeError('connection reset after the relay committed the message');
      }
      return json(201, receipt);
    }
    if (method === 'POST' && p === '/api/v1/questions') {
      if (this.rejectCreate)
        return json(this.rejectCreate, { code: 'validation_error', message: 'nope' });
      const b = body as { idempotency_key: string; question: SignedQuestion };
      const prior = this.receipts.get(b.idempotency_key);
      if (prior) return json(201, prior);
      const q = b.question;
      if (
        this.createNow &&
        q.record.expires_at &&
        Date.parse(q.record.expires_at) <= this.createNow()
      ) {
        // As the relay does: it says the question was never committed when nothing of it ever reached it.
        const never = !this.events.some((e) => e.question_id === q.record.question_id);
        return json(400, {
          code: 'validation_error',
          message: 'expires_at must be in the future',
          ...(never ? { details: { reason: 'never-committed' } } : {}),
        });
      }
      this.questions.set(q.record.question_id, { signed: q, idem: b.idempotency_key });
      const ev = this.push('decision.created', q.record.question_id, 0, {
        record: q.record,
        envelope: q.envelope,
        requirement: q.record.requirement,
        target_host_id: q.record.target_host_id,
        expires_at: q.record.expires_at,
      });
      const receipt = {
        question_id: q.record.question_id,
        revision: 0,
        status: 'open',
        event_seq: ev.seq,
      };
      this.receipts.set(b.idempotency_key, receipt);
      await this.onCreated?.(q.record.question_id);
      if (this.dropCreateReply > 0) {
        this.dropCreateReply--;
        throw new TypeError('connection reset after the relay committed the question');
      }
      return json(201, receipt);
    }
    if (method === 'POST' && (m = p.match(/^\/api\/v1\/questions\/([^/]+)\/answer$/))) {
      this.onAnswer?.();
      if (this.holdAnswers) await this.holdAnswers;
      const b = body as { idempotency_key: string; action: SignedAction };
      const qid = m[1]!;
      this.answers.push({ idem: b.idempotency_key, action: b.action });
      // A retry of the very same signed answer gets the receipt it was given, as the relay does; the same action id
      // on any other body is a collision.
      const prior = this.answerReceipts.get(b.action.record.action_id);
      if (prior) {
        const first = this.answers.find(
          (a) => a.action.record.action_id === b.action.record.action_id,
        )!;
        return first.action.record.signature === b.action.record.signature
          ? json(200, prior)
          : json(409, { code: 'idempotency_collision', message: 'different command' });
      }
      const reject = this.rejectAnswer.shift();
      if (reject)
        return json(reject.status, {
          code: reject.code,
          message: 'no',
          ...(reject.details ? { details: reject.details } : {}),
        });
      const q = this.questions.get(qid);
      if (!q) return json(404, { code: 'not_found', message: 'no such question' });
      const state = this.answerState.get(qid) ?? { status: 'open' as const, revision: 0 };
      try {
        applyAction(
          { ...state, requirement: q.signed.record.requirement, proxyAbstained: false },
          'answer',
          'owner-desktop',
          b.action.record.expected_revision,
        );
        if (this.undeclared.has(q.signed.record.originating_device_id))
          throw new ApiError('invalid_state', "the question's desktop does not take them", {
            details: {
              reason: CREATOR_MISSING_FEATURE,
              required_feature: 'owner-desktop-answers-v1',
            },
          });
      } catch (e) {
        const err = e as ApiError;
        return json(err.status, {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        });
      }
      const revision = b.action.record.expected_revision + 1;
      this.answerState.set(qid, { status: 'human-answered', revision });
      const ev = this.push('decision.answer.committed', qid, revision, {
        ...EventData.action.parse({
          action: 'answer',
          record: b.action.record,
          envelope: b.action.envelope,
          provenance: 'human-desktop',
          status: 'human-answered',
          revision,
          target_host_id: q.signed.record.target_host_id,
          deliverable: true,
        }),
      });
      const receipt = { question_id: qid, revision, status: 'human-answered', event_seq: ev.seq };
      this.answerReceipts.set(b.action.record.action_id, receipt);
      this.committedSignatures.set(b.action.record.action_id, b.action.record.signature);
      if (this.dropAnswerReply > 0) {
        this.dropAnswerReply--;
        throw new TypeError('connection reset after the relay committed the answer');
      }
      return json(201, receipt);
    }
    if (
      method === 'POST' &&
      (m = p.match(/^\/api\/v1\/questions\/([^/]+)\/cancel$/)) &&
      (body as { action: SignedAction }).action.record.decline === true
    ) {
      return this.decline(m[1]!, body as { idempotency_key: string; action: SignedAction });
    }
    if (method === 'GET' && (m = p.match(/^\/api\/v1\/questions\/([^/]+)$/))) {
      if (this.failDetail > 0) {
        this.failDetail--;
        throw new TypeError('fetch failed');
      }
      const q = this.questions.get(m[1]!);
      if (!q) return json(404, { code: 'not_found', message: 'no such question' });
      const state = this.answerState.get(m[1]!) ?? { status: 'open' as const, revision: 0 };
      return json(200, {
        question_id: m[1],
        status: state.status,
        revision: state.revision,
        actions: this.cancelLog.get(m[1]!) ?? [],
      });
    }
    if (
      (m = p.match(/^\/api\/v1\/questions\/([^/]+)\/(cancel|proxy-answer|proxy-abstain)$/)) &&
      method === 'POST'
    ) {
      const b = body as { idempotency_key: string; action: SignedAction };
      // A cancellation closes the question to answers that come after it.
      if (m[2] === 'cancel') {
        this.answerState.set(m[1]!, {
          status: 'cancelled',
          revision: b.action.record.expected_revision,
        });
        this.logCancel(m[1]!, b.action);
      }
      return json(201, {
        question_id: m[1],
        revision: b.action.record.expected_revision,
        status: 'open',
        event_seq: null,
      });
    }
    if (method === 'GET' && p === '/api/v1/devices') {
      if (this.holdDevices) await this.holdDevices;
      if (this.devicesFail) throw new TypeError('fetch failed');
      if (this.devicesBody) return json(200, this.devicesBody);
      const certs = [this.ownerCert(), ...this.devices];
      return json(200, {
        key_epoch: this.epoch,
        owner_device_id: this.owner.config.deviceId,
        devices: certs.map((cert) => ({
          device_id: cert.device_id,
          role: cert.role,
          label: cert.label,
          created_at: cert.issued_at,
          revoked_at: this.revokedAt.get(cert.device_id) ?? null,
          last_seen_at: null,
          last_ack_seq: 0,
          cert,
          push_enabled: false,
          ...(this.deviceFeatures.has(cert.device_id)
            ? { features: this.deviceFeatures.get(cert.device_id) }
            : {}),
        })),
      });
    }
    if (method === 'GET' && (m = p.match(/^\/api\/v1\/devices\/([^/]+)\/key-grants$/))) {
      if (this.failGrants > 0) {
        this.failGrants--;
        throw new TypeError('fetch failed');
      }
      return json(200, { current_epoch: this.epoch, grants: this.grants.get(m[1]!) ?? [] });
    }
    if (method === 'GET' && p === '/api/v1/events') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const rest = this.events.filter((e) => e.seq > after);
      const page = rest.slice(0, limit);
      const high = this.events.at(-1)?.seq ?? 0;
      return json(200, {
        protocol_version: PROTOCOL_VERSION,
        from_exclusive: after,
        high_water_seq: high,
        events: page,
        next_after: page.at(-1)?.seq ?? after,
        has_more: rest.length > page.length,
      });
    }
    if (method === 'POST' && p === '/api/v1/attachments/reservations') {
      const b = body as { attachment_id: string };
      return json(201, {
        attachment_id: b.attachment_id,
        upload_path: `/api/v1/attachments/${b.attachment_id}/content`,
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });
    }
    if (method === 'PUT' && p.startsWith('/api/v1/attachments/')) {
      this.uploads.push({
        path: p,
        bytes: (body as { bytes: number }).bytes,
        sha: headers['x-content-sha256'] ?? null,
      });
      return json(200, { ok: true });
    }
    if (method === 'GET' && (m = p.match(/^\/api\/v1\/attachments\/([^/]+)\/content$/))) {
      this.downloads.push(m[1]!);
      const blob = this.blobs.get(m[1]!);
      if (!blob) return json(404, { code: 'not_found', message: 'no such attachment' });
      return new Response(new Uint8Array(blob).buffer, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    if (method === 'POST' && /^\/api\/v1\/attachments\/[^/]+\/complete$/.test(p))
      return json(200, { ok: true });
    if (method === 'POST' && p === '/api/v1/deliveries/messages') {
      if (this.failReceipts > 0) {
        this.failReceipts--;
        throw new TypeError('fetch failed');
      }
      if (this.rejectReceipts)
        return json(this.rejectReceipts.status, { code: this.rejectReceipts.code, message: 'no' });
    }
    if (method === 'POST' && p.startsWith('/api/v1/deliveries/')) return json(200, { ok: true });
    if (method === 'PUT' && (m = p.match(/^\/api\/v1\/questions\/([^/]+)\/snapshot$/))) {
      const reply = this.snapshotReplies.shift();
      if (reply) return json(reply.status, reply.body);
      this.snapshots.push({ questionId: m[1]!, body });
      return json(200, { ok: true });
    }
    if (method === 'PUT' && p === '/api/v1/presence' && this.presenceRoute) {
      if (this.holdPresence) await this.holdPresence;
      const reply = this.presenceReplies.shift();
      if (reply) return json(reply.status, reply.body);
      const present = (body as { present?: unknown } | undefined)?.present === true;
      const now = this.presenceNow();
      this.presenceUntil = present ? now + LIMITS.presenceLeaseMs : null;
      if (this.dropPresenceReply > 0) {
        this.dropPresenceReply--;
        throw new TypeError('connection reset after the relay committed');
      }
      return json(200, {
        present,
        until: present ? new Date(this.presenceUntil!).toISOString() : null,
      });
    }
    if (method === 'POST' && p === '/api/v1/push/agent-stopped' && this.agentStoppedRoute) {
      // The body is strict, as the relay's is: anything but the version is refused.
      if (!AgentStoppedPushBody.safeParse(body).success)
        return json(400, { code: 'validation_error', message: 'invalid body' });
      const reply = this.agentStoppedReplies.shift();
      if (reply === 'reset') throw new TypeError('connection reset');
      if (reply)
        return typeof reply.body === 'string'
          ? new Response(reply.body, {
              status: reply.status,
              headers: { 'content-type': 'application/json', ...reply.headers },
            })
          : json(reply.status, reply.body, reply.headers);
      return json(200, { outcome: 'sent' });
    }
    if (method === 'GET' && p === '/api/v1/involvement' && this.involvement) {
      const served = this.involvement;
      if (this.holdInvolvement) await this.holdInvolvement;
      return json(200, served);
    }
    if (method === 'PUT' && p === '/api/v1/involvement' && this.involvement) {
      const b = body as { idempotency_key: string; preference: InvolvementRecord };
      this.involvementPuts.push({ idem: b.idempotency_key, preference: b.preference });
      await this.onInvolvementPut?.();
      const prior = this.involvementReceipts.get(b.idempotency_key);
      if (prior) {
        if (prior.record !== JSON.stringify(b.preference))
          return json(409, { code: 'idempotency_collision', message: 'key reused' });
        return json(200, prior.receipt);
      }
      const reject = this.rejectInvolvement.shift();
      if (reject)
        return json(reject.status, {
          code: reject.code,
          message: 'no',
          ...(reject.details ? { details: reject.details } : {}),
        });
      // The relay's compare-and-swap: exactly one more than the revision it holds.
      const held = (this.involvement?.preference as InvolvementRecord | null)?.revision ?? 0;
      if (b.preference.revision !== held + 1)
        return json(409, {
          code: 'revision_conflict',
          message: 'the involvement preference changed',
          details: { latest_revision: held },
        });
      this.involvement = { preference: b.preference, received_at: new Date().toISOString() };
      const ev = this.push('involvement.updated', null, null, { revision: b.preference.revision });
      const receipt = { revision: b.preference.revision, event_seq: ev.seq };
      this.involvementReceipts.set(b.idempotency_key, {
        record: JSON.stringify(b.preference),
        receipt,
      });
      if (this.holdInvolvementReply) await this.holdInvolvementReply;
      if (this.dropInvolvementReply > 0) {
        this.dropInvolvementReply--;
        throw new TypeError('connection reset after the relay committed');
      }
      const replaced = this.involvementReplyBodies.shift();
      if (replaced !== undefined)
        return new Response(replaced, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      return json(200, receipt);
    }
    if (method === 'POST' && p === '/api/v1/socket-ticket') {
      return json(200, {
        ticket: 'tkt',
        expires_at: new Date(Date.now() + 30000).toISOString(),
        ws_path: '/api/v1/socket',
      });
    }
    return json(404, { code: 'not_found', message: 'no such route' });
  };

  ownerCertCache: DeviceCert | null = null;
  ownerCert(): DeviceCert {
    if (!this.ownerCertCache) throw new Error('call initOwner() first');
    return this.ownerCertCache;
  }
  async initOwner(): Promise<void> {
    const o = this.owner;
    this.ownerCertCache = await issueDeviceCert({
      issuerDeviceId: o.config.deviceId,
      issuerSigningKey: o.keys.signing.privateKey,
      installationId: o.config.installationId,
      deviceId: o.config.deviceId,
      role: 'owner-desktop',
      label: 'Test Mac',
      signingPub: o.signingPub,
      exchangePub: o.exchangePub,
    });
  }

  private logCancel(questionId: string, action: SignedAction): void {
    const log = this.cancelLog.get(questionId) ?? [];
    log.push({ action_id: action.record.action_id, action: 'cancel', record: action.record });
    this.cancelLog.set(questionId, log);
  }

  /**
   * The owner desktop's decline (a `cancel` with `decline: true`), as the relay takes it (section 6.1): the same
   * signed body again gets its receipt, a cancel of a question already cancelled at that revision is a no-op `200`,
   * the publishing desktop must have declared `owner-desktop-declines-v1`, and a committed decline is a
   * `decision.cancelled` in the ledger and in the question's action log.
   */
  private decline(qid: string, b: { idempotency_key: string; action: SignedAction }): Response {
    this.declines.push({ idem: b.idempotency_key, action: b.action });
    const record = b.action.record;
    // The very same signed command again gets the receipt it was first given (its `201`); an action id an answer or
    // another decline committed under any other signature is a collision.
    const prior = this.answerReceipts.get(record.action_id);
    if (prior) {
      return this.committedSignatures.get(record.action_id) === record.signature
        ? json(201, prior)
        : json(409, { code: 'idempotency_collision', message: 'different command' });
    }
    const reject = this.rejectDecline.shift();
    if (reject)
      return json(reject.status, {
        code: reject.code,
        message: 'no',
        ...(reject.details ? { details: reject.details } : {}),
      });
    const q = this.questions.get(qid);
    if (!q) return json(404, { code: 'not_found', message: 'no such question' });
    const state = this.answerState.get(qid) ?? { status: 'open' as const, revision: 0 };
    const role =
      record.signer_device_id === this.owner.config.deviceId
        ? ('owner-desktop' as const)
        : (this.devices.find((d) => d.device_id === record.signer_device_id)?.role ?? 'phone');
    let noop: boolean;
    try {
      noop = applyAction(
        { ...state, requirement: q.signed.record.requirement, proxyAbstained: false },
        'cancel',
        role,
        record.expected_revision,
        record.decline,
      ).noop;
      if (!noop && this.undeclaredDeclines.has(q.signed.record.originating_device_id))
        throw new ApiError('invalid_state', "the question's desktop does not take them", {
          details: {
            reason: CREATOR_MISSING_FEATURE,
            required_feature: 'owner-desktop-declines-v1',
          },
        });
    } catch (e) {
      const err = e as ApiError;
      return json(err.status, {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    }
    if (noop)
      return json(200, {
        question_id: qid,
        revision: state.revision,
        status: 'cancelled',
        event_seq: this.seqCounter,
      });
    this.answerState.set(qid, { status: 'cancelled', revision: state.revision });
    this.logCancel(qid, b.action);
    const ev = this.push('decision.cancelled', qid, state.revision, {
      ...EventData.action.parse({
        action: 'cancel',
        record,
        envelope: null,
        provenance: null,
        status: 'cancelled',
        revision: state.revision,
        target_host_id: q.signed.record.target_host_id,
        deliverable: false,
      }),
    });
    const receipt = {
      question_id: qid,
      revision: state.revision,
      status: 'cancelled',
      event_seq: ev.seq,
    };
    this.answerReceipts.set(record.action_id, receipt);
    this.committedSignatures.set(record.action_id, record.signature);
    if (this.dropDeclineReply > 0) {
      this.dropDeclineReply--;
      throw new TypeError('connection reset after the relay committed the decline');
    }
    return json(201, receipt);
  }

  push(
    type: LedgerEvent['event_type'],
    questionId: string | null,
    revision: number | null,
    data: Record<string, unknown>,
  ): LedgerEvent {
    const ev: LedgerEvent = {
      protocol_version: PROTOCOL_VERSION,
      seq: ++this.seqCounter,
      event_id: newId(),
      event_type: type,
      occurred_at: new Date().toISOString(),
      question_id: questionId,
      question_revision: revision,
      origin_device_id: null,
      data,
    };
    this.events.push(ev);
    return ev;
  }

  /** Burn sequence numbers without leaving events behind: a legitimate ledger hole (tombstoned question). */
  skipSeq(n: number): void {
    this.seqCounter += n;
  }

  /** Build a validly signed answer event from `phone` (or any signer) for a question the bridge published. */
  async answerEvent(opts: {
    questionId: string;
    phone: { deviceId: string; keys: DeviceKeys };
    action?: ActionKind;
    expectedRevision?: number;
    options?: string[];
    text?: string;
    status?: string;
    eventType?: LedgerEvent['event_type'];
    /** What the relay declares; `human-desktop` for an owner-desktop answer (default: what the action implies). */
    provenance?: Provenance;
    extra?: Record<string, unknown>;
    signWith?: DeviceKeys;
    epoch?: EpochKey;
    confirmsActionId?: string;
    recordType?: string;
    /** Override what the event's `data` claims (to model a lying relay). */
    dataOverride?: Record<string, unknown>;
    /** Phone image ids to sign into the record (`attachment_ids`); the images go in `extra.images`. */
    attachmentIds?: string[];
  }): Promise<LedgerEvent> {
    const action = opts.action ?? 'answer';
    const prov = opts.provenance ?? (action === 'proxy-answer' ? 'proxy' : 'human');
    const rev = opts.expectedRevision ?? 0;
    const o = this.owner;
    const env: CryptoEnvelope = await encryptEnvelope({
      epochKey: opts.epoch ?? o.epochs.get(1)!,
      installationId: o.config.installationId,
      questionId: opts.questionId,
      recordId: newId(),
      recordType: opts.recordType ?? action,
      revision: rev + 1,
      senderDeviceId: opts.phone.deviceId,
      purpose: 'answer-content',
      plaintext: {
        content_version: 1,
        selected_option_ids: opts.options ?? [],
        text: opts.text,
        reviewed_attachment_digests: [],
        ...(prov === 'proxy'
          ? {
              model_id: 'm',
              prompt_template_version: 'v1',
              confidence: 0.9,
              retrieval_reference_ids: [],
            }
          : {}),
        ...(opts.extra ?? {}),
      },
    });
    const signed = await buildSignedAction({
      installationId: o.config.installationId,
      questionId: opts.questionId,
      action,
      signerDeviceId: opts.phone.deviceId,
      signingKey: (opts.signWith ?? opts.phone.keys).signing.privateKey,
      expectedRevision: rev,
      envelope: env,
      ...(opts.confirmsActionId ? { confirmsActionId: opts.confirmsActionId } : {}),
      ...(opts.attachmentIds ? { attachmentIds: opts.attachmentIds } : {}),
    });
    const type =
      opts.eventType ??
      (action === 'override'
        ? 'decision.answer.overridden'
        : action === 'proxy-answer'
          ? 'decision.proxy.committed'
          : action === 'confirm-proxy'
            ? 'decision.proxy.confirmed'
            : 'decision.answer.committed');
    const q = this.questions.get(opts.questionId)!;
    return this.push(type, opts.questionId, rev + 1, {
      ...EventData.action.parse({
        action,
        record: signed.record,
        envelope: signed.envelope,
        provenance: prov,
        status: opts.status ?? (prov === 'proxy' ? 'proxy-answered' : 'human-answered'),
        revision: rev + 1,
        target_host_id: q.signed.record.target_host_id,
        deliverable: action !== 'confirm-proxy',
      }),
      ...(opts.dataOverride ?? {}),
    });
  }

  /**
   * Build a validly signed thread message from `signer` (a phone by default) for a question the bridge published,
   * committed as the relay does: a `decision.message.posted` event with the next `message_seq`.
   */
  async messageEvent(opts: {
    questionId: string;
    signer: { deviceId: string; keys: DeviceKeys };
    side?: 'human' | 'agent';
    text?: string;
    expectsReply?: boolean;
    messageId?: string;
    /** Phone images the content references; their ids are signed into the record unless `attachmentIds` is set. */
    images?: Record<string, unknown>[];
    attachmentIds?: string[];
    /** Replace the encrypted content (to model a phone that lies about its side or images). */
    content?: Record<string, unknown>;
    signWith?: DeviceKeys;
    epoch?: EpochKey;
    /** Override what the event's `data` claims (to model a lying relay). */
    dataOverride?: Record<string, unknown>;
  }): Promise<LedgerEvent> {
    const o = this.owner;
    const side = opts.side ?? 'human';
    const messageId = opts.messageId ?? newId();
    const images = opts.images ?? [];
    const envelope = await encryptEnvelope({
      epochKey: opts.epoch ?? o.epochs.get(1)!,
      installationId: o.config.installationId,
      questionId: opts.questionId,
      recordId: messageId,
      recordType: 'thread.message',
      revision: 0,
      senderDeviceId: opts.signer.deviceId,
      purpose: 'message-content',
      plaintext: opts.content ?? {
        content_version: 1,
        side,
        text: opts.text ?? '',
        ...(side === 'human' ? { images } : {}),
      },
    });
    const signed = await buildSignedMessage({
      installationId: o.config.installationId,
      questionId: opts.questionId,
      messageId,
      side,
      signerDeviceId: opts.signer.deviceId,
      signingKey: (opts.signWith ?? opts.signer.keys).signing.privateKey,
      expectsReply: opts.expectsReply ?? false,
      attachmentIds: opts.attachmentIds ?? images.map((i) => i.attachment_id as string),
      envelope,
    });
    const seq = (this.messageSeqs.get(opts.questionId) ?? 0) + 1;
    this.messageSeqs.set(opts.questionId, seq);
    const q = this.questions.get(opts.questionId)!;
    return this.push('decision.message.posted', opts.questionId, null, {
      message_seq: seq,
      committed_at: new Date().toISOString(),
      record: signed.record,
      envelope: signed.envelope,
      target_host_id: q.signed.record.target_host_id,
      ...(opts.dataOverride ?? {}),
    });
  }

  /**
   * The relay expiring a question's round as `expireQuestionNow` does: at `at` (by default the deadline the question
   * was published with), naming the question's signed host, at the round's revision (by default 0).
   */
  expiryEvent(opts: {
    questionId: string;
    revision?: number | null;
    at?: string;
    occurredAt?: string;
    targetHostId?: string;
  }): LedgerEvent {
    const q = this.questions.get(opts.questionId)!;
    const at = opts.at ?? q.signed.record.expires_at ?? new Date().toISOString();
    const ev = this.push(
      'decision.expired',
      opts.questionId,
      opts.revision === undefined ? 0 : opts.revision,
      { expired_at: at, target_host_id: opts.targetHostId ?? q.signed.record.target_host_id },
    );
    ev.occurred_at = opts.occurredAt ?? at;
    return ev;
  }

  /** A signed envelope-less action (cancel / reopen / proxy-abstain) as the relay would emit it. */
  async plainActionEvent(opts: {
    questionId: string;
    signer: { deviceId: string; keys: DeviceKeys };
    action: 'cancel' | 'reopen' | 'proxy-abstain';
    expectedRevision?: number;
    status?: string;
    revision?: number;
    eventType?: LedgerEvent['event_type'];
    provenance?: 'human' | 'proxy' | null;
    /** Sign `decline: true` into the record: the owner desktop declining for the person (section 6.1). */
    decline?: true;
    /** A reopen's signed new deadline (null: never expires). */
    expiresAt?: string | null;
  }): Promise<LedgerEvent> {
    const o = this.owner;
    const rev = opts.expectedRevision ?? 0;
    const signed = await buildSignedAction({
      installationId: o.config.installationId,
      questionId: opts.questionId,
      action: opts.action,
      signerDeviceId: opts.signer.deviceId,
      signingKey: opts.signer.keys.signing.privateKey,
      expectedRevision: rev,
      ...(opts.decline ? { decline: true as const } : {}),
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    });
    const q = this.questions.get(opts.questionId)!;
    const type =
      opts.eventType ??
      (opts.action === 'cancel'
        ? 'decision.cancelled'
        : opts.action === 'reopen'
          ? 'decision.reopened'
          : 'decision.proxy.abstained');
    return this.push(
      type,
      opts.questionId,
      opts.revision ?? (opts.action === 'reopen' ? rev + 1 : rev),
      EventData.action.parse({
        action: opts.action,
        record: signed.record,
        envelope: null,
        provenance: opts.provenance ?? null,
        status: opts.status ?? (opts.action === 'cancel' ? 'cancelled' : 'open'),
        revision: opts.revision ?? (opts.action === 'reopen' ? rev + 1 : rev),
        target_host_id: q.signed.record.target_host_id,
        deliverable: false,
      }),
    );
  }

  async decryptQuestion(questionId: string): Promise<{
    question: string;
    options: { id: string; label: string }[];
    attachments: unknown[];
  }> {
    const q = this.questions.get(questionId)!;
    return decryptEnvelope(q.signed.envelope, this.owner.epochs) as never;
  }
}

type FakePane = {
  generation: number;
  session: string | null;
  idle: boolean;
  hostOffline?: boolean;
  principal: string;
  incarnation: string;
};

/** What the next inject() reports. `throw` simulates a crash mid-write (the text may be on screen). */
export type FakeInjectBehaviour =
  | 'ok'
  | 'throw'
  | 'throw-string'
  | 'held'
  | 'ambiguous'
  | 'no-proof'
  | 'legacy-ok'
  | { unavailable: UnavailableReason };

export class FakeSink implements TerminalSink {
  panes = new Map<string, FakePane>();
  typed: { target: TerminalTarget; text: string; id: string }[] = [];
  injectBehaviour: FakeInjectBehaviour = 'ok';
  injectCalls = 0;
  resumeTarget: TerminalTarget | null = null;
  locateCalls = 0;
  /** Return a state for the Nth locate() call to simulate the terminal changing underneath us. */
  locateOverride: ((call: number, o: QuestionOrigin) => LocateResult | undefined) | null = null;

  addPane(paneId: string, over: Partial<FakePane> = {}) {
    this.panes.set(paneId, {
      generation: 1,
      session: 'sess-1',
      idle: true,
      principal: 'principal-1',
      incarnation: 'inc-1',
      ...over,
    });
  }
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    this.locateCalls++;
    const forced = this.locateOverride?.(this.locateCalls, o);
    if (forced) return forced;
    const p = this.panes.get(o.pane_id);
    if (!p) return { state: 'gone' };
    if (p.hostOffline) return { state: 'host-offline' };
    if (p.generation !== o.terminal_generation) return { state: 'generation-mismatch' };
    if (p.principal !== o.ownership_principal || p.incarnation !== o.agent_incarnation)
      return { state: 'relaunched' };
    if (p.session !== o.agent_session_id) return { state: 'session-mismatch' };
    return {
      state: 'alive',
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: p.generation,
        ownershipPrincipal: p.principal,
        agentIncarnation: p.incarnation,
        agentSessionId: p.session,
        worktreeId: o.worktree_id,
      },
    };
  }
  async isIdle(t: TerminalTarget) {
    return this.panes.get(t.paneId)?.idle ?? false;
  }
  async inject(t: TerminalTarget, text: string, id: string): Promise<InjectResult> {
    this.injectCalls++;
    const b = this.injectBehaviour;
    if (b === 'throw' || b === 'throw-string') {
      this.typed.push({ target: t, text, id }); // it may have been typed before the crash
      if (b === 'throw-string') throw 'boom'; // eslint-disable-line no-throw-literal
      throw new Error('boom');
    }
    if (b === 'held') return { outcome: 'held', reason: 'busy' };
    if (typeof b === 'object') return { outcome: 'unavailable', reason: b.unavailable };
    this.typed.push({ target: t, text, id });
    if (b === 'ambiguous') return { outcome: 'ambiguous', reason: 'enter_dropped' };
    if (b === 'no-proof') return { outcome: 'delivered' } as unknown as InjectResult;
    if (b === 'legacy-ok') return { ok: true, proof: 'p' } as unknown as InjectResult;
    return { outcome: 'delivered', proof: `pty_written:${id}` };
  }
  async hasMarker(t: TerminalTarget, injectionId: string) {
    return this.typed.some(
      (x) => x.target.paneId === t.paneId && x.text.includes(`injection_id: ${injectionId}`),
    );
  }
  async resume() {
    return this.resumeTarget;
  }
}

export interface Host {
  identity: Identity;
  keyStore: MemoryKeyStore;
  cert: DeviceCert;
}

/**
 * An enrolled `desktop-host` of `owner`, as `acceptHostEnrollment` would store it: its own keys, an owner-issued
 * certificate, the owner pinned, and the owner's epoch keys opened from grants sealed to it. With `relay`, the
 * certificate is listed and the grants are served from `GET /devices/{id}/key-grants`.
 */
export async function makeHost(owner: Identity, relay?: FakeRelay): Promise<Host> {
  const keys = await generateDeviceKeys(true);
  const deviceId = newId();
  const exchangePub = await exportPublicKey(keys.exchange.publicKey);
  const cert = await issueDeviceCert({
    issuerDeviceId: owner.config.deviceId,
    issuerSigningKey: owner.keys.signing.privateKey,
    installationId: owner.config.installationId,
    deviceId,
    role: 'desktop-host',
    label: 'Build box',
    signingPub: await exportPublicKey(keys.signing.publicKey),
    exchangePub,
  });
  const ownerCert = await issueDeviceCert({
    issuerDeviceId: owner.config.deviceId,
    issuerSigningKey: owner.keys.signing.privateKey,
    installationId: owner.config.installationId,
    deviceId: owner.config.deviceId,
    role: 'owner-desktop',
    label: owner.config.label,
    signingPub: owner.signingPub,
    exchangePub: owner.exchangePub,
  });
  const grants: EpochGrant[] = [];
  for (const e of owner.stored.epochs) {
    grants.push(
      await sealEpochTo(owner, { deviceId, exchangePub }, e.epoch, base64UrlToBytes(e.raw)),
    );
  }
  const keyStore = new MemoryKeyStore();
  await keyStore.save({
    v: 1,
    role: 'desktop-host',
    config: { ...owner.config, deviceId, label: 'Build box' },
    keys: await serializeDeviceKeys(keys),
    epochs: owner.stored.epochs.map((e) => ({ ...e })),
    currentEpoch: owner.currentEpoch,
    host: { cert, ownerCert, grants, enrolledAt: new Date().toISOString() },
  });
  const identity = await importIdentity((await keyStore.load())!);
  if (relay) {
    relay.devices.push(cert);
    relay.grants.set(deviceId, grants);
  }
  return { identity, keyStore, cert };
}

/** The owner seals an epoch key to a device, as a rotation does. */
export function sealEpochTo(
  owner: Identity,
  to: { deviceId: string; exchangePub: string },
  epoch: number,
  raw: Uint8Array,
): Promise<EpochGrant> {
  return createEpochGrant({
    issuerDeviceId: owner.config.deviceId,
    issuerSigningKey: owner.keys.signing.privateKey,
    installationId: owner.config.installationId,
    recipientDeviceId: to.deviceId,
    recipientExchangePub: to.exchangePub,
    epoch,
    epochKeyRaw: raw,
  });
}

export async function setupBridge(over: Partial<BridgeOptions> = {}) {
  const identity = await makeIdentity();
  const relay = new FakeRelay(identity);
  await relay.initOwner();
  const phone = await makePhone(identity);
  relay.devices.push(phone.cert);
  const sink = new FakeSink();
  sink.addPane('pane-1');
  const store = new MemoryLocalStore();
  const client = new RelayClient({
    identity,
    fetch: relay.fetch,
    sleep: async () => {},
    maxRetries: 0,
  });
  const bridge = new DecisionsBridge({
    identity,
    store,
    sink,
    client,
    policy: new PolicyRegistry(),
    pumpIntervalMs: 0,
    ...over,
  });
  return { identity, relay, phone, sink, store, client, bridge };
}

export class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
    this.readyState = 1;
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  recv(frame: unknown) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
