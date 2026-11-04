import {
  EventData,
  PROTOCOL_VERSION,
  type ActionKind,
  type CryptoEnvelope,
  type DeviceCert,
  type EpochGrant,
  type LedgerEvent,
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
  /** Thread messages the relay committed, in commit order. */
  messages: { idem: string; message: SignedMessage }[] = [];
  /** The status and code every upcoming message POST is refused with, until cleared. */
  rejectMessage: { status: number; code: string } | null = null;
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
        return json(this.rejectMessage.status, { code: this.rejectMessage.code, message: 'no' });
      const b = body as { idempotency_key: string; message: SignedMessage };
      const id = b.message.record.message_id;
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
      if (this.dropCreateReply > 0) {
        this.dropCreateReply--;
        throw new TypeError('connection reset after the relay committed the question');
      }
      return json(201, receipt);
    }
    if (
      (m = p.match(/^\/api\/v1\/questions\/([^/]+)\/(cancel|proxy-answer|proxy-abstain)$/)) &&
      method === 'POST'
    ) {
      const b = body as { idempotency_key: string; action: SignedAction };
      return json(201, {
        question_id: m[1],
        revision: b.action.record.expected_revision,
        status: 'open',
        event_seq: null,
      });
    }
    if (method === 'GET' && p === '/api/v1/devices') {
      const certs = [this.ownerCert(), ...this.devices];
      return json(200, {
        key_epoch: this.epoch,
        owner_device_id: this.owner.config.deviceId,
        devices: certs.map((cert) => ({
          device_id: cert.device_id,
          role: cert.role,
          label: cert.label,
          created_at: cert.issued_at,
          revoked_at: null,
          last_seen_at: null,
          last_ack_seq: 0,
          cert,
          push_enabled: false,
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
    provenance?: 'human' | 'proxy';
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
