import { describe, expect, it, vi } from 'vitest';
import type { LedgerEvent } from '@daintreehq/decisions-protocol';
import { Db } from '../src/data/db.js';
import { RelayError } from '../src/data/relay.js';
import {
  SyncEngine,
  type Connection,
  type SyncJson,
  type WebSocketLike,
} from '../src/data/sync.js';

class FakeWS implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  frames() {
    return this.sent
      .filter((s) => s !== 'ping')
      .map((s) => JSON.parse(s) as { t: string; after?: number });
  }
}

const ev = (seq: number): LedgerEvent => ({
  protocol_version: 1,
  seq,
  event_id: `event_${String(seq).padStart(8, '0')}`,
  event_type: 'decision.expired',
  occurred_at: '2026-11-01T09:00:00.000Z',
  question_id: null,
  question_revision: null,
  origin_device_id: null,
  data: {},
});

let n = 0;
async function harness(opts: { ledger?: number[]; pageSize?: number; ingestFails?: number } = {}) {
  const db = await Db.open(`sync-${++n}-${Math.random().toString(36).slice(2)}`);
  const ledger = { seqs: opts.ledger ?? [] };
  const ingested: number[] = [];
  let failures = opts.ingestFails ?? 0;
  const sockets: FakeWS[] = [];
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  const conns: Connection[] = [];
  const errors: unknown[] = [];
  const state = { revoked: 0, ticket401: false, pageFail: false };
  const calls: string[] = [];
  /** Every cursor the engine saved, with what the cache held at that moment. */
  const cursorWrites: { cursor: number; cached: number[] }[] = [];

  const relay: SyncJson = {
    json: (async (method: string, path: string, o?: { query?: Record<string, number> }) => {
      calls.push(`${method} ${path}${o?.query ? `?after=${o.query.after}` : ''}`);
      if (path === '/socket-ticket') {
        if (state.ticket401) throw new RelayError('not_authenticated', 401, 'revoked');
        return {
          ticket: 'TICKET1',
          expires_at: new Date(Date.now() + 30_000).toISOString(),
          ws_path: '/api/v1/socket',
        };
      }
      if (path === '/events') {
        const after = o!.query!.after!;
        const limit = o!.query!.limit!;
        const size = Math.min(limit, opts.pageSize ?? 100);
        const rest = ledger.seqs.filter((s) => s > after);
        if (state.pageFail && after > 0) throw new RelayError('network', 0, 'down');
        const page = rest.slice(0, size);
        const hw = ledger.seqs.at(-1) ?? 0;
        return {
          protocol_version: 1,
          from_exclusive: after,
          high_water_seq: hw,
          events: page.map(ev),
          next_after: page.length ? page.at(-1)! : after,
          has_more: rest.length > page.length,
        };
      }
      throw new Error('unexpected ' + path);
    }) as SyncJson['json'],
  };

  const engine = new SyncEngine({
    relay,
    db: {
      putEvents: (events) => db.putEvents(events),
      getCursor: () => db.getCursor(),
      setCursor: async (seq) => {
        cursorWrites.push({ cursor: seq, cached: (await db.eventsAfter(0)).map((e) => e.seq) });
        return db.setCursor(seq);
      },
    },
    origin: 'https://relay.example',
    ingest: async (events) => {
      if (failures > 0) {
        failures--;
        throw new Error('ingest failed');
      }
      ingested.push(...events.map((e) => e.seq));
    },
    wsFactory: (url) => {
      const s = new FakeWS(url);
      sockets.push(s);
      return s;
    },
    onConnection: (c) => conns.push(c),
    onRevoked: () => state.revoked++,
    onError: (e) => errors.push(e),
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const t = timers[id as number];
      if (t) t.live = false;
    },
    pingMs: 1000,
    pollMs: 5000,
  });
  const lastSocket = () => sockets.at(-1)!;
  /** Events the relay holds that a saved cursor had already passed without them being cached: always none. */
  const hidden = () =>
    cursorWrites.flatMap((w) =>
      ledger.seqs.filter((seq) => seq <= w.cursor && !w.cached.includes(seq)),
    );
  const connected = async () => {
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    return lastSocket();
  };
  return {
    db,
    engine,
    ledger,
    ingested,
    sockets,
    timers,
    conns,
    errors,
    state,
    calls,
    lastSocket,
    connected,
    hidden,
    /** Make the next `n` ingests fail. */
    failIngest: (count: number) => {
      failures = count;
    },
  };
}

describe('sync engine', () => {
  it('catches up over HTTP page by page, persisting before moving the cursor', async () => {
    const h = await harness({ ledger: [1, 2, 3, 4, 5], pageSize: 2 });
    await h.engine.start();
    expect(h.ingested).toEqual([1, 2, 3, 4, 5]);
    expect(h.engine.cursor).toBe(5);
    expect(await h.db.getCursor()).toBe(5);
    expect((await h.db.eventsAfter(0)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(h.calls.filter((c) => c.startsWith('GET /events'))).toEqual([
      'GET /events?after=0',
      'GET /events?after=2',
      'GET /events?after=4',
    ]);
  });

  it('resumes from the stored cursor after a restart', async () => {
    const h = await harness({ ledger: [1, 2, 3] });
    await h.db.setCursor(2);
    await h.engine.start();
    expect(h.ingested).toEqual([3]);
  });

  it('opens the socket with a ticket, asks for a replay and goes live on hello', async () => {
    const h = await harness({ ledger: [1] });
    await h.engine.start();
    const ws = await h.connected();
    expect(ws.url).toBe('wss://relay.example/api/v1/socket?ticket=TICKET1');
    ws.open();
    expect(ws.frames()).toEqual([{ t: 'sync', after: 1 }]);
    ws.push({
      t: 'hello',
      protocol_version: 1,
      device_id: 'device_aaaaaaaa',
      role: 'phone',
      key_epoch: 1,
      high_water: 1,
      server_time: new Date().toISOString(),
    });
    expect(h.engine.conn).toBe('live');
  });

  it('applies the next live event directly but asks HTTP when a number is skipped', async () => {
    const h = await harness({ ledger: [1, 2, 3, 4, 5, 6, 7] });
    await h.engine.start(); // cursor 7 from catch-up
    h.ledger.seqs.push(8, 9, 10);
    const ws = await h.connected();
    ws.open();
    ws.push({ t: 'caught_up', high_water: 7 });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(7));
    ws.push({ t: 'event', event: ev(8) });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(8));
    const callsBefore = h.calls.filter((c) => c.startsWith('GET /events')).length;
    expect(h.ingested.at(-1)).toBe(8);

    // seq 10 arrives but 9 never did: do not trust it, fetch the truth.
    ws.push({ t: 'event', event: ev(10) });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(10));
    expect(h.ingested.slice(-2)).toEqual([9, 10]);
    expect(h.calls.filter((c) => c.startsWith('GET /events')).length).toBe(callsBefore + 1);
  });

  it('accepts holes in a server replay (deleted questions leave gaps) and in order', async () => {
    const h = await harness();
    await h.engine.start();
    const ws = await h.connected();
    ws.open();
    ws.push({ t: 'event', event: ev(3) });
    ws.push({ t: 'event', event: ev(7) });
    ws.push({ t: 'event', event: ev(7) }); // duplicate is ignored
    ws.push({ t: 'caught_up', high_water: 7 });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(7));
    expect(h.ingested).toEqual([3, 7]);
    expect(h.calls.filter((c) => c.startsWith('GET /events')).length).toBe(1); // only the initial catch-up
  });

  it('keeps every event when a live push arrives ahead of the replay of earlier ones', async () => {
    const h = await harness({ ledger: [1] });
    await h.engine.start(); // cursor 1 from catch-up
    h.ledger.seqs.push(2, 3, 4, 5);
    const ws = await h.connected();
    ws.open();
    expect(ws.frames()).toEqual([{ t: 'sync', after: 1 }]);
    // The relay pushes 5 the moment it commits, before it has handled this socket's `sync`...
    ws.push({ t: 'event', event: ev(5) });
    // ...and then replays everything after 1.
    for (const seq of [2, 3, 4, 5]) ws.push({ t: 'event', event: ev(seq) });
    ws.push({ t: 'caught_up', high_water: 5, has_more: false });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(5));
    expect(h.ingested).toEqual([1, 2, 3, 4, 5]); // once each, in ledger order
    expect((await h.db.eventsAfter(0)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(await h.db.getCursor()).toBe(5);
    expect(h.hidden()).toEqual([]);
  });

  it('keeps every event pushed ahead of a replay the relay cut short', async () => {
    const h = await harness({ ledger: [1] });
    await h.engine.start();
    h.ledger.seqs.push(2, 3, 4, 5, 6, 7);
    const ws = await h.connected();
    ws.open();
    ws.push({ t: 'event', event: ev(6) }); // live, ahead of the first page
    for (const seq of [2, 3]) ws.push({ t: 'event', event: ev(seq) });
    ws.push({ t: 'caught_up', high_water: 3, has_more: true });
    await vi.waitFor(() => expect(ws.frames()).toHaveLength(2));
    expect(ws.frames()[1]).toEqual({ t: 'sync', after: 3 }); // the next page starts at the marker
    expect(h.engine.cursor).toBe(3);
    ws.push({ t: 'event', event: ev(7) }); // live, between the pages
    for (const seq of [4, 5, 6, 7]) ws.push({ t: 'event', event: ev(seq) });
    ws.push({ t: 'caught_up', high_water: 7, has_more: false });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(7));
    expect(h.ingested).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await h.db.getCursor()).toBe(7);
    expect(h.hidden()).toEqual([]);
  });

  it('never lets a replay marker pass events that failed to ingest', async () => {
    const h = await harness({ ledger: [1] });
    await h.engine.start();
    h.ledger.seqs.push(2, 3);
    const ws = await h.connected();
    ws.open();
    h.failIngest(1);
    for (const seq of [2, 3]) ws.push({ t: 'event', event: ev(seq) });
    ws.push({ t: 'caught_up', high_water: 3, has_more: false });
    await vi.waitFor(() => expect(h.errors).toHaveLength(1));
    expect(h.engine.cursor).toBe(1);
    expect(await h.db.getCursor()).toBe(1);
    // The replay is over; the next catch-up reads the truth again...
    await h.engine.catchUp();
    expect(h.engine.cursor).toBe(3);
    expect(h.ingested).toEqual([1, 2, 3]);
    // ...and the next live event applies directly, with no marker and no HTTP request.
    const requests = h.calls.length;
    h.ledger.seqs.push(4);
    ws.push({ t: 'event', event: ev(4) });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(4));
    expect(h.calls).toHaveLength(requests);
    expect(h.ingested).toEqual([1, 2, 3, 4]);
    expect(h.hidden()).toEqual([]);
  });

  it('moves the cursor to the marker, past events this phone is not sent', async () => {
    const h = await harness({ ledger: [1] });
    await h.engine.start();
    h.ledger.seqs.push(3); // the rest (2, 4-8) were deleted or are hidden from this phone
    const ws = await h.connected();
    ws.open();
    ws.push({ t: 'event', event: ev(3) });
    ws.push({ t: 'caught_up', high_water: 5, has_more: false });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(5));
    expect(await h.db.getCursor()).toBe(5);
    // A replay with nothing this phone may see still moves the cursor to its marker (the kick's HTTP catch-up finds
    // nothing new, so only the marker can).
    h.engine.kick();
    await vi.waitFor(() => expect(ws.frames().at(-1)).toEqual({ t: 'sync', after: 5 }));
    ws.push({ t: 'caught_up', high_water: 8, has_more: false });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(8));
    expect(await h.db.getCursor()).toBe(8);
    expect(h.ingested).toEqual([1, 3]);
    expect(h.hidden()).toEqual([]);
  });

  it('reads the ledger over HTTP when the relay refuses a sync', async () => {
    const h = await harness({ ledger: [1] });
    await h.engine.start();
    h.ledger.seqs.push(2, 3);
    const ws = await h.connected();
    ws.open();
    ws.push({ t: 'event', event: ev(3) }); // live, ahead of a replay that never comes
    ws.push({ t: 'error', code: 'rate_limited', message: 'too many sync requests' });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(3));
    expect(h.ingested).toEqual([1, 2, 3]);
    // The replay is over: the next live event applies directly.
    h.ledger.seqs.push(4);
    ws.push({ t: 'event', event: ev(4) });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(4));
    expect(h.calls.filter((c) => c.startsWith('GET /events'))).toEqual([
      'GET /events?after=0',
      'GET /events?after=1',
    ]);
    expect(h.hidden()).toEqual([]);
  });

  it('ignores what a replaced socket had queued', async () => {
    const h = await harness({ ledger: [1] });
    await h.engine.start();
    h.ledger.seqs.push(2, 3);
    const old = await h.connected();
    old.open();
    // The old socket's marker arrives, but the socket is replaced before it is handled.
    old.push({ t: 'event', event: ev(3) });
    old.push({ t: 'caught_up', high_water: 3, has_more: false });
    h.engine.redeclare();
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    const ws = h.lastSocket();
    ws.open();
    expect(h.engine.cursor).toBe(1);
    expect(ws.frames()).toEqual([{ t: 'sync', after: 1 }]);
    for (const seq of [2, 3]) ws.push({ t: 'event', event: ev(seq) });
    ws.push({ t: 'caught_up', high_water: 3, has_more: false });
    await vi.waitFor(() => expect(h.engine.cursor).toBe(3));
    expect(h.ingested).toEqual([1, 2, 3]);
    expect(h.hidden()).toEqual([]);
  });

  it('never moves the cursor past an event that failed to ingest', async () => {
    const h = await harness({ ledger: [1, 2], ingestFails: 1 });
    await h.engine.start().catch(() => undefined);
    expect(h.engine.cursor).toBe(0);
    expect(await h.db.getCursor()).toBe(0);
    await h.engine.catchUp();
    expect(h.engine.cursor).toBe(2);
    expect(h.ingested).toEqual([1, 2]);
  });

  it('a partial page stops the cursor at what it actually holds', async () => {
    const h = await harness({ ledger: [1, 2, 3, 4], pageSize: 2 });
    h.state.pageFail = true;
    await h.engine.start();
    expect(h.engine.cursor).toBe(2);
    expect(await h.db.getCursor()).toBe(2);
  });

  it('treats close code 4401 as revocation and does not reconnect', async () => {
    const h = await harness();
    await h.engine.start();
    const ws = await h.connected();
    ws.open();
    ws.drop(4401);
    expect(h.state.revoked).toBe(1);
    const sockets = h.sockets.length;
    for (const t of h.timers.filter((x) => x.live)) t.fn(); // even if every pending timer fires...
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sockets.length).toBe(sockets); // ...a revoked device never reconnects
    expect(h.engine.conn).toBe('offline');
    ws.push({ t: 'revoked' });
  });

  it('treats a 401 ticket as revocation', async () => {
    const h = await harness();
    h.state.ticket401 = true;
    await h.engine.start();
    await vi.waitFor(() => expect(h.state.revoked).toBe(1));
    expect(h.sockets).toHaveLength(0);
  });

  it('reconnects with full jitter and falls back to polling after repeated failures', async () => {
    const h = await harness();
    await h.engine.start();
    let ws = await h.connected();
    ws.open();
    for (let i = 0; i < 3; i++) {
      ws.drop();
      const t = h.timers.filter((x) => x.live).at(-1)!;
      expect(t.ms).toBe(Math.floor(0.5 * Math.min(30_000, 1000 * 2 ** Math.min(i + 1, 5))));
      const before = h.sockets.length;
      t.fn();
      await vi.waitFor(() => expect(h.sockets.length).toBe(before + 1));
      ws = h.lastSocket();
    }
    ws.drop();
    expect(h.engine.conn).toBe('polling');
    h.engine.stop();
    expect(h.engine.conn).toBe('idle');
  });

  it('sends a plain-text ping heartbeat (answered without waking the object)', async () => {
    const h = await harness();
    await h.engine.start();
    const ws = await h.connected();
    ws.open();
    const ping = h.timers.filter((t) => t.live && t.ms === 1000).at(-1)!;
    ping.fn();
    expect(ws.sent).toContain('ping');
    ws.push('pong'); // non-JSON text is ignored
    ws.onmessage?.({ data: 'pong' });
  });

  it('kick() re-syncs a live socket and reconnects a dead one', async () => {
    const h = await harness({ ledger: [1] });
    await h.engine.start();
    const ws = await h.connected();
    ws.open();
    h.engine.kick(); // the first replay is still under way: no second one
    expect(ws.frames().filter((f) => f.t === 'sync')).toHaveLength(1);
    ws.push({ t: 'caught_up', high_water: 1, has_more: false });
    await new Promise((r) => setTimeout(r, 0));
    h.engine.kick();
    expect(ws.frames().filter((f) => f.t === 'sync')).toHaveLength(2);
    ws.drop();
    const before = h.sockets.length;
    h.engine.kick();
    await vi.waitFor(() => expect(h.sockets.length).toBe(before + 1));
  });
});
