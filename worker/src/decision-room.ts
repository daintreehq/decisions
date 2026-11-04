import { DurableObject } from 'cloudflare:workers';
import {
  ApiError,
  ClientFrame,
  LIMITS,
  PROTOCOL_VERSION,
  WS_CLOSE,
  base64UrlToBytes,
  buildEventsPage,
  bytesToBase64Url,
  isEventVisible,
  knownFeatures,
  parseAuthHeader,
  utf8ByteLength,
  type EventsPage,
  type LedgerEvent,
  type ProtocolFeature,
  type Role,
  type ServerFrame,
} from '@daintreehq/decisions-protocol';
import {
  importSigningPublicKey,
  newId,
  sha256Hex,
  verifyRequestSignature,
} from '@daintreehq/decisions-crypto';
import { migrate } from './db/schema.js';
import { WORKER_VERSION, type Env } from './env.js';
import type { Auth, DeviceRow, Handler, JobInput, Room, RouteCtx, Settings } from './room/types.js';
import { ROUTES } from './routes/index.js';
import { processDueJobs } from './jobs/alarm.js';
import { applyAck } from './room/ack.js';
import { nextSnapshotRetention, sweepSnapshotRetention } from './room/snapshots.js';
import {
  errorResponse,
  iso,
  json,
  nowMs,
  parseJson,
  type ApiRequest,
  type ApiResponse,
  type VoiceTicketPayload,
} from './util.js';
import type { z } from 'zod';

export type RpcResult<T> = { ok: true; value: T } | { ok: false; status: number; body: string };

interface SocketAttachment {
  deviceId: string;
  role: Role;
  /**
   * What the socket's ticket declared (docs/protocol.md section 19). It decides which events the socket is sent;
   * a socket accepted before features existed has none, which is the 0.3.0 baseline.
   */
  features?: ProtocolFeature[];
}

/** A socket `sync` replay is bounded by events and bytes; `caught_up.has_more` says to continue. */
const SYNC_MAX_EVENTS = 2000;
const SYNC_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_SETTINGS: Settings = {
  quiet_hours: { enabled: false, start: '22:00', end: '07:00', time_zone: 'UTC' },
  reminders: { enabled: true, first_ms: 4 * 3600_000, interval_ms: 24 * 3600_000, max: 3 },
  proxy_review_reminder: true,
  attachment_retention_days: 30,
};

export class DecisionRoom extends DurableObject<Env> implements Room {
  override readonly env: Env;
  private readonly sql: SqlStorage;
  private outbox: LedgerEvent[] = [];
  private keyCache = new Map<string, CryptoKey>();
  private alarmDirty = false;
  private lastNoncePurge = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => migrate(this.sql));
    // Plain-text keep-alive answered by the runtime without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /* ---------------- SQL helpers ---------------- */

  q<T = Record<string, unknown>>(sql: string, ...b: SqlStorageValue[]): T[] {
    return this.sql.exec(sql, ...b).toArray() as T[];
  }
  q1<T = Record<string, unknown>>(sql: string, ...b: SqlStorageValue[]): T | undefined {
    return this.q<T>(sql, ...b)[0];
  }
  run(sql: string, ...b: SqlStorageValue[]): number {
    return this.sql.exec(sql, ...b).rowsWritten;
  }

  async tx<T>(fn: () => T): Promise<T> {
    let result: T;
    try {
      result = this.ctx.storage.transactionSync(fn);
    } catch (e) {
      this.outbox = [];
      this.alarmDirty = false;
      throw e;
    }
    const events = this.outbox;
    this.outbox = [];
    for (const ev of events) this.broadcastEvent(ev);
    if (this.alarmDirty) {
      this.alarmDirty = false;
      await this.refreshAlarm();
    }
    return result;
  }

  emit(
    type: LedgerEvent['event_type'],
    a: {
      questionId?: string | null;
      revision?: number | null;
      deviceId?: string | null;
      data: Record<string, unknown>;
    },
  ): LedgerEvent {
    const t = nowMs();
    const eventId = newId(t);
    const row = this.q1<{ seq: number }>(
      `INSERT INTO events (event_id, event_type, question_id, question_revision, origin_device_id, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      eventId,
      type,
      a.questionId ?? null,
      a.revision ?? null,
      a.deviceId ?? null,
      JSON.stringify(a.data),
      t,
    )!;
    const ev: LedgerEvent = {
      protocol_version: PROTOCOL_VERSION,
      seq: row.seq,
      event_id: eventId,
      event_type: type,
      occurred_at: iso(t),
      question_id: a.questionId ?? null,
      question_revision: a.revision ?? null,
      origin_device_id: a.deviceId ?? null,
      data: a.data,
    };
    this.outbox.push(ev);
    return ev;
  }

  getMeta(key: string): string | undefined {
    return this.q1<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)?.value;
  }
  setMeta(key: string, value: string): void {
    this.run(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
  installationId(): string | undefined {
    return this.getMeta('installation_id');
  }
  currentEpoch(): number {
    return Number(this.getMeta('current_epoch') ?? '1');
  }
  settings(): Settings {
    const raw = this.getMeta('settings');
    if (!raw) return DEFAULT_SETTINGS;
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Settings) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
  vapid() {
    const raw = this.getMeta('vapid');
    return raw ? (JSON.parse(raw) as { privateJwk: JsonWebKey; publicKey: string }) : undefined;
  }

  /* ---------------- devices and authentication ---------------- */

  getDevice(id: string): DeviceRow | undefined {
    return this.q1<DeviceRow>(`SELECT * FROM devices WHERE device_id = ?`, id);
  }

  async devicePublicKey(d: Pick<DeviceRow, 'device_id' | 'signing_pub'>): Promise<CryptoKey> {
    const hit = this.keyCache.get(d.device_id);
    if (hit) return hit;
    const key = await importSigningPublicKey(d.signing_pub);
    this.keyCache.set(d.device_id, key);
    return key;
  }
  forgetDeviceKey(id: string): void {
    this.keyCache.delete(id);
  }

  hit(key: string, limit: number, windowMs: number): void {
    const t = nowMs();
    const row = this.q1<{ window_start: number; count: number }>(
      `SELECT window_start, count FROM rate_limits WHERE key = ?`,
      key,
    );
    if (!row || t - row.window_start >= windowMs) {
      this.run(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
        key,
        t,
      );
      return;
    }
    if (row.count >= limit) {
      throw new ApiError('rate_limited', 'too many requests', {
        retryAfterMs: Math.max(1000, row.window_start + windowMs - t),
      });
    }
    this.run(`UPDATE rate_limits SET count = count + 1 WHERE key = ?`, key);
  }

  assertBudget(key: string, limit: number, windowMs: number): void {
    const row = this.q1<{ window_start: number; count: number }>(
      `SELECT window_start, count FROM rate_limits WHERE key = ?`,
      key,
    );
    const t = nowMs();
    if (row && t - row.window_start < windowMs && row.count >= limit) {
      throw new ApiError('rate_limited', 'too many failed attempts', {
        retryAfterMs: Math.max(1000, row.window_start + windowMs - t),
      });
    }
  }

  assertActive(deviceId: string): void {
    const d = this.getDevice(deviceId);
    if (!d || d.revoked_at !== null)
      throw new ApiError('not_authenticated', 'unknown or revoked device');
  }

  async resetRuntime(): Promise<void> {
    this.keyCache.clear();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ t: 'revoked' } satisfies ServerFrame));
        ws.close(WS_CLOSE.revoked, 'relay reset');
      } catch {
        /* already closed */
      }
    }
    await this.ctx.storage.deleteAlarm();
  }

  async authenticate(req: ApiRequest, roles?: readonly Role[]): Promise<Auth> {
    const t = nowMs();
    const header = parseAuthHeader(req.authorization);
    if (!header) throw new ApiError('not_authenticated', 'missing or malformed Authorization');
    if (header.v > PROTOCOL_VERSION)
      throw new ApiError('upgrade_required', 'unsupported protocol version');
    const inst = this.installationId();
    if (!inst || header.installationId !== inst)
      throw new ApiError('not_authenticated', 'unknown installation');
    // Brake on repeated failures per source; successful requests never consume this budget.
    this.assertBudget(`authfail:${req.ip}`, 20, 10 * 60_000);
    if (Math.abs(t - header.ts) > LIMITS.requestSkewMs) {
      throw new ApiError('not_authenticated', 'request timestamp outside allowed skew', {
        details: { server_time: iso(t) },
      });
    }
    const device = this.getDevice(header.deviceId);
    if (!device || device.revoked_at !== null)
      throw new ApiError('not_authenticated', 'unknown or revoked device');
    const bodySha256 = req.declaredBodySha256 ?? (await sha256Hex(req.body));
    const ok = await verifyRequestSignature({
      header,
      method: req.method,
      path: req.path,
      query: req.query,
      bodySha256,
      devicePublicKey: await this.devicePublicKey(device),
    });
    if (!ok) {
      this.hit(`authfail:${req.ip}`, 20, 10 * 60_000);
      throw new ApiError('not_authenticated', 'bad signature');
    }
    // Re-read after the async verification: the device may have been revoked meanwhile.
    const fresh = this.getDevice(header.deviceId);
    if (!fresh || fresh.revoked_at !== null)
      throw new ApiError('not_authenticated', 'unknown or revoked device');
    // Replay protection: the nonce insert and everything after it are synchronous.
    if (t - this.lastNoncePurge > 60_000) {
      this.lastNoncePurge = t;
      this.run(`DELETE FROM request_nonces WHERE expires_at < ?`, t);
    }
    const inserted = this.run(
      `INSERT OR IGNORE INTO request_nonces (device_id, nonce, expires_at) VALUES (?, ?, ?)`,
      header.deviceId,
      header.nonce,
      t + LIMITS.nonceTtlMs,
    );
    if (inserted === 0) throw new ApiError('not_authenticated', 'replayed request');
    if (roles && !roles.includes(fresh.role))
      throw new ApiError('forbidden', `role ${fresh.role} may not do this`);
    this.hit(`dev:${fresh.device_id}`, 600, 60_000);
    if (!fresh.last_seen_at || t - fresh.last_seen_at > 60_000) {
      this.run(`UPDATE devices SET last_seen_at = ? WHERE device_id = ?`, t, fresh.device_id);
    }
    return { deviceId: fresh.device_id, role: fresh.role, installationId: inst };
  }

  async mintTicket(
    kind: 'ws' | 'voice',
    deviceId: string,
    payload: Record<string, unknown>,
    ttlMs: number,
  ): Promise<string> {
    const raw = crypto.getRandomValues(new Uint8Array(24));
    const ticket = bytesToBase64Url(raw);
    const hash = await sha256Hex(raw);
    const t = nowMs();
    this.run(`DELETE FROM tickets WHERE expires_at < ?`, t);
    this.run(
      `INSERT INTO tickets (ticket_hash, kind, device_id, payload, expires_at) VALUES (?, ?, ?, ?, ?)`,
      hash,
      kind,
      deviceId,
      JSON.stringify(payload),
      t + ttlMs,
    );
    return ticket;
  }

  private async takeTicket(
    ticket: string | null,
    kind: 'ws' | 'voice',
  ): Promise<{ deviceId: string; payload: Record<string, unknown> } | null> {
    if (!ticket || !/^[A-Za-z0-9_-]{32}$/.test(ticket)) return null;
    const hash = await sha256Hex(base64UrlToBytes(ticket));
    const row = this.q1<{ device_id: string; payload: string; expires_at: number }>(
      `DELETE FROM tickets WHERE ticket_hash = ? AND kind = ? RETURNING device_id, payload, expires_at`,
      hash,
      kind,
    );
    if (!row || row.expires_at < nowMs()) return null;
    return { deviceId: row.device_id, payload: JSON.parse(row.payload) as Record<string, unknown> };
  }

  /* ---------------- RPC surface used by the outer Worker ---------------- */

  /** All JSON REST routes (HTTP and tunnelled WebSocket requests share this entry point). */
  async handle(req: ApiRequest): Promise<ApiResponse> {
    try {
      return await this.dispatch(req);
    } catch (e) {
      if (e instanceof ApiError) return errorResponse(e, req.requestId);
      console.error(
        JSON.stringify({ level: 'error', request_id: req.requestId, name: (e as Error)?.name }),
      );
      return errorResponse(new ApiError('internal_error', 'internal error'), req.requestId);
    }
  }

  private async dispatch(req: ApiRequest): Promise<ApiResponse> {
    if (utf8ByteLength(req.body) > LIMITS.jsonBodyBytes)
      throw new ApiError('payload_too_large', 'body too large');
    for (const r of ROUTES) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(req.path);
      if (!m) continue;
      const handler: Handler = r.handler;
      let auth: Auth | null = null;
      if (r.auth === 'signed') auth = await this.authenticate(req, r.roles);
      else this.hit(`anon:${req.ip}`, 300, 60_000);
      let digest: string | undefined;
      const ctx: RouteCtx = {
        req,
        auth,
        params: m.slice(1).map((p) => decodeURIComponent(p)),
        body: <T extends z.ZodType>(schema: T) => parseJson(schema, req.body),
        bodyDigest: async () => (digest ??= await sha256Hex(req.body)),
      };
      return await handler(this, ctx);
    }
    throw new ApiError('not_found', 'no such route');
  }

  /**
   * RPC results never throw: a thrown ApiError would lose its `code` crossing the RPC boundary.
   */
  private async wrap<T>(requestId: string, fn: () => Promise<T> | T): Promise<RpcResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('internal_error', 'internal error');
      const res = errorResponse(err, requestId);
      return { ok: false, status: res.status, body: res.body };
    }
  }

  /** Auth-only check for routes whose bodies stream outside the Durable Object (attachments, voice). */
  async authorizeStream(req: ApiRequest, roles?: readonly Role[]): Promise<RpcResult<Auth>> {
    return this.wrap(req.requestId, () => this.authenticate(req, roles));
  }

  async limit(key: string, limit: number, windowMs: number): Promise<RpcResult<true>> {
    return this.wrap('limit', () => {
      this.hit(key, limit, windowMs);
      return true as const;
    });
  }

  async consumeVoiceTicket(
    ticket: string,
  ): Promise<{ deviceId: string; payload: VoiceTicketPayload } | null> {
    const t = await this.takeTicket(ticket, 'voice');
    if (!t) return null;
    const d = this.getDevice(t.deviceId);
    if (!d || d.revoked_at !== null) return null;
    const payload = t.payload as unknown as VoiceTicketPayload;
    // Only a consumed ticket makes a session active; an unused one expires with its ticket.
    this.run(
      `UPDATE voice_sessions SET activated_at = ? WHERE session_id = ?`,
      nowMs(),
      payload.session_id,
    );
    return { deviceId: t.deviceId, payload };
  }

  async voiceEnded(sessionId: string, ms: number): Promise<void> {
    const month = new Date().toISOString().slice(0, 7);
    this.run(`UPDATE voice_sessions SET ended_at = ? WHERE session_id = ?`, nowMs(), sessionId);
    this.run(
      `INSERT INTO voice_usage (month, ms) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET ms = ms + excluded.ms`,
      month,
      Math.max(0, Math.min(ms, LIMITS.voiceMaxSessionMs + 5000)),
    );
  }

  /**
   * Validates the reservation and atomically claims the upload (`reserved` -> `uploading`), so two concurrent
   * PUTs for one attachment can never both write (or one delete the other's object).
   */
  async attachmentForUpload(
    attachmentId: string,
    auth: Auth,
    contentLength: number,
    sha256: string,
  ): Promise<RpcResult<{ object_key: string }>> {
    return this.wrap('upload', () => {
      this.assertActive(auth.deviceId);
      const a = this.q1<{
        object_key: string;
        state: string;
        creator_device_id: string;
        ciphertext_bytes: number;
        sha256_ciphertext: string;
        upload_expires_at: number;
      }>(`SELECT * FROM attachments WHERE attachment_id = ?`, attachmentId);
      if (!a || a.creator_device_id !== auth.deviceId)
        throw new ApiError('not_found', 'no such attachment');
      if (a.state !== 'reserved')
        throw new ApiError('invalid_state', 'attachment is not awaiting upload');
      if (a.upload_expires_at < nowMs())
        throw new ApiError('expired', 'upload authorisation expired');
      if (a.ciphertext_bytes !== contentLength || a.sha256_ciphertext !== sha256) {
        throw new ApiError('validation_error', 'length or digest differs from the reservation');
      }
      const claimed = this.run(
        `UPDATE attachments SET state = 'uploading' WHERE attachment_id = ? AND state = 'reserved'`,
        attachmentId,
      );
      if (claimed === 0) throw new ApiError('invalid_state', 'attachment is not awaiting upload');
      return { object_key: a.object_key };
    });
  }

  /** `uploading` -> `uploaded`. False means the reservation vanished (reset, GC) while streaming. */
  async markUploaded(attachmentId: string): Promise<boolean> {
    return (
      this.run(
        `UPDATE attachments SET state = 'uploaded' WHERE attachment_id = ? AND state = 'uploading'`,
        attachmentId,
      ) > 0
    );
  }

  /** A failed upload releases its claim so the client may retry the same reservation. */
  async abortUpload(attachmentId: string): Promise<void> {
    this.run(
      `UPDATE attachments SET state = 'reserved' WHERE attachment_id = ? AND state = 'uploading'`,
      attachmentId,
    );
  }

  async attachmentForDownload(
    attachmentId: string,
  ): Promise<RpcResult<{ object_key: string; bytes: number }>> {
    return this.wrap('download', () => {
      const a = this.q1<{ object_key: string; state: string; ciphertext_bytes: number }>(
        `SELECT object_key, state, ciphertext_bytes FROM attachments WHERE attachment_id = ?`,
        attachmentId,
      );
      if (!a || a.state !== 'available') throw new ApiError('not_found', 'attachment unavailable');
      return { object_key: a.object_key, bytes: a.ciphertext_bytes };
    });
  }

  /* ---------------- WebSocket (hibernation API) ---------------- */

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname !== '/api/v1/socket' ||
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
    ) {
      return new Response('not found', { status: 404 });
    }
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    try {
      this.hit(`ws:${ip}`, 60, 60_000);
    } catch {
      return new Response('rate limited', { status: 429 });
    }
    const t = await this.takeTicket(url.searchParams.get('ticket'), 'ws');
    const device = t ? this.getDevice(t.deviceId) : undefined;
    if (!t || !device || device.revoked_at !== null)
      return new Response('invalid ticket', { status: 401 });

    for (const old of this.ctx.getWebSockets(device.device_id)) {
      try {
        old.close(WS_CLOSE.replaced, 'replaced by a newer connection');
      } catch {
        /* already closed */
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [device.device_id]);
    server.serializeAttachment({
      deviceId: device.device_id,
      role: device.role,
      features: [...knownFeatures(t.payload.features as string[] | undefined)],
    } satisfies SocketAttachment);
    this.run(`UPDATE devices SET last_seen_at = ? WHERE device_id = ?`, nowMs(), device.device_id);
    server.send(
      JSON.stringify({
        t: 'hello',
        protocol_version: PROTOCOL_VERSION,
        device_id: device.device_id,
        role: device.role,
        key_epoch: this.currentEpoch(),
        high_water: this.highWater(),
        server_time: iso(nowMs()),
      } satisfies ServerFrame),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  private highWater(): number {
    return this.q1<{ m: number | null }>(`SELECT MAX(seq) AS m FROM events`)?.m ?? 0;
  }

  /** Sends a committed event to every socket whose declared features allow it (section 19). */
  private broadcastEvent(ev: LedgerEvent): void {
    const text = JSON.stringify({ t: 'event', event: ev } satisfies ServerFrame);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att || !isEventVisible(ev, knownFeatures(att.features))) continue;
      try {
        ws.send(text);
      } catch {
        /* the runtime will deliver a close event */
      }
    }
  }

  broadcastToRole(roles: Role[], frame: ServerFrame): void {
    const text = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att || !roles.includes(att.role)) continue;
      try {
        ws.send(text);
      } catch {
        /* ignore */
      }
    }
  }

  closeDeviceSockets(deviceId: string, frame?: ServerFrame): void {
    for (const ws of this.ctx.getWebSockets(deviceId)) {
      try {
        if (frame) ws.send(JSON.stringify(frame));
        ws.close(WS_CLOSE.revoked, 'device revoked');
      } catch {
        /* ignore */
      }
    }
  }

  socketCount(): number {
    return this.ctx.getWebSockets().length;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att) return ws.close(WS_CLOSE.badFrame, 'unauthenticated');
    // Re-validate on every wake: the device may have been revoked while hibernating.
    const device = this.getDevice(att.deviceId);
    if (!device || device.revoked_at !== null) {
      this.sendFrame(ws, { t: 'revoked' });
      return ws.close(WS_CLOSE.revoked, 'device revoked');
    }
    if (typeof message !== 'string' || message.length > 1.5 * 1024 * 1024) {
      return ws.close(WS_CLOSE.badFrame, 'text frames only');
    }
    let frame: ReturnType<typeof ClientFrame.safeParse>;
    try {
      frame = ClientFrame.safeParse(JSON.parse(message));
    } catch {
      return ws.close(WS_CLOSE.badFrame, 'invalid JSON');
    }
    if (!frame.success) {
      return this.sendFrame(ws, { t: 'error', code: 'validation_error', message: 'invalid frame' });
    }
    const f = frame.data;
    switch (f.t) {
      case 'sync': {
        try {
          this.hit(`sync:${device.device_id}`, 30, 60_000);
        } catch {
          return this.sendFrame(ws, {
            t: 'error',
            code: 'rate_limited',
            message: 'too many sync requests',
          });
        }
        // Replay is bounded by events and bytes, and carries only what the socket declared it understands;
        // `has_more` tells the client to continue from `high_water`, which may skip events it is not sent.
        // The byte bound counts each whole frame as sent.
        const frames = new Map<number, string>();
        const page = this.eventsPage(
          f.after,
          knownFeatures(att.features),
          SYNC_MAX_EVENTS,
          SYNC_MAX_BYTES,
          (ev) => {
            const text = JSON.stringify({ t: 'event', event: ev } satisfies ServerFrame);
            frames.set(ev.seq, text);
            return text.length;
          },
        );
        for (const ev of page.events) {
          try {
            ws.send(frames.get(ev.seq)!);
          } catch {
            return;
          }
        }
        return this.sendFrame(ws, {
          t: 'caught_up',
          high_water: page.next_after,
          has_more: page.has_more,
        });
      }
      case 'ack': {
        if (device.role !== 'owner-desktop' && device.role !== 'desktop-host') return;
        await this.tx(() => applyAck(this, device.device_id, f.seq));
        return;
      }
      case 'req': {
        if (
          /\/attachments\/[^/]+\/content$/.test(f.path) ||
          f.path.startsWith('/api/v1/voice/ws')
        ) {
          return this.sendFrame(ws, {
            t: 'res',
            id: f.id,
            status: 404,
            body: '{"code":"not_found","message":"not tunnelled"}',
          });
        }
        const res = await this.handle({
          method: f.method,
          path: f.path,
          query: f.query,
          authorization: f.authorization,
          body: f.body ?? '',
          ip: `ws:${device.device_id}`,
          requestId: f.id,
        });
        return this.sendFrame(ws, { t: 'res', id: f.id, status: res.status, body: res.body });
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      /* ignore */
    }
  }

  private sendFrame(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* ignore */
    }
  }

  /** The ledger after `after`, up to `highWater`, in seq order, read in batches as far as the caller iterates. */
  private *ledgerFrom(after: number, highWater: number): Generator<LedgerEvent> {
    let cursor = after;
    while (cursor < highWater) {
      const rows = this.eventRows(cursor, LIMITS.eventPageSize);
      if (rows.length === 0) return;
      for (const ev of rows) {
        if (ev.seq > highWater) return;
        yield ev;
      }
      cursor = rows[rows.length - 1]!.seq;
    }
  }

  eventsPage(
    after: number,
    features: ReadonlySet<ProtocolFeature>,
    limit: number,
    maxBytes: number,
    size?: (ev: LedgerEvent) => number,
  ): EventsPage {
    const highWater = this.highWater();
    return buildEventsPage({
      after,
      highWater,
      events: this.ledgerFrom(after, highWater),
      features,
      limit,
      maxBytes,
      ...(size ? { size } : {}),
    });
  }

  eventRows(after: number, limit: number): LedgerEvent[] {
    return this.q<{
      seq: number;
      event_id: string;
      event_type: LedgerEvent['event_type'];
      question_id: string | null;
      question_revision: number | null;
      origin_device_id: string | null;
      data: string;
      created_at: number;
    }>(`SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`, after, limit).map((r) => ({
      protocol_version: PROTOCOL_VERSION,
      seq: r.seq,
      event_id: r.event_id,
      event_type: r.event_type,
      occurred_at: iso(r.created_at),
      question_id: r.question_id,
      question_revision: r.question_revision,
      origin_device_id: r.origin_device_id,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }

  /* ---------------- alarm-driven jobs (one alarm, many jobs) ---------------- */

  schedule(job: JobInput): void {
    this.run(
      `INSERT INTO scheduled_jobs (job_id, kind, question_id, attachment_id, payload, run_at) VALUES (?, ?, ?, ?, ?, ?)`,
      newId(),
      job.kind,
      job.questionId ?? null,
      job.attachmentId ?? null,
      JSON.stringify(job.payload ?? {}),
      Math.floor(job.runAt),
    );
    this.alarmDirty = true;
  }

  markAlarmDirty(): void {
    this.alarmDirty = true;
  }

  cancelJobs(where: { questionId: string; kinds?: string[] }): void {
    if (where.kinds && where.kinds.length > 0) {
      const marks = where.kinds.map(() => '?').join(',');
      this.run(
        `UPDATE scheduled_jobs SET status = 'cancelled' WHERE question_id = ? AND status = 'pending' AND kind IN (${marks})`,
        where.questionId,
        ...where.kinds,
      );
    } else {
      this.run(
        `UPDATE scheduled_jobs SET status = 'cancelled' WHERE question_id = ? AND status = 'pending'`,
        where.questionId,
      );
    }
  }

  async alarmAt(): Promise<number | null> {
    return await this.ctx.storage.getAlarm();
  }

  /** One alarm serves every pending job and every snapshot retention deadline. */
  private async refreshAlarm(): Promise<void> {
    const job = this.q1<{ m: number | null }>(
      `SELECT MIN(run_at) AS m FROM scheduled_jobs WHERE status = 'pending'`,
    )?.m;
    const snapshot = nextSnapshotRetention(this);
    const next = job == null ? snapshot : snapshot == null ? job : Math.min(job, snapshot);
    const current = await this.ctx.storage.getAlarm();
    if (next == null) {
      if (current != null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current !== next) await this.ctx.storage.setAlarm(Math.max(next, nowMs()));
  }

  override async alarm(): Promise<void> {
    await sweepSnapshotRetention(this);
    await processDueJobs(this);
    await this.refreshAlarm();
  }

  /** Test/diagnostic hook: workerVersion without leaking anything sensitive. */
  workerVersion(): string {
    return WORKER_VERSION;
  }

  /** Used by the dev health route. */
  eventHighWater(): number {
    return this.highWater();
  }
}

export { json };
