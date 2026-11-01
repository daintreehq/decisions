import {
  API_PREFIX,
  EventsPage,
  PROTOCOL_VERSION,
  type ActionKind,
  type ClaimResponse,
  type CommandReceipt,
  type DeviceCert,
  type DevicesResponse,
  type Diagnostics,
  type EpochGrant,
  type InfoResponse,
  type PendingPairing,
  type QuestionDetail,
  type SignedAction,
  type SignedQuestion,
} from '@daintree/decisions-protocol';
import { signRequest } from '@daintree/decisions-crypto';
import { RelayError } from './errors.js';
import type { Identity } from './identity.js';

type ActionBodyShape = { protocol_version: 1; idempotency_key: string; action: SignedAction };

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
  retry?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  readonly identity: Identity;
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
        });
      } catch (e) {
        const err = new RelayError('network_error', (e as Error).message || 'network error', 0);
        if (opts.retry === false || attempt >= this.maxRetries) throw err;
        await this.sleep(backoffMs(attempt++));
        continue;
      }
      if (res.ok && opts.raw) return new Uint8Array(await res.arrayBuffer()) as T;
      const text = await res.text();
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
  async info(): Promise<InfoResponse> {
    const res = await this.f(`${this.origin}${API_PREFIX}/info`);
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
  postAction(
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
  deleteQuestion(id: string): Promise<unknown> {
    return this.request('DELETE', `${API_PREFIX}/questions/${id}`);
  }

  /* ---- events / socket ---- */
  async events(after: number, limit = 100): Promise<EventsPage> {
    const raw = await this.request<unknown>('GET', `${API_PREFIX}/events`, {
      query: { after, limit },
    });
    return EventsPage.parse(raw);
  }
  socketTicket() {
    return this.request<{ ticket: string; expires_at: string; ws_path: string }>(
      'POST',
      `${API_PREFIX}/socket-ticket`,
      {
        body: { protocol_version: PROTOCOL_VERSION },
        retry: false,
      },
    );
  }

  /* ---- pairing ---- */
  createInvitation(body: {
    pairing_id: string;
    invite_digest: string;
    expires_at: string;
    role: 'phone' | 'tablet';
  }) {
    return this.request<{ ok: true }>('POST', `${API_PREFIX}/pairing/invitations`, {
      body: { protocol_version: PROTOCOL_VERSION, ...body },
    });
  }
  pendingPairings() {
    return this.request<{ pending: PendingPairing[] }>('GET', `${API_PREFIX}/pairing/pending`);
  }
  approvePairing(pairingId: string, cert: DeviceCert, grant: EpochGrant) {
    return this.request('POST', `${API_PREFIX}/pairing/${pairingId}/approve`, {
      body: { protocol_version: PROTOCOL_VERSION, cert, grant },
    });
  }
  rejectPairing(pairingId: string) {
    return this.request('POST', `${API_PREFIX}/pairing/${pairingId}/reject`, {
      body: { protocol_version: PROTOCOL_VERSION },
    });
  }

  /* ---- devices ---- */
  devices(): Promise<DevicesResponse> {
    return this.request('GET', `${API_PREFIX}/devices`);
  }
  revokeDevice(deviceId: string, newKeyEpoch: number, grants: EpochGrant[]) {
    return this.request('POST', `${API_PREFIX}/devices/${deviceId}/revoke`, {
      body: { protocol_version: PROTOCOL_VERSION, new_key_epoch: newKeyEpoch, grants },
    });
  }
  rotateEpoch(newKeyEpoch: number, grants: EpochGrant[]) {
    return this.request('POST', `${API_PREFIX}/epoch/rotate`, {
      body: { protocol_version: PROTOCOL_VERSION, new_key_epoch: newKeyEpoch, grants },
    });
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
  downloadAttachment(attachmentId: string): Promise<Uint8Array> {
    return this.request('GET', `${API_PREFIX}/attachments/${attachmentId}/content`, { raw: true });
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
    return this.request('GET', `${API_PREFIX}/admin/diagnostics`);
  }
  deleteData(scope: 'questions' | 'everything') {
    return this.request('POST', `${API_PREFIX}/admin/delete-data`, {
      body: { protocol_version: PROTOCOL_VERSION, confirm: 'DELETE', scope },
    });
  }
}

export type { ClaimResponse };
