import {
  EventData,
  PROTOCOL_VERSION,
  type ActionKind,
  type CryptoEnvelope,
  type DeviceCert,
  type LedgerEvent,
  type SignedAction,
  type SignedQuestion,
} from '@daintree/decisions-protocol';
import {
  buildSignedAction,
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
} from '@daintree/decisions-crypto';
import { bytesToBase64Url } from '@daintree/decisions-protocol';
import {
  DecisionsBridge,
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
  calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
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
    this.calls.push({ method, path: url.pathname, body, headers });
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
        key_epoch: 1,
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
    if (method === 'POST' && /^\/api\/v1\/attachments\/[^/]+\/complete$/.test(p))
      return json(200, { ok: true });
    if (method === 'POST' && p.startsWith('/api/v1/deliveries/')) return json(200, { ok: true });
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

export class FakeSink implements TerminalSink {
  panes = new Map<
    string,
    { generation: number; session: string | null; idle: boolean; hostOffline?: boolean }
  >();
  typed: { target: TerminalTarget; text: string; id: string }[] = [];
  injectBehaviour: 'ok' | 'throw' | 'busy' | 'fail' = 'ok';
  resumeTarget: TerminalTarget | null = null;
  locateCalls = 0;
  /** Return a state for the Nth locate() call to simulate the terminal changing underneath us. */
  locateOverride: ((call: number, o: QuestionOrigin) => LocateResult | undefined) | null = null;

  addPane(
    paneId: string,
    over: Partial<{
      generation: number;
      session: string | null;
      idle: boolean;
      hostOffline: boolean;
    }> = {},
  ) {
    this.panes.set(paneId, { generation: 1, session: 'sess-1', idle: true, ...over });
  }
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    this.locateCalls++;
    const forced = this.locateOverride?.(this.locateCalls, o);
    if (forced) return forced;
    const p = this.panes.get(o.pane_id);
    if (!p) return { state: 'gone' };
    if (p.hostOffline) return { state: 'host-offline' };
    if (p.generation !== o.terminal_generation) return { state: 'generation-mismatch' };
    if (p.session !== o.agent_session_id) return { state: 'session-mismatch' };
    return {
      state: 'alive',
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: p.generation,
        agentSessionId: p.session,
        worktreeId: o.worktree_id,
      },
    };
  }
  async isIdle(t: TerminalTarget) {
    return this.panes.get(t.paneId)?.idle ?? false;
  }
  async inject(t: TerminalTarget, text: string, id: string): Promise<InjectResult> {
    if (this.injectBehaviour === 'throw') {
      this.typed.push({ target: t, text, id }); // it may have been typed before the crash
      throw new Error('boom');
    }
    if (this.injectBehaviour === 'busy') return { ok: false, reason: 'busy' };
    if (this.injectBehaviour === 'fail') return { ok: false, reason: 'write_failed' };
    this.typed.push({ target: t, text, id });
    return { ok: true, proof: 'p' };
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
