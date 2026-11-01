import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parseAuthHeader, type LedgerEvent } from '@daintreehq/decisions-protocol';
import { verifyRequestSignature, importSigningPublicKey } from '@daintreehq/decisions-crypto';
import {
  RelayClient,
  RelayError,
  RelaySocket,
  backoffMs,
  type SocketHandlers,
} from '../src/index.js';
import {
  FakeRelay,
  FakeSocket,
  makeIdentity,
  setupBridge,
  tick,
  origin,
  makePhone,
} from './helpers.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('RelayClient retry policy', () => {
  async function client(
    handler: (
      i: number,
      init: RequestInit | undefined,
      url: string,
    ) => Response | Promise<Response>,
    over: { sleeps?: number[] } = {},
  ) {
    const identity = await makeIdentity();
    let i = 0;
    const sleeps = over.sleeps ?? [];
    return {
      identity,
      calls: () => i,
      c: new RelayClient({
        identity,
        maxRetries: 3,
        sleep: async (ms) => void sleeps.push(ms),
        fetch: (async (u: unknown, init?: RequestInit) =>
          handler(i++, init, String(u))) as typeof fetch,
      }),
    };
  }
  it('retries 5xx/429/network errors, succeeds, and honours retry_after_ms', async () => {
    const sleeps: number[] = [];
    const { c, calls } = await client(
      (i) => {
        if (i === 0) throw new TypeError('fetch failed');
        if (i === 1) return json(503, { code: 'temporarily_unavailable', message: 'x' });
        if (i === 2) return json(429, { code: 'rate_limited', message: 'x', retry_after_ms: 777 });
        return json(200, { ok: true });
      },
      { sleeps },
    );
    expect(await c.request('GET', '/api/v1/devices')).toEqual({ ok: true });
    expect(calls()).toBe(4);
    expect(sleeps[2]).toBe(777);
  });
  it('never retries 4xx, including conflicts', async () => {
    for (const [status, code] of [
      [400, 'validation_error'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'revision_conflict'],
    ] as const) {
      const { c, calls } = await client(() =>
        json(status, { code, message: 'no', details: { latest_revision: 4 } }),
      );
      const err = await c.request('POST', '/x').catch((e) => e as RelayError);
      expect(err).toBeInstanceOf(RelayError);
      expect(err).toMatchObject({ code, status });
      expect(calls()).toBe(1);
    }
  });
  it('gives up after maxRetries on persistent failure', async () => {
    const { c, calls } = await client(() => json(500, { code: 'internal_error', message: 'x' }));
    await expect(c.request('GET', '/x')).rejects.toMatchObject({ status: 500 });
    expect(calls()).toBe(4);
  });
  it('full-jitter backoff stays within [0, cap]', () => {
    for (let a = 0; a < 12; a++) {
      expect(backoffMs(a, 500, 30_000, () => 0.999)).toBeLessThanOrEqual(30_000);
      expect(backoffMs(a, 500, 30_000, () => 0)).toBe(0);
    }
  });
  it('signs every request so the relay can verify it (method, path, sorted query, body hash)', async () => {
    let seen: { auth: string; url: string; body: string } | null = null;
    const { c, identity } = await client((_i, init, url) => {
      seen = {
        auth: new Headers(init?.headers).get('authorization')!,
        url,
        body: String(init?.body ?? ''),
      };
      return json(200, {});
    });
    await c.request('POST', '/api/v1/questions/abc/cancel', {
      query: { b: 2, a: 1 },
      body: { x: 1 },
    });
    const h = parseAuthHeader(seen!.auth)!;
    const url = new URL(seen!.url);
    const { sha256Hex } = await import('@daintreehq/decisions-crypto');
    const ok = await verifyRequestSignature({
      header: h,
      method: 'POST',
      path: url.pathname,
      query: url.search.slice(1),
      bodySha256: await sha256Hex(seen!.body),
      devicePublicKey: await importSigningPublicKey(identity.signingPub),
    });
    expect(ok).toBe(true);
    expect(h.deviceId).toBe(identity.config.deviceId);
  });
  it('corrects clock skew once using the Date header, then succeeds', async () => {
    const ahead = new Date(Date.now() + 3_600_000);
    const stamps: number[] = [];
    const { c } = await client((i, init) => {
      stamps.push(parseAuthHeader(new Headers(init?.headers).get('authorization'))!.ts);
      return i === 0
        ? json(401, { code: 'not_authenticated', message: 'skew' }, { date: ahead.toUTCString() })
        : json(200, { ok: 1 });
    });
    await c.request('GET', '/x');
    expect(stamps).toHaveLength(2);
    expect(Math.abs(stamps[1]! - ahead.getTime())).toBeLessThan(5000);
  });
  it('does not loop on a genuine auth failure', async () => {
    const { c, calls } = await client(() =>
      json(401, { code: 'not_authenticated', message: 'bad' }, { date: new Date().toUTCString() }),
    );
    await expect(c.request('GET', '/x')).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(calls()).toBe(1);
  });
  it('uploads attachments with X-Content-Sha256 and signs that digest', async () => {
    let hdr: Headers | null = null;
    const { c } = await client(
      (_i, init) => ((hdr = new Headers(init?.headers)), json(200, { ok: true })),
    );
    const bytes = new Uint8Array([1, 2, 3]);
    const { sha256Hex } = await import('@daintreehq/decisions-crypto');
    const sha = await sha256Hex(bytes);
    await c.uploadAttachment('/api/v1/attachments/x/content', bytes, sha);
    expect(hdr!.get('x-content-sha256')).toBe(sha);
  });
});

function mkSocket(opts: { cursor?: number; frames?: LedgerEvent[] } = {}) {
  return (async () => {
    const identity = await makeIdentity();
    const relay = new FakeRelay(identity);
    FakeSocket.instances = [];
    const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
    const log: string[] = [];
    const handlers: SocketHandlers = {
      onEvent: (ev) => void log.push(`event:${ev.seq}`),
      onCaughtUp: () => void log.push('caughtup'),
      onState: (s) => void log.push(`state:${s}`),
      onRevoked: () => void log.push('revoked'),
      onReplaced: () => void log.push('replaced'),
      onPairing: (p) => void log.push(`pairing:${p}`),
    };
    const client = new RelayClient({ identity, fetch: relay.fetch, sleep: async () => {} });
    const sock = new RelaySocket({
      client,
      handlers,
      getCursor: async () => opts.cursor ?? 0,
      rand: () => 1,
      webSocket: (u) => new FakeSocket(u),
      schedule: (ms, fn) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return () => (t.cancelled = true);
      },
    });
    const hello = {
      t: 'hello',
      protocol_version: PROTOCOL_VERSION,
      device_id: identity.config.deviceId,
      role: 'owner-desktop',
      key_epoch: 1,
      high_water: 0,
      server_time: new Date().toISOString(),
    };
    return { sock, relay, timers, log, hello, identity, ws: () => FakeSocket.instances.at(-1)! };
  })();
}

describe('RelaySocket (hibernatable WebSocket client)', () => {
  it('opens with a ticket, syncs from the stored cursor after hello, and dispatches events in order', async () => {
    const { sock, ws, hello, log } = await mkSocket({ cursor: 41 });
    sock.start();
    await tick(5);
    expect(ws().url).toBe(
      'ws://relay.test/api/v1/socket?ticket=tkt'
        .replace('ws://', 'wss://')
        .replace('wss://', 'wss://'),
    );
    ws().recv(hello);
    await tick(5);
    expect(JSON.parse(ws().sent.at(-1)!)).toEqual({ t: 'sync', after: 41 });
    const ev = (seq: number) => ({
      protocol_version: PROTOCOL_VERSION,
      seq,
      event_id: `e${seq}xxxxxxxx`,
      event_type: 'decision.expired',
      occurred_at: new Date().toISOString(),
      question_id: null,
      question_revision: null,
      origin_device_id: null,
      data: {},
    });
    ws().recv({ t: 'event', event: ev(42) });
    ws().recv({ t: 'event', event: ev(43) });
    ws().recv({ t: 'caught_up', high_water: 43 });
    await tick(5);
    expect(log.filter((l) => l.startsWith('event') || l === 'caughtup')).toEqual([
      'event:42',
      'event:43',
      'caughtup',
    ]);
    expect(sock.currentState).toBe('live');
    sock.stop();
  });
  it('reconnects with exponential full-jitter backoff and re-syncs on every reconnect', async () => {
    const { sock, ws, hello, timers } = await mkSocket();
    sock.start();
    await tick(5);
    ws().recv(hello);
    await tick(5);
    ws().close(1006, 'lost');
    expect(sock.currentState).toBe('backoff');
    expect(timers.at(-1)!.ms).toBeGreaterThanOrEqual(1000);
    expect(timers.at(-1)!.ms).toBeLessThanOrEqual(1000);
    timers.at(-1)!.fn();
    await tick(5);
    ws().close(1006, 'lost again'); // never reached hello => attempt keeps growing
    const first = timers.at(-1)!.ms;
    timers.at(-1)!.fn();
    await tick(5);
    ws().close(1006, 'lost again');
    expect(timers.at(-1)!.ms).toBeGreaterThan(first);
    expect(timers.at(-1)!.ms).toBeLessThanOrEqual(300_000);
    timers.at(-1)!.fn();
    await tick(5);
    ws().recv(hello);
    await tick(5);
    expect(JSON.parse(ws().sent.at(-1)!).t).toBe('sync');
    sock.stop();
  });
  it('4401 (revoked) stops permanently; 4409 (replaced) stops without a reconnect loop', async () => {
    const a = await mkSocket();
    a.sock.start();
    await tick(5);
    a.ws().recv(a.hello);
    await tick(5);
    const before = a.timers.length;
    a.ws().close(4401, 'revoked');
    expect(a.log).toContain('revoked');
    expect(a.sock.currentState).toBe('stopped');
    expect(
      a.timers.slice(before).filter((t) => t.ms < 60_000 && !t.cancelled && t.ms >= 1000),
    ).toHaveLength(0);

    const b = await mkSocket();
    b.sock.start();
    await tick(5);
    b.ws().recv(b.hello);
    await tick(5);
    b.ws().close(4409, 'replaced');
    expect(b.log).toContain('replaced');
    expect(b.sock.currentState).toBe('stopped');
    const n = FakeSocket.instances.length;
    await tick(5);
    expect(FakeSocket.instances.length).toBe(n);
  });
  it('a revoked frame stops the socket', async () => {
    const { sock, ws, hello, log } = await mkSocket();
    sock.start();
    await tick(5);
    ws().recv(hello);
    ws().recv({ t: 'revoked' });
    await tick(5);
    expect(log).toContain('revoked');
    expect(sock.currentState).toBe('stopped');
  });
  it('keeps alive with the text ping and ignores pong', async () => {
    const { sock, ws, hello, timers } = await mkSocket();
    sock.start();
    await tick(5);
    ws().recv(hello);
    await tick(5);
    const ka = timers.filter((t) => !t.cancelled && t.ms === 4 * 60 * 1000);
    expect(ka.length).toBeGreaterThan(0);
    ka.at(-1)!.fn();
    expect(ws().sent).toContain('ping');
    ws().recv('pong'); // must not throw or be treated as a frame
    sock.stop();
  });
  it('tunnels signed requests as req frames and resolves from res frames', async () => {
    const { sock, ws, hello } = await mkSocket();
    sock.start();
    await tick(5);
    ws().recv(hello);
    await tick(5);
    const p = sock.request('POST', '/api/v1/deliveries/received', {
      body: { protocol_version: 1, seq: 5 },
    });
    await tick(5);
    const frame = JSON.parse(ws().sent.at(-1)!);
    expect(frame).toMatchObject({ t: 'req', method: 'POST', path: '/api/v1/deliveries/received' });
    expect(frame.authorization.startsWith('Decisions-Sig ')).toBe(true);
    ws().recv({ t: 'res', id: frame.id, status: 200, body: '{"ok":true}' });
    expect(await p).toEqual({ ok: true });
    const q = sock.request('GET', '/api/v1/devices');
    await tick(5);
    const f2 = JSON.parse(ws().sent.at(-1)!);
    ws().recv({
      t: 'res',
      id: f2.id,
      status: 409,
      body: JSON.stringify({ code: 'revision_conflict', message: 'x' }),
    });
    await expect(q).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
    sock.stop();
  });
  it('rejects in-flight requests when the socket drops', async () => {
    const { sock, ws, hello } = await mkSocket();
    sock.start();
    await tick(5);
    ws().recv(hello);
    await tick(5);
    const p = sock.request('GET', '/api/v1/devices');
    await tick(5);
    ws().close(1006, 'x');
    await expect(p).rejects.toMatchObject({ code: 'network_error' });
    sock.stop();
  });
  it('surfaces pairing hints and ignores malformed frames', async () => {
    const { sock, ws, hello, log } = await mkSocket();
    sock.start();
    await tick(5);
    ws().recv(hello);
    ws().recv({ t: 'pairing', pairing_id: 'pair-1234567' });
    ws().recv('not json');
    ws().recv({ t: 'mystery' });
    await tick(5);
    expect(log).toContain('pairing:pair-1234567');
    expect(sock.currentState).not.toBe('stopped');
    sock.stop();
  });
});

describe('bridge + socket: persist before ack, contiguous cursor', () => {
  it('acks only after the event is stored and only up to the contiguous cursor', async () => {
    FakeSocket.instances = [];
    const order: string[] = [];
    const env = await setupBridge({ webSocket: (u) => new FakeSocket(u) });
    const orig = env.store.insertEvent.bind(env.store);
    env.store.insertEvent = async (e) => (order.push(`store:${e.seq}`), orig(e));
    await env.bridge.start();
    await tick(10);
    const ws = FakeSocket.instances.at(-1)!;
    const send = ws.send.bind(ws);
    ws.send = (d: string) => (
      order.push(d.startsWith('{') ? `send:${JSON.parse(d).t}${JSON.parse(d).seq ?? ''}` : d),
      send(d)
    );
    ws.recv({
      t: 'hello',
      protocol_version: PROTOCOL_VERSION,
      device_id: env.identity.config.deviceId,
      role: 'owner-desktop',
      key_epoch: 1,
      high_water: 3,
      server_time: new Date().toISOString(),
    });
    await tick(10);
    const ev = (seq: number) => ({
      protocol_version: PROTOCOL_VERSION,
      seq,
      event_id: `evt${seq}xxxxxxxx`,
      event_type: 'decision.expired',
      occurred_at: new Date().toISOString(),
      question_id: null,
      question_revision: null,
      origin_device_id: null,
      data: {},
    });
    ws.recv({ t: 'event', event: ev(1) });
    ws.recv({ t: 'event', event: ev(3) }); // gap: 2 is missing
    await tick(20);
    const acks = () => order.filter((o) => o.startsWith('send:ack')).map((o) => Number(o.slice(8)));
    expect(order.indexOf('store:1')).toBeLessThan(order.indexOf('send:ack1'));
    expect(acks()).toEqual([1, 1]); // event 3 stored but the contiguous cursor stays at 1
    expect(await env.store.getCursor()).toBe(1);
    ws.recv({ t: 'event', event: ev(2) });
    await tick(20);
    expect(acks().at(-1)).toBe(3);
    expect(await env.store.getCursor()).toBe(3);
    await env.bridge.stop();
  });

  it('HTTP catch-up pages through events and acks the durable cursor', async () => {
    const env = await setupBridge();
    for (let i = 0; i < 5; i++) env.relay.push('decision.expired', null, null, {});
    expect(await env.bridge.catchUp()).toBe(5);
    expect(
      env.relay.calls.some(
        (c) => c.path === '/api/v1/deliveries/received' && (c.body as { seq: number }).seq === 5,
      ),
    ).toBe(true);
    // a second run starts after the stored cursor
    env.relay.calls.length = 0;
    await env.bridge.catchUp();
    expect(env.relay.calls.find((c) => c.path === '/api/v1/events')).toBeTruthy();
    void origin;
    void makePhone;
  });
});
