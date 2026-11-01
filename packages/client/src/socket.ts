import {
  ServerFrame,
  PROTOCOL_VERSION,
  WS_CLOSE,
  type ClientFrame,
  type LedgerEvent,
} from '@daintree/decisions-protocol';
import { RelayError } from './errors.js';
import { backoffMs, type RelayClient } from './relay.js';

/** The subset of the WHATWG WebSocket that the socket needs; `ws` and Electron's WebSocket both fit. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export type SocketState = 'idle' | 'connecting' | 'syncing' | 'live' | 'backoff' | 'stopped';

export interface SocketHandlers {
  /** Called for every ledger event, in seq order. Must persist before resolving; the socket never acks itself. */
  onEvent(ev: LedgerEvent): Promise<void> | void;
  onCaughtUp?(highWater: number): Promise<void> | void;
  onState?(state: SocketState, detail?: string): void;
  onPairing?(pairingId: string): void;
  /** This device was revoked (4401). The socket stops and never reconnects. */
  onRevoked?(): void;
  /** Another socket for the same device replaced this one (4409). The socket stops. */
  onReplaced?(): void;
  onError?(err: Error): void;
}

export interface RelaySocketOptions {
  client: RelayClient;
  handlers: SocketHandlers;
  /** Highest contiguous seq durably stored; used for `sync` after every (re)connect. */
  getCursor: () => Promise<number>;
  webSocket?: WebSocketFactory;
  keepAliveMs?: number;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  requestTimeoutMs?: number;
  rand?: () => number;
  schedule?: (ms: number, fn: () => void) => () => void;
}

const OPEN = 1;

function defaultSchedule(ms: number, fn: () => void): () => void {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
}

export class RelaySocket {
  private ws: WebSocketLike | null = null;
  private state: SocketState = 'idle';
  private stopped = true;
  private attempt = 0;
  private cancelTimer: (() => void) | null = null;
  private cancelKeepAlive: (() => void) | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; cancel: () => void }
  >();
  private reqCounter = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly o: Required<
    Omit<RelaySocketOptions, 'client' | 'handlers' | 'getCursor' | 'webSocket'>
  > &
    Pick<RelaySocketOptions, 'client' | 'handlers' | 'getCursor' | 'webSocket'>;

  constructor(opts: RelaySocketOptions) {
    this.o = {
      keepAliveMs: 4 * 60 * 1000,
      reconnectBaseMs: 1000,
      reconnectCapMs: 5 * 60 * 1000,
      requestTimeoutMs: 30_000,
      rand: Math.random,
      schedule: defaultSchedule,
      ...opts,
    };
  }

  get currentState(): SocketState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelKeepAlive?.();
    this.cancelTimer = this.cancelKeepAlive = null;
    this.setState('stopped');
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000, 'client stop');
      } catch {
        /* already closed */
      }
    }
    this.rejectPending(new Error('socket stopped'));
  }

  private setState(s: SocketState, detail?: string): void {
    this.state = s;
    this.o.handlers.onState?.(s, detail);
  }

  private wsUrl(path: string, ticket: string): string {
    const origin = this.o.client.origin.replace(/^http/, 'ws');
    let p = path.startsWith('/') ? path : `/${path}`;
    if (!/[?&]ticket=/.test(p))
      p += `${p.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`;
    return origin + p;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState('connecting');
    try {
      const t = await this.o.client.socketTicket();
      if (this.stopped) return;
      const factory =
        this.o.webSocket ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
      const ws = factory(this.wsUrl(t.ws_path, t.ticket));
      this.ws = ws;
      ws.onmessage = (ev) => this.onMessage(ws, ev.data);
      ws.onclose = (ev) => this.onClose(ws, ev.code);
      ws.onerror = () => {
        /* followed by close; reconnect is handled there */
      };
    } catch (e) {
      const err = e as Error;
      if (
        err instanceof RelayError &&
        (err.code === 'forbidden' || err.code === 'not_authenticated') &&
        err.status === 403
      ) {
        this.handleRevoked();
        return;
      }
      this.o.handlers.onError?.(err);
      this.scheduleReconnect();
    }
  }

  private handleRevoked(): void {
    this.stop();
    this.o.handlers.onRevoked?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setState('backoff');
    const delay = Math.max(
      this.o.reconnectBaseMs,
      backoffMs(this.attempt++, this.o.reconnectBaseMs, this.o.reconnectCapMs, this.o.rand),
    );
    this.cancelTimer = this.o.schedule(delay, () => void this.connect());
  }

  private onClose(ws: WebSocketLike, code: number): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.cancelKeepAlive?.();
    this.cancelKeepAlive = null;
    this.rejectPending(new RelayError('network_error', 'socket closed', 0));
    if (this.stopped) return;
    if (code === WS_CLOSE.revoked) return this.handleRevoked();
    if (code === WS_CLOSE.replaced) {
      this.stop();
      this.o.handlers.onReplaced?.();
      return;
    }
    this.scheduleReconnect();
  }

  private send(frame: ClientFrame): void {
    if (!this.ws || this.ws.readyState !== OPEN)
      throw new RelayError('network_error', 'socket not open', 0);
    this.ws.send(JSON.stringify(frame));
  }

  private onMessage(ws: WebSocketLike, data: unknown): void {
    if (ws !== this.ws) return;
    if (typeof data !== 'string') return;
    if (data === 'pong') return;
    let frame: ServerFrame;
    try {
      const parsed = ServerFrame.safeParse(JSON.parse(data));
      if (!parsed.success) throw new Error('unrecognised frame');
      frame = parsed.data;
    } catch (e) {
      this.o.handlers.onError?.(e as Error);
      return;
    }
    // Events are handled strictly in order, one at a time; the handler persists before we continue.
    this.chain = this.chain
      .then(() => this.handleFrame(ws, frame))
      .catch((e) => this.o.handlers.onError?.(e as Error));
  }

  private async handleFrame(ws: WebSocketLike, f: ServerFrame): Promise<void> {
    if (ws !== this.ws) return;
    switch (f.t) {
      case 'hello': {
        if (f.protocol_version !== PROTOCOL_VERSION) {
          this.o.handlers.onError?.(
            new RelayError('upgrade_required', 'relay speaks another protocol version', 426),
          );
          this.stop();
          return;
        }
        this.attempt = 0;
        this.setState('syncing');
        this.scheduleKeepAlive();
        this.send({ t: 'sync', after: await this.o.getCursor() });
        return;
      }
      case 'event':
        await this.o.handlers.onEvent(f.event);
        return;
      case 'caught_up':
        if (f.has_more) {
          // Replay was cut short by the relay's budget: continue from the stored cursor.
          this.send({ t: 'sync', after: await this.o.getCursor() });
          return;
        }
        this.setState('live');
        await this.o.handlers.onCaughtUp?.(f.high_water);
        return;
      case 'pairing':
        this.o.handlers.onPairing?.(f.pairing_id);
        return;
      case 'res': {
        const p = this.pending.get(f.id);
        if (!p) return;
        this.pending.delete(f.id);
        p.cancel();
        if (f.status >= 400) p.reject(RelayError.fromBody(f.status, f.body));
        else p.resolve(f.body ? JSON.parse(f.body) : {});
        return;
      }
      case 'revoked':
        this.handleRevoked();
        return;
      case 'error':
        this.o.handlers.onError?.(new RelayError('unknown_error', `${f.code}: ${f.message}`, 0));
        return;
    }
  }

  private scheduleKeepAlive(): void {
    this.cancelKeepAlive?.();
    this.cancelKeepAlive = this.o.schedule(this.o.keepAliveMs, () => {
      this.sendPing();
      this.scheduleKeepAlive();
    });
  }

  /** Text `ping` is auto-answered by the runtime without waking the Durable Object. */
  sendPing(): void {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send('ping');
  }

  /** Durable receipt of everything up to `seq` (not terminal delivery). */
  ack(seq: number): void {
    this.send({ t: 'ack', seq });
  }

  /** Tunnel a signed REST request over the socket. */
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const id = `r${++this.reqCounter}`;
    const query = opts.query ?? '';
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const authorization = await this.o.client.signForSocket(method, path, query, body);
    return new Promise((resolve, reject) => {
      const cancel = this.o.schedule(this.o.requestTimeoutMs, () => {
        this.pending.delete(id);
        reject(new RelayError('network_error', 'socket request timed out', 0));
      });
      this.pending.set(id, { resolve, reject, cancel });
      try {
        this.send({
          t: 'req',
          id,
          method,
          path,
          query,
          ...(body !== undefined ? { body } : {}),
          authorization,
        });
      } catch (e) {
        this.pending.delete(id);
        cancel();
        reject(e as Error);
      }
    });
  }

  private rejectPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.cancel();
      p.reject(err);
    }
    this.pending.clear();
  }
}
