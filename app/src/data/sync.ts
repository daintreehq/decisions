import {
  EventsPage,
  ServerFrame,
  SocketTicketResponse,
  formatFeatures,
  type ClientFrame,
  type LedgerEvent,
  type ProtocolFeature,
} from '@daintreehq/decisions-protocol';
import type { Db } from './db.js';
import { RelayError } from './relay.js';

export type Connection = 'idle' | 'connecting' | 'live' | 'polling' | 'offline';

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SyncJson {
  json<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, string | number | undefined>; body?: unknown },
  ): Promise<T>;
}

export interface SyncDeps {
  relay: SyncJson;
  db: Pick<Db, 'putEvents' | 'getCursor' | 'setCursor'>;
  ingest: (events: LedgerEvent[]) => Promise<void>;
  origin: string;
  wsFactory?: (url: string) => WebSocketLike;
  onConnection?: (c: Connection) => void;
  onSynced?: (at: number) => void;
  onRevoked?: () => void;
  onError?: (e: unknown) => void;
  /**
   * The extensions this app declares (docs/protocol.md section 19), read at each socket ticket and events page.
   * Only features the relay advertises in `GET /info` belong here; an empty list is the 0.3.0 baseline.
   */
  features?: () => readonly ProtocolFeature[];
  /** The relay's clock, from each socket `hello`. */
  onServerTime?: (iso: string) => void;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Heartbeat interval; the runtime answers `ping` with `pong` without waking the Durable Object. */
  pingMs?: number;
  pollMs?: number;
}

const OPEN = 1;

/**
 * Keeps the local ledger cache in step with the relay.
 *
 * - Primary path: one hibernatable WebSocket. The server pushes events as they commit.
 * - Truth path: HTTP `GET /events` paging. It handles gaps (the relay may delete a question's events, so
 *   sequence numbers are not contiguous) and works when the socket cannot.
 * - The cursor only advances after events are durably cached AND ingested.
 */
export class SyncEngine {
  conn: Connection = 'idle';
  cursor = 0;
  private ws: WebSocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private pollTimer: unknown = null;
  private replaying = false;
  private queue: Promise<void> = Promise.resolve();
  private catchingUp: Promise<void> | null = null;
  /**
   * Which connection attempt is current. A newer attempt (a redeclaration, a kick while connecting) supersedes the
   * older one: its ticket is dropped and its socket can never schedule a reconnect, so one device never holds two
   * sockets that keep replacing each other.
   */
  private generation = 0;

  constructor(private readonly d: SyncDeps) {}

  /** Started and not stopped (or revoked). */
  get running(): boolean {
    return !this.stopped;
  }

  private timer(fn: () => void, ms: number) {
    return (this.d.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }
  private untimer(t: unknown) {
    (this.d.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t);
  }
  private set(c: Connection) {
    if (this.conn !== c) {
      this.conn = c;
      this.d.onConnection?.(c);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.cursor = await this.d.db.getCursor();
    await this.safeCatchUp();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.untimer(this.reconnectTimer);
    this.untimer(this.pingTimer);
    this.untimer(this.pollTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000, 'stop');
      } catch {
        /* already closed */
      }
    }
    this.set('idle');
  }

  /** The declared features changed: the socket's ticket carries them, so open a new socket. */
  redeclare(): void {
    if (this.stopped) return;
    const ws = this.ws;
    this.ws = null;
    this.untimer(this.pingTimer);
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000, 'redeclare');
      } catch {
        /* already closed */
      }
    }
    this.untimer(this.reconnectTimer);
    this.attempt = 0;
    this.connect();
  }

  private declared(): ProtocolFeature[] {
    return [...(this.d.features?.() ?? [])];
  }

  /** Called on visibilitychange→visible and `online`: reconnect if needed and always re-sync. */
  kick(): void {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState !== OPEN) {
      this.untimer(this.reconnectTimer);
      this.attempt = 0;
      this.connect();
    } else {
      this.send({ t: 'sync', after: this.cursor });
      this.replaying = true;
    }
    void this.safeCatchUp();
  }

  private send(f: ClientFrame) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(f));
  }

  private connect(): void {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.set(this.conn === 'live' ? 'live' : 'connecting');
    void (async () => {
      try {
        const t = SocketTicketResponse.parse(
          await this.d.relay.json('POST', '/socket-ticket', {
            // A body without `features` is the 0.3.0 baseline, exactly what this app sent before.
            body: this.declared().length ? { features: this.declared() } : {},
          }),
        );
        if (this.stopped || gen !== this.generation) return;
        const base = this.d.origin.replace(/^http/, 'ws');
        const path = t.ws_path.includes('ticket=')
          ? t.ws_path
          : `${t.ws_path}${t.ws_path.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(t.ticket)}`;
        const url = base + path;
        const ws = this.d.wsFactory
          ? this.d.wsFactory(url)
          : (new WebSocket(url) as unknown as WebSocketLike);
        this.ws = ws;
        ws.onopen = () => {
          this.attempt = 0;
          this.replaying = true;
          this.send({ t: 'sync', after: this.cursor });
          this.startPing();
        };
        ws.onmessage = (ev) => this.onMessage(ev.data);
        ws.onerror = () => undefined;
        ws.onclose = (ev) => {
          // A superseded socket closing (the relay replaced it, or a redeclaration closed it) changes nothing.
          if (this.ws !== ws) return;
          this.ws = null;
          this.untimer(this.pingTimer);
          if (ev.code === 4401) {
            this.stopped = true;
            this.set('offline');
            this.d.onRevoked?.();
            return;
          }
          this.scheduleReconnect();
        };
      } catch (e) {
        if (gen !== this.generation) return;
        if (e instanceof RelayError && (e.status === 401 || e.status === 403)) {
          this.d.onError?.(e);
          this.stopped = true;
          this.set('offline');
          this.d.onRevoked?.();
          return;
        }
        this.scheduleReconnect();
      }
    })();
  }

  private startPing() {
    this.untimer(this.pingTimer);
    const tick = () => {
      if (this.ws?.readyState === OPEN) this.ws.send('ping');
      this.pingTimer = this.timer(tick, this.d.pingMs ?? 4 * 60_000);
    };
    this.pingTimer = this.timer(tick, this.d.pingMs ?? 4 * 60_000);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.attempt++;
    // After a few failures fall back to HTTP polling while we keep trying to reconnect.
    this.set(this.attempt >= 3 ? 'polling' : 'offline');
    if (this.attempt >= 3) this.startPolling();
    const cap = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    const delay = Math.floor((this.d.random ?? Math.random)() * cap); // full jitter
    this.untimer(this.reconnectTimer);
    this.reconnectTimer = this.timer(() => this.connect(), delay);
  }

  private startPolling() {
    if (this.pollTimer) return;
    const tick = () => {
      if (this.stopped) return;
      void this.safeCatchUp();
      this.pollTimer = this.timer(tick, this.d.pollMs ?? 30_000);
    };
    this.pollTimer = this.timer(tick, this.d.pollMs ?? 30_000);
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string' || data === 'pong') return;
    let frame;
    try {
      frame = ServerFrame.safeParse(JSON.parse(data));
    } catch {
      return;
    }
    if (!frame.success) return;
    const f = frame.data;
    switch (f.t) {
      case 'hello':
        this.d.onServerTime?.(f.server_time);
        this.set('live');
        this.untimer(this.pollTimer);
        this.pollTimer = null;
        break;
      case 'event':
        this.enqueue(() => this.acceptPushed(f.event));
        break;
      case 'caught_up':
        this.enqueue(async () => {
          if (f.has_more) {
            // The relay cut the replay short (budget); ask for the rest from where we are now.
            this.send({ t: 'sync', after: this.cursor });
            return;
          }
          this.replaying = false;
          this.d.onSynced?.(Date.now());
        });
        break;
      case 'revoked':
        this.stopped = true;
        this.d.onRevoked?.();
        break;
      default:
        break;
    }
  }

  private enqueue(fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((e) => this.d.onError?.(e));
  }

  private async acceptPushed(ev: LedgerEvent): Promise<void> {
    if (ev.seq <= this.cursor) return;
    // During a replay the relay streams in order and sequence numbers may have holes (deleted questions).
    // For live pushes anything but the very next number could mean a missed event: ask HTTP for the truth.
    if (!this.replaying && ev.seq !== this.cursor + 1) {
      await this.catchUpNow();
      return;
    }
    await this.commit([ev], ev.seq);
  }

  private async commit(events: LedgerEvent[], newCursor: number): Promise<void> {
    await this.d.db.putEvents(events); // durable first
    await this.d.ingest(events);
    this.cursor = Math.max(this.cursor, newCursor);
    await this.d.db.setCursor(this.cursor);
  }

  /** Catch up and surface failures to the UI instead of failing silently. */
  private async safeCatchUp(): Promise<void> {
    try {
      await this.catchUp();
    } catch (e) {
      this.d.onError?.(e);
    }
  }

  catchUp(): Promise<void> {
    if (!this.catchingUp) {
      this.catchingUp = this.catchUpNow().finally(() => {
        this.catchingUp = null;
      });
    }
    return this.catchingUp;
  }

  private async catchUpNow(): Promise<void> {
    for (;;) {
      const page = EventsPage.parse(
        await this.d.relay.json('GET', '/events', {
          query: {
            after: this.cursor,
            limit: 100,
            features: this.declared().length ? formatFeatures(this.declared()) : undefined,
          },
        }),
      );
      const fresh = page.events.filter((e) => e.seq > this.cursor).sort((a, b) => a.seq - b.seq);
      if (fresh.length || page.next_after > this.cursor) {
        // Only a complete page may move the cursor to next_after; a partial one stops at what we hold.
        await this.commit(
          fresh,
          page.has_more
            ? (fresh.at(-1)?.seq ?? this.cursor)
            : Math.max(page.next_after, fresh.at(-1)?.seq ?? 0),
        );
      }
      if (!page.has_more) break;
      if (!fresh.length) break; // defensive: never spin
    }
    this.d.onSynced?.(Date.now());
  }
}
