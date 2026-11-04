import {
  API_PREFIX,
  EventsPage,
  FEATURES_QUERY_PARAM,
  KeyGrantsResponse,
  PROTOCOL_VERSION,
  formatFeatures,
  type ActionKind,
  type ClaimResponse,
  type CommandReceipt,
  type DeviceCert,
  type DevicesResponse,
  type Diagnostics,
  type EpochGrant,
  type InfoResponse,
  type MessageBody,
  type MessageReceipt,
  type PaneSnapshotBody,
  type PendingPairing,
  type ProtocolFeature,
  type QuestionDetail,
  type SignedAction,
  type SignedMessage,
  type SignedQuestion,
} from '@daintreehq/decisions-protocol';
import { signRequest } from '@daintreehq/decisions-crypto';
import { RelayError } from './errors.js';
import type { Identity } from './identity.js';

type ActionBodyShape = { protocol_version: 1; idempotency_key: string; action: SignedAction };

/** Actions only a human device signs (human provenance). No desktop ever signs one. */
const HUMAN_ACTIONS: ReadonlySet<ActionKind> = new Set(['answer', 'override', 'confirm-proxy']);

export interface RelayClientOptions {
  identity: Identity;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Retries for transient failures (network, 429, 5xx). 4xx are never retried. Default 3. */
  maxRetries?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Raw body (attachment upload); signed by its SHA-256. */
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  /** Return the response body as bytes instead of parsing JSON. */
  raw?: boolean;
  /** `raw` only: refuse a body larger than this many bytes (`payload_too_large`) without reading the rest. */
  maxBytes?: number;
  retry?: boolean;
  /** Abort an attempt that has not answered within this long (a network error). */
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A raw response body, read only as far as `max` allows: a relay cannot make the client buffer more. */
async function readRaw(res: Response, max: number | undefined): Promise<Uint8Array> {
  if (max === undefined) return new Uint8Array(await res.arrayBuffer());
  const tooLarge = () =>
    new RelayError('payload_too_large', `response larger than ${max} bytes`, res.status);
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.length > max) throw tooLarge();
    return all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function backoffMs(
  attempt: number,
  baseMs = 500,
  capMs = 30_000,
  rand: () => number = Math.random,
): number {
  // Full jitter: uniform in [0, min(cap, base * 2^attempt)].
  return Math.floor(rand() * Math.min(capMs, baseMs * 2 ** attempt));
}

export class RelayClient {
  /** Replaceable: a running listener swaps in rotated epoch material without reconnecting. */
  identity: Identity;
  private readonly f: typeof fetch;
  private readonly nowFn: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  /** Server time minus local time, learned from a Date header after a skew rejection. */
  private skewMs = 0;

  constructor(opts: RelayClientOptions) {
    this.identity = opts.identity;
    this.f = opts.fetch ?? fetch;
    this.nowFn = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  get origin(): string {
    return this.identity.config.relayOrigin;
  }

  /**
   * Owner-only routes refuse to run as a `desktop-host` before anything is signed or sent, so a Host never
   * attempts them (the relay would refuse them too). The refusal is permanent: it is never retried.
   */
  private async ownerOnly<T>(what: string, send: () => Promise<T>): Promise<T> {
    if (this.identity.role !== 'owner-desktop') {
      throw new RelayError(
        'forbidden',
        `${what} is only possible on the owner desktop, not on an enrolled Host`,
        403,
      );
    }
    return send();
  }

  private qs(query?: RequestOptions['query']): string {
    if (!query) return '';
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) p.set(k, String(v));
    return p.toString();
  }

  /** Sign a request for tunnelling over the WebSocket (`req` frame). */
  async signForSocket(method: string, path: string, query: string, body: string | undefined) {
    const { authorization } = await signRequest({
      method,
      path,
      query,
      body: body ?? null,
      installationId: this.identity.config.installationId,
      deviceId: this.identity.config.deviceId,
      signingKey: this.identity.keys.signing.privateKey,
      now: this.nowFn() + this.skewMs,
    });
    return authorization;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const query = this.qs(opts.query);
    const bodyText = opts.rawBody
      ? undefined
      : opts.body === undefined
        ? undefined
        : JSON.stringify(opts.body);
    const bodyBytes = opts.rawBody ?? bodyText;
    let skewRetried = false;
    let attempt = 0;
    for (;;) {
      const { authorization } = await signRequest({
        method,
        path,
        query,
        body: bodyBytes ?? null,
        installationId: this.identity.config.installationId,
        deviceId: this.identity.config.deviceId,
        signingKey: this.identity.keys.signing.privateKey,
        now: this.nowFn() + this.skewMs,
      });
      let res: Response;
      try {
        res = await this.f(`${this.origin}${path}${query ? `?${query}` : ''}`, {
          method,
          headers: {
            ...(opts.headers ?? {}),
            authorization,
            accept: 'application/json',
            ...(bodyText !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(opts.rawBody ? { 'content-type': 'application/octet-stream' } : {}),
          },
          body: (opts.rawBody as unknown as BodyInit | undefined) ?? bodyText,
          ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
        });
      } catch (e) {
        const err = new RelayError('network_error', (e as Error).message || 'network error', 0);
        if (opts.retry === false || attempt >= this.maxRetries) throw err;
        await this.sleep(backoffMs(attempt++));
        continue;
      }
      let text: string;
      try {
        if (res.ok && opts.raw) return (await readRaw(res, opts.maxBytes)) as T;
        text = await res.text();
      } catch (e) {
        if (e instanceof RelayError) throw e;
        // The body broke off (a reset, or `timeoutMs` running out after the headers): a network error.
        throw new RelayError('network_error', (e as Error).message || 'network error', 0);
      }
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      const err = RelayError.fromBody(res.status, text);
      if (err.code === 'not_authenticated' && !skewRetried) {
        const date = res.headers.get('date');
        const server = date ? Date.parse(date) : NaN;
        if (Number.isFinite(server)) {
          const skew = server - this.nowFn();
          if (Math.abs(skew - this.skewMs) > 1000) {
            this.skewMs = skew;
            skewRetried = true;
            continue;
          }
        }
      }
      if (!err.retryable || opts.retry === false || attempt >= this.maxRetries) throw err;
      await this.sleep(err.retryAfterMs ?? backoffMs(attempt));
      attempt++;
    }
  }

  /* ---- public ---- */
  async health(): Promise<{ ok: boolean }> {
    const res = await this.f(`${this.origin}/health`);
    return (await res.json()) as { ok: boolean };
  }
  async info(timeoutMs?: number): Promise<InfoResponse> {
    const res = await this.f(
      `${this.origin}${API_PREFIX}/info`,
      timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined,
    );
    if (!res.ok) throw RelayError.fromBody(res.status, await res.text());
    return (await res.json()) as InfoResponse;
  }

  /* ---- questions ---- */
  createQuestion(idempotencyKey: string, question: SignedQuestion): Promise<CommandReceipt> {
    return this.request('POST', `${API_PREFIX}/questions`, {
      body: { protocol_version: PROTOCOL_VERSION, idempotency_key: idempotencyKey, question },
    });
  }
  getQuestion(id: string): Promise<QuestionDetail> {
    return this.request('GET', `${API_PREFIX}/questions/${id}`);
  }
  listQuestions(q: { status?: string; cursor?: string; limit?: number } = {}) {
    return this.request<{ questions: unknown[]; next_cursor: string | null }>(
      'GET',
      `${API_PREFIX}/questions`,
      { query: q },
    );
  }
  async postAction(
    kind: ActionKind,
    questionId: string,
    idempotencyKey: string,
    action: SignedAction,
  ): Promise<CommandReceipt> {
    // A desktop signs only proxy provenance: answers, overrides and confirmations are a human's, from a phone.
    if (HUMAN_ACTIONS.has(kind)) {
      throw new RelayError(
        'forbidden',
        `a desktop never signs "${kind}": only a phone or tablet answers as a human`,
        403,
      );
    }
    const send = () => this.sendAction(kind, questionId, idempotencyKey, action);
    return kind === 'reopen' ? this.ownerOnly('reopening a question', send) : send();
  }
  private sendAction(
    kind: ActionKind,
    questionId: string,
    idempotencyKey: string,
    action: SignedAction,
  ): Promise<CommandReceipt> {
    const body: ActionBodyShape = {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: idempotencyKey,
      action,
    };
    return this.request('POST', `${API_PREFIX}/questions/${questionId}/${kind}`, { body });
  }
  /** Post an agent message into a question's thread (docs/protocol.md section 16). */
  postMessage(
    questionId: string,
    idempotencyKey: string,
    message: SignedMessage,
  ): Promise<MessageReceipt> {
    // A desktop speaks only for its agent: a human message is a phone's or tablet's, like a human answer.
    if (message.record.side !== 'agent') {
      return Promise.reject(
        new RelayError(
          'forbidden',
          'a desktop never signs a human message: only a phone or tablet speaks for the person',
          403,
        ),
      );
    }
    const body: MessageBody = {
      protocol_version: PROTOCOL_VERSION,
      idempotency_key: idempotencyKey,
      message,
    };
    return this.request('POST', `${API_PREFIX}/questions/${questionId}/messages`, { body });
  }
  deleteQuestion(id: string): Promise<unknown> {
    return this.ownerOnly('deleting a question', () =>
      this.request('DELETE', `${API_PREFIX}/questions/${id}`),
    );
  }

  /* ---- events / socket ---- */
  /**
   * One page of events. `features` declares the protocol extensions the caller understands (section 19); the
   * relay leaves out events that need any other. None declared is the 0.3.0 baseline.
   */
  async events(
    after: number,
    limit = 100,
    features: readonly ProtocolFeature[] = [],
  ): Promise<EventsPage> {
    const declared = formatFeatures(features);
    const raw = await this.request<unknown>('GET', `${API_PREFIX}/events`, {
      query: { after, limit, ...(declared ? { [FEATURES_QUERY_PARAM]: declared } : {}) },
    });
    return EventsPage.parse(raw);
  }
  /** A socket ticket. `features` declares what the socket may be sent, as for `events`. */
  socketTicket(features: readonly ProtocolFeature[] = []) {
    const declared = [...new Set(features)].sort();
    return this.request<{ ticket: string; expires_at: string; ws_path: string }>(
      'POST',
      `${API_PREFIX}/socket-ticket`,
      {
        body: {
          protocol_version: PROTOCOL_VERSION,
          ...(declared.length ? { features: declared } : {}),
        },
        retry: false,
      },
    );
  }

  /* ---- pane snapshots (section 18) ---- */
  /**
   * Replace the question's snapshot. Never retried here: the snapshot publisher owns the timing, so a stopped
   * bridge leaves no sleeping retry behind.
   */
  putSnapshot(questionId: string, body: PaneSnapshotBody, timeoutMs?: number): Promise<unknown> {
    return this.request('PUT', `${API_PREFIX}/questions/${questionId}/snapshot`, {
      body,
      retry: false,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  /* ---- pairing ---- */
  createInvitation(body: {
    pairing_id: string;
    invite_digest: string;
    expires_at: string;
    role: 'phone' | 'tablet';
  }) {
    return this.ownerOnly('pairing a device', () =>
      this.request<{ ok: true }>('POST', `${API_PREFIX}/pairing/invitations`, {
        body: { protocol_version: PROTOCOL_VERSION, ...body },
      }),
    );
  }
  pendingPairings() {
    return this.ownerOnly('listing pending pairings', () =>
      this.request<{ pending: PendingPairing[] }>('GET', `${API_PREFIX}/pairing/pending`),
    );
  }
  approvePairing(pairingId: string, cert: DeviceCert, grant: EpochGrant) {
    return this.ownerOnly('approving a device', () =>
      this.request('POST', `${API_PREFIX}/pairing/${pairingId}/approve`, {
        body: { protocol_version: PROTOCOL_VERSION, cert, grant },
      }),
    );
  }
  rejectPairing(pairingId: string) {
    return this.ownerOnly('rejecting a pairing', () =>
      this.request('POST', `${API_PREFIX}/pairing/${pairingId}/reject`, {
        body: { protocol_version: PROTOCOL_VERSION },
      }),
    );
  }

  /* ---- devices ---- */
  devices(): Promise<DevicesResponse> {
    return this.request('GET', `${API_PREFIX}/devices`);
  }
  revokeDevice(deviceId: string, newKeyEpoch: number, grants: EpochGrant[]) {
    return this.ownerOnly('revoking a device', () =>
      this.request('POST', `${API_PREFIX}/devices/${deviceId}/revoke`, {
        body: { protocol_version: PROTOCOL_VERSION, new_key_epoch: newKeyEpoch, grants },
      }),
    );
  }
  /** Owner only: register a `desktop-host` with its owner-issued certificate and current-epoch grant. */
  enrollHost(cert: DeviceCert, grant: EpochGrant) {
    return this.ownerOnly('enrolling a Host', () =>
      this.request<{ device_id: string }>('POST', `${API_PREFIX}/devices/enroll-host`, {
        body: { protocol_version: PROTOCOL_VERSION, cert, grant },
      }),
    );
  }
  /** This device's own sealed epoch grants (the relay refuses any other device id). */
  async keyGrants(
    deviceId = this.identity.config.deviceId,
  ): Promise<{ current_epoch: number; grants: EpochGrant[] }> {
    const raw = await this.request<unknown>('GET', `${API_PREFIX}/devices/${deviceId}/key-grants`);
    return KeyGrantsResponse.parse(raw);
  }
  rotateEpoch(newKeyEpoch: number, grants: EpochGrant[]) {
    return this.ownerOnly('rotating the content key', () =>
      this.request('POST', `${API_PREFIX}/epoch/rotate`, {
        body: { protocol_version: PROTOCOL_VERSION, new_key_epoch: newKeyEpoch, grants },
      }),
    );
  }

  /* ---- attachments ---- */
  reserveAttachment(body: {
    idempotency_key: string;
    question_id: string;
    ciphertext_bytes: number;
    sha256_ciphertext: string;
    /** Client-chosen id: the attachment AAD binds it and the digest is needed at reservation time. */
    attachment_id: string;
  }) {
    return this.request<{ attachment_id: string; upload_path: string; expires_at: string }>(
      'POST',
      `${API_PREFIX}/attachments/reservations`,
      { body: { protocol_version: PROTOCOL_VERSION, mime_category: 'image', ...body } },
    );
  }
  /** The request is signed with body_sha256 = the ciphertext digest declared in `X-Content-Sha256`. */
  uploadAttachment(uploadPath: string, ciphertext: Uint8Array, sha256Ciphertext: string) {
    return this.request('PUT', uploadPath, {
      rawBody: ciphertext,
      headers: { 'x-content-sha256': sha256Ciphertext },
    });
  }
  /** Ciphertext bytes. `maxBytes` refuses a larger body (`payload_too_large`) before it is buffered. */
  downloadAttachment(attachmentId: string, opts: { maxBytes?: number } = {}): Promise<Uint8Array> {
    return this.request('GET', `${API_PREFIX}/attachments/${attachmentId}/content`, {
      raw: true,
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    });
  }
  completeAttachment(attachmentId: string) {
    return this.request('POST', `${API_PREFIX}/attachments/${attachmentId}/complete`, {
      body: { protocol_version: PROTOCOL_VERSION },
    });
  }

  /* ---- deliveries ---- */
  deliveriesReceived(seq: number) {
    return this.request('POST', `${API_PREFIX}/deliveries/received`, {
      body: { protocol_version: PROTOCOL_VERSION, seq },
    });
  }
  deliveriesTerminal(body: {
    idempotency_key: string;
    question_id: string;
    answer_revision: number;
    injection_id: string;
    host_id: string;
  }) {
    return this.request('POST', `${API_PREFIX}/deliveries/terminal`, {
      body: { protocol_version: PROTOCOL_VERSION, ...body },
    });
  }
  deliveriesFailed(body: {
    idempotency_key: string;
    question_id: string;
    answer_revision: number;
    host_id: string;
    status: 'needs-attention' | 'delivery-uncertain';
    error_code: string;
  }) {
    return this.request('POST', `${API_PREFIX}/deliveries/failed`, {
      body: { protocol_version: PROTOCOL_VERSION, ...body },
    });
  }

  /* ---- misc ---- */
  pushConfig() {
    return this.request<{ vapid_public_key: string }>('GET', `${API_PREFIX}/push/config`);
  }
  diagnostics(): Promise<Diagnostics> {
    return this.ownerOnly('reading diagnostics', () =>
      this.request('GET', `${API_PREFIX}/admin/diagnostics`),
    );
  }
  deleteData(scope: 'questions' | 'everything') {
    return this.ownerOnly('deleting relay data', () =>
      this.request('POST', `${API_PREFIX}/admin/delete-data`, {
        body: { protocol_version: PROTOCOL_VERSION, confirm: 'DELETE', scope },
      }),
    );
  }
}

export type { ClaimResponse };
