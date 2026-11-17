import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import {
  BridgeError,
  DecisionsBridge,
  MCP_BRIDGE_METHODS,
  MemoryLocalStore,
  PRESENCE_REPORT_MS,
  PolicyRegistry,
  RelayClient,
} from '../src/index.js';
import { FakeRelay, FakeSink, makeHost, makeIdentity, setupBridge } from './helpers.js';

/*
 * Reporting that the person is at the computer (docs/protocol.md section 11, `presence-v1`): the bridge keeps the
 * relay's lease current while the host's latest report says they are here, ends it when they are reported away,
 * and lets it lapse when reports stop or the bridge stops. Time is fake and moved a second at a time; signing and
 * the fake relay still run on the real event loop, so each step waits in real time for the reporter to settle.
 */

const SECOND = 1_000;
const realSetTimeout = globalThis.setTimeout;
const realWait = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
const PRESENCE_PATH = '/api/v1/presence';

afterEach(() => {
  vi.useRealTimers();
});

async function world(o: { features?: string[] | undefined } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const env = await setupBridge();
  env.relay.features = 'features' in o ? o.features : ['thread-messages-v1', 'presence-v1'];
  // The relay keeps its own time, moved on with the desktop's by `pass`, so the desktop's clock can be set apart.
  let relayNow = Date.now();
  env.relay.presenceNow = () => relayNow;
  const errors: Error[] = [];
  env.bridge.on('error', (e) => errors.push(e));
  const presenceCalls = () => env.relay.calls.filter((c) => c.path === PRESENCE_PATH);
  /** The flag of every presence PUT the relay saw, in order. */
  const puts = () => presenceCalls().map((c) => (c.body as { present: boolean }).present);
  const infos = () => env.relay.calls.filter((c) => c.path === '/api/v1/info').length;
  /** Real time until the reporter has nothing in flight. */
  const idle = async () => {
    for (let i = 0; i < 500; i++) {
      await realWait(2);
      if (!env.bridge.presence.busy) {
        await realWait(2);
        if (!env.bridge.presence.busy) return;
      }
    }
    throw new Error('the presence reporter never settled');
  };
  /**
   * Move fake time on a `step` (a second) at a time, letting the reporter settle after each, and check each step. A
   * request is stamped at the end of the step its timer fired in, so longer steps suit only tests that need no exact
   * cadence.
   */
  const pass = async (ms: number, each?: () => void, step = SECOND) => {
    for (let t = 0; t < ms; t += step) {
      relayNow += step;
      vi.advanceTimersByTime(step);
      await idle();
      each?.();
    }
  };
  const leaseCurrent = () => env.relay.presenceUntil !== null && env.relay.presenceUntil > relayNow;
  /** Starts without a socket and lets the bridge's own start-up reads finish, so only presence talks after it. */
  const start = async () => {
    await env.bridge.start({ socket: false });
    await env.bridge.involvement.refresh();
    await env.bridge.pump();
    await idle();
  };
  return { ...env, errors, presenceCalls, puts, infos, idle, pass, leaseCurrent, start };
}

describe('while the person is present', () => {
  it('keeps the lease current as long as the host keeps reporting, sending the flag alone', async () => {
    const w = await world();
    await w.start();
    const before = w.relay.calls.length;
    w.bridge.reportPresence(true);
    await w.idle();
    expect(w.puts()).toEqual([true]);
    expect(w.leaseCurrent()).toBe(true);
    // The host reports every 30 s for five minutes: the lease never lapses in between.
    for (let s = 0; s < 300; s += 30) {
      w.bridge.reportPresence(true);
      await w.pass(30 * SECOND, () => expect(w.leaseCurrent()).toBe(true));
    }
    // Renewed every 20 s from when it started, however often the host reports.
    expect(w.puts()).toEqual(Array(16).fill(true));
    // Nothing but one feature check and the presence PUTs, each carrying only the flag.
    const sent = w.relay.calls.slice(before);
    expect(sent.filter((c) => c.path !== PRESENCE_PATH)).toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/v1/info' }),
    ]);
    for (const c of w.presenceCalls()) {
      expect(c.method).toBe('PUT');
      expect(c.query).toBe('');
      expect(c.body).toStrictEqual({ protocol_version: PROTOCOL_VERSION, present: true });
    }
    expect(w.errors).toEqual([]);
  });

  it('frequent reports never add requests', async () => {
    const w = await world();
    await w.start();
    for (let s = 0; s < 60; s++) {
      w.bridge.reportPresence(true);
      await w.pass(SECOND);
    }
    // At 0, 20 and 40 s.
    expect(w.puts()).toEqual([true, true, true]);
    expect(w.infos()).toBe(1);
  });

  it('retries a renewal the relay could not take, and reports a refusal once', async () => {
    const w = await world();
    await w.start();
    w.relay.presenceReplies.push({
      status: 503,
      body: { code: 'temporarily_unavailable', message: 'down' },
    });
    w.bridge.reportPresence(true);
    await w.idle();
    expect(w.leaseCurrent()).toBe(false);
    // Backoff from one second, never longer than a renewal period.
    await w.pass(3 * SECOND);
    expect(w.puts()).toEqual([true, true]);
    expect(w.leaseCurrent()).toBe(true);
    expect(w.errors).toEqual([]);

    // A refusal is not retried: it is reported, and the relay is left alone while the host keeps reporting.
    w.relay.presenceReplies.push({
      status: 400,
      body: { code: 'validation_error', message: 'no' },
    });
    await w.pass(20 * SECOND);
    expect(w.puts()).toHaveLength(3);
    for (let s = 0; s < 120; s += 30) {
      w.bridge.reportPresence(true);
      await w.pass(30 * SECOND);
    }
    expect(w.puts()).toHaveLength(3);
    expect(w.errors.map((e) => (e as { code?: string }).code)).toEqual(['validation_error']);
  });

  it('waits as long as the relay asks before retrying', async () => {
    const w = await world();
    await w.start();
    w.relay.presenceReplies.push({
      status: 429,
      body: { code: 'rate_limited', message: 'slow down', retry_after_ms: 30_000 },
    });
    w.bridge.reportPresence(true);
    await w.idle();
    await w.pass(29 * SECOND);
    expect(w.puts()).toEqual([true]);
    await w.pass(SECOND);
    expect(w.puts()).toEqual([true, true]);
    expect(w.leaseCurrent()).toBe(true);
  });

  it('backs off from one second, and never longer than a renewal period', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const w = await world();
      await w.start();
      w.relay.presenceReplies.push({
        status: 503,
        body: { code: 'temporarily_unavailable', message: 'down' },
      });
      w.bridge.reportPresence(true);
      await w.idle();
      vi.advanceTimersByTime(SECOND - 1);
      await w.idle();
      expect(w.puts()).toHaveLength(1);
      await w.pass(SECOND);
      expect(w.puts()).toHaveLength(2);

      // The longest waits: 2, 4, 8, 16, then 20 and 20 seconds (not 32 and 64), so it still lands inside the report.
      random.mockReturnValue(0.999);
      w.bridge.reportPresence(false);
      await w.idle();
      for (let i = 0; i < 6; i++)
        w.relay.presenceReplies.push({
          status: 503,
          body: { code: 'temporarily_unavailable', message: 'down' },
        });
      w.bridge.reportPresence(true);
      await w.idle();
      let seen = w.puts().length;
      const retriedAt: number[] = [];
      for (let s = 1; s <= 72; s++) {
        if (s % 30 === 0) w.bridge.reportPresence(true);
        await w.pass(SECOND);
        if (w.puts().length > seen) {
          seen = w.puts().length;
          retriedAt.push(s);
        }
      }
      // 1.998, +3.996, +7.992, +15.984, +19.98, +19.98 seconds, seen at the end of each second.
      expect(retriedAt).toEqual([2, 6, 14, 30, 50, 70]);
      expect(w.leaseCurrent()).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  it('retries the feature check when the relay cannot be reached', async () => {
    const w = await world();
    await w.start();
    w.relay.failInfo = 1;
    w.bridge.reportPresence(true);
    await w.idle();
    expect(w.puts()).toEqual([]);
    await w.pass(3 * SECOND);
    expect(w.infos()).toBe(2);
    expect(w.puts()).toEqual([true]);
    expect(w.errors).toEqual([]);
  });

  it('keeps renewing when the desktop clock steps back and the host keeps reporting', async () => {
    const w = await world();
    await w.start();
    w.bridge.reportPresence(true);
    await w.pass(30 * SECOND);
    expect(w.puts()).toEqual([true, true]);
    vi.setSystemTime(Date.now() - 3_600_000);
    for (let s = 0; s < 180; s += 30) {
      w.bridge.reportPresence(true);
      await w.idle();
      await w.pass(30 * SECOND, () => expect(w.leaseCurrent()).toBe(true));
    }
    // The first report after the step renews at once (30 s), then every 20 seconds: no stall, and no burst.
    expect(w.puts()).toHaveLength(12);
    expect(w.infos()).toBe(2);
  });

  it('never times a renewal from a send made before the clock stepped back', async () => {
    const w = await world();
    await w.start();
    let release!: () => void;
    w.relay.holdPresence = new Promise<void>((r) => (release = r));
    w.bridge.reportPresence(true);
    for (let i = 0; i < 500 && w.puts().length === 0; i++) await realWait(2);
    vi.setSystemTime(Date.now() - 3_600_000);
    w.bridge.reportPresence(true);
    w.relay.holdPresence = null;
    release();
    await w.idle();
    // Its send time is an hour ahead of the clock now: the report renews at once instead of waiting on it.
    expect(w.puts()).toEqual([true, true]);
    await w.pass(20 * SECOND);
    expect(w.puts()).toEqual([true, true, true]);
  });

  it('never stretches a report when the desktop clock steps back', async () => {
    const w = await world();
    await w.start();
    w.bridge.reportPresence(true);
    await w.pass(30 * SECOND);
    vi.setSystemTime(Date.now() - 3_600_000);
    // No report since the step: renewal stops, and the lease lapses a minute after the last one.
    await w.pass(2 * LIMITS.presenceLeaseMs);
    expect(w.puts()).toEqual([true, true]);
    expect(w.leaseCurrent()).toBe(false);

    // Nor one kept before the bridge started.
    const v = await world();
    v.bridge.reportPresence(true);
    await v.pass(10 * 60 * SECOND, undefined, 60 * SECOND);
    vi.setSystemTime(Date.now() - 3_600_000);
    await v.start();
    await v.pass(30 * SECOND);
    expect(v.puts()).toEqual([]);
  });
});

describe('the lease lapses', () => {
  it('when the host stops reporting', async () => {
    const w = await world();
    await w.start();
    w.bridge.reportPresence(true);
    await w.idle();
    await w.pass(PRESENCE_REPORT_MS + 2 * LIMITS.presenceLeaseMs);
    // Renewed at 0, 20, 40, 60, 80 and 100 s; never past the report's two minutes, and never ended early.
    expect(w.puts()).toEqual(Array(6).fill(true));
    expect(w.leaseCurrent()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('when the person is reported away: ended at once, and nothing more is sent', async () => {
    const w = await world();
    await w.start();
    w.bridge.reportPresence(true);
    await w.pass(30 * SECOND);
    w.bridge.reportPresence(false);
    await w.idle();
    expect(w.puts()).toEqual([true, true, false]);
    expect(w.relay.presenceUntil).toBeNull();
    expect(w.presenceCalls().at(-1)!.body).toStrictEqual({
      protocol_version: PROTOCOL_VERSION,
      present: false,
    });
    await w.pass(3 * 60 * SECOND);
    expect(w.puts()).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    // Coming back starts a lease at once.
    w.bridge.reportPresence(true);
    await w.idle();
    expect(w.puts()).toEqual([true, true, false, true]);
    expect(w.leaseCurrent()).toBe(true);
  });

  it('never sends away for a lease that was never started', async () => {
    const w = await world();
    await w.start();
    w.bridge.reportPresence(false);
    await w.pass(10 * SECOND);
    w.bridge.reportPresence(false);
    await w.idle();
    expect(w.infos()).toBe(0);
    expect(w.puts()).toEqual([]);
  });

  it('when the person leaves while a renewal is on the wire, and comes back without waiting on it', async () => {
    const w = await world();
    await w.start();
    let release!: () => void;
    w.relay.holdPresence = new Promise<void>((r) => (release = r));
    w.bridge.reportPresence(true);
    for (let i = 0; i < 500 && w.puts().length === 0; i++) await realWait(2);
    expect(w.puts()).toEqual([true]);
    w.bridge.reportPresence(false);
    w.relay.holdPresence = null;
    release();
    await w.idle();
    // The renewal landed after the person left: the lease it started is ended.
    expect(w.puts()).toEqual([true, false]);
    expect(w.relay.presenceUntil).toBeNull();
    w.bridge.reportPresence(true);
    await w.idle();
    expect(w.puts()).toEqual([true, false, true]);
    expect(w.leaseCurrent()).toBe(true);
  });

  it('when the bridge stops, with nothing left running, and a restart waits for a new report', async () => {
    const w = await world();
    await w.start();
    w.bridge.reportPresence(true);
    await w.pass(10 * SECOND);
    expect(w.puts()).toEqual([true]);
    await w.bridge.stop();
    expect(vi.getTimerCount()).toBe(0);
    await w.pass(LIMITS.presenceLeaseMs);
    expect(w.puts()).toEqual([true]);
    expect(w.leaseCurrent()).toBe(false);
    // The report from before the stop would still be fresh, but a restart waits for a new one.
    await w.start();
    await w.pass(30 * SECOND);
    expect(w.puts()).toEqual([true]);
    w.bridge.reportPresence(true);
    await w.idle();
    expect(w.puts()).toEqual([true, true]);
  });

  it('when the bridge stops with a renewal on the wire: its reply schedules nothing', async () => {
    const w = await world();
    await w.start();
    let release!: () => void;
    w.relay.holdPresence = new Promise<void>((r) => (release = r));
    w.bridge.reportPresence(true);
    for (let i = 0; i < 500 && w.puts().length === 0; i++) await realWait(2);
    await w.bridge.stop();
    w.relay.holdPresence = null;
    release();
    await w.idle();
    expect(vi.getTimerCount()).toBe(0);
    await w.pass(2 * LIMITS.presenceLeaseMs);
    expect(w.puts()).toEqual([true]);
    expect(w.leaseCurrent()).toBe(false);
  });

  it('when the desktop is revoked, and it may not report again', async () => {
    const w = await world();
    await w.start();
    w.bridge.reportPresence(true);
    await w.idle();
    w.relay.push('device.revoked', null, null, {
      device_id: w.identity.config.deviceId,
      key_epoch: 2,
    });
    await w.bridge.catchUp();
    expect(w.bridge.state).toBe('revoked');
    expect(vi.getTimerCount()).toBe(0);
    await w.pass(2 * LIMITS.presenceLeaseMs);
    expect(w.puts()).toEqual([true]);
    expect(() => w.bridge.reportPresence(true)).toThrow(BridgeError);
    expect(w.puts()).toEqual([true]);
  });

  it('when the relay refuses a renewal and the person then leaves: the earlier lease is still ended', async () => {
    const w = await world();
    await w.start();
    w.bridge.reportPresence(true);
    await w.idle();
    w.relay.presenceReplies.push({ status: 403, body: { code: 'forbidden', message: 'no' } });
    await w.pass(20 * SECOND);
    expect(w.puts()).toEqual([true, true]);
    expect(w.leaseCurrent()).toBe(true);
    w.bridge.reportPresence(false);
    await w.idle();
    expect(w.puts()).toEqual([true, true, false]);
    expect(w.relay.presenceUntil).toBeNull();
    expect(w.errors.map((e) => (e as { code?: string }).code)).toEqual(['forbidden']);
  });

  it('when the person leaves after a renewal whose reply was lost: it may have started a lease, so it is ended', async () => {
    const w = await world();
    await w.start();
    w.relay.dropPresenceReply = 1;
    w.bridge.reportPresence(true);
    await w.idle();
    expect(w.puts()).toEqual([true]);
    expect(w.leaseCurrent()).toBe(true);
    w.bridge.reportPresence(false);
    await w.idle();
    expect(w.puts()).toEqual([true, false]);
    expect(w.relay.presenceUntil).toBeNull();
  });

  it('when the bridge restarts with a renewal on the wire: its late reply never delays the new run', async () => {
    const w = await world();
    await w.start();
    let release!: () => void;
    w.relay.holdPresence = new Promise<void>((r) => (release = r));
    w.bridge.reportPresence(true);
    for (let i = 0; i < 500 && w.puts().length === 0; i++) await realWait(2);
    await w.bridge.stop();
    await w.bridge.start({ socket: false });
    w.bridge.reportPresence(true);
    w.relay.holdPresence = null;
    release();
    await w.idle();
    // The new run sends its own as soon as the old request is done, instead of counting from the old one.
    expect(w.puts()).toEqual([true, true]);
  });

  it('when the bridge stops while still starting up: nothing starts sending afterwards', async () => {
    const w = await world();
    const starting = w.bridge.start({ socket: false });
    await w.bridge.stop();
    w.bridge.reportPresence(true);
    await starting;
    await w.pass(30 * SECOND);
    expect(w.puts()).toEqual([]);
    expect(w.infos()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('before the bridge starts', () => {
  it('keeps the latest report and acts on it at start, if still fresh', async () => {
    const w = await world();
    w.bridge.reportPresence(true);
    await w.pass(5 * SECOND);
    expect(
      w.relay.calls.filter((c) => c.path === PRESENCE_PATH || c.path === '/api/v1/info'),
    ).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await w.start();
    expect(w.puts()).toEqual([true]);
  });

  it('drops a report gone stale', async () => {
    const w = await world();
    w.bridge.reportPresence(true);
    await w.pass(PRESENCE_REPORT_MS);
    await w.start();
    await w.pass(30 * SECOND);
    expect(w.puts()).toEqual([]);
  });

  it('forgets a report when the bridge is stopped before it ever started', async () => {
    const w = await world();
    w.bridge.reportPresence(true);
    await w.bridge.stop();
    await w.start();
    await w.pass(30 * SECOND);
    expect(w.puts()).toEqual([]);
  });
});

describe('a relay without presence', () => {
  for (const [name, features] of [
    ['a 0.3.0 relay listing no features', undefined],
    ['a relay listing none', []],
    ['a relay listing others only', ['thread-messages-v1', 'involvement-v1']],
  ] as const) {
    it(`is never sent presence: ${name}`, async () => {
      const w = await world({ features: features ? [...features] : undefined });
      await w.start();
      for (let s = 0; s < 120; s += 30) {
        w.bridge.reportPresence(true);
        await w.pass(30 * SECOND);
      }
      w.bridge.reportPresence(false);
      await w.idle();
      expect(w.puts()).toEqual([]);
      expect(w.infos()).toBe(1);
      expect(w.errors).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('that lists the feature without the route is left alone, quietly', async () => {
    const w = await world();
    w.relay.presenceRoute = false;
    await w.start();
    for (let s = 0; s < 120; s += 30) {
      w.bridge.reportPresence(true);
      await w.pass(30 * SECOND);
    }
    w.bridge.reportPresence(false);
    await w.idle();
    expect(w.puts()).toEqual([true]);
    expect(w.errors).toEqual([]);
  });

  it('is picked up once upgraded, while the host keeps reporting', async () => {
    const w = await world({ features: ['thread-messages-v1'] });
    await w.start();
    w.bridge.reportPresence(true);
    await w.idle();
    w.relay.features = ['thread-messages-v1', 'presence-v1'];
    // Believed for ten minutes, then asked again on the next report.
    for (let s = 0; s < 9 * 60; s += 30) {
      w.bridge.reportPresence(true);
      await w.pass(30 * SECOND, undefined, 5 * SECOND);
    }
    expect(w.puts()).toEqual([]);
    for (let s = 0; s < 90; s += 30) {
      w.bridge.reportPresence(true);
      await w.pass(30 * SECOND, undefined, 5 * SECOND);
    }
    expect(w.infos()).toBe(2);
    expect(w.puts().length).toBeGreaterThan(0);
    expect(w.leaseCurrent()).toBe(true);
  });

  it('that stops listing the feature is no longer sent presence', async () => {
    const w = await world();
    await w.start();
    w.bridge.reportPresence(true);
    await w.idle();
    w.relay.features = ['thread-messages-v1'];
    for (let s = 0; s < 11 * 60; s += 30) {
      w.bridge.reportPresence(true);
      await w.pass(30 * SECOND, undefined, 5 * SECOND);
    }
    const sent = w.puts().length;
    // Believed for ten minutes, then asked again: renewals stop.
    expect(sent).toBeLessThanOrEqual(31);
    expect(w.infos()).toBe(2);
    for (let s = 0; s < 120; s += 30) {
      w.bridge.reportPresence(true);
      await w.pass(30 * SECOND, undefined, 5 * SECOND);
    }
    // Not even an away goes to it: the lease it may hold lapses.
    w.bridge.reportPresence(false);
    await w.idle();
    expect(w.puts()).toHaveLength(sent);
    expect(w.puts()).not.toContain(false);
    expect(w.errors).toEqual([]);
  });
});

describe('who may report', () => {
  it('a Remote Host is refused before anything is sent, by the bridge and by its relay client', async () => {
    const owner = await makeIdentity();
    const relay = new FakeRelay(owner);
    await relay.initOwner();
    relay.features = ['presence-v1'];
    const host = await makeHost(owner, relay);
    const client = new RelayClient({
      identity: host.identity,
      fetch: relay.fetch,
      sleep: async () => {},
      maxRetries: 0,
    });
    const sink = new FakeSink();
    sink.addPane('pane-1');
    const bridge = new DecisionsBridge({
      identity: host.identity,
      keyStore: host.keyStore,
      store: new MemoryLocalStore(),
      sink,
      client,
      policy: new PolicyRegistry(),
      pumpIntervalMs: 0,
    });
    const before = relay.calls.length;
    for (const present of [true, false]) {
      expect(() => bridge.reportPresence(present)).toThrow(
        expect.objectContaining({ code: 'forbidden' }),
      );
      await expect(client.putPresence(present)).rejects.toThrow(/owner desktop/);
    }
    expect(relay.calls.length).toBe(before);
  });

  it('takes a boolean only, and is no MCP tool', async () => {
    const w = await world();
    expect(() => w.bridge.reportPresence('yes' as unknown as boolean)).toThrow(
      expect.objectContaining({ code: 'validation_error' }),
    );
    expect(MCP_BRIDGE_METHODS).not.toContain('reportPresence');
  });

  it('its relay client never retries a presence request on its own: the reporter owns the timing', async () => {
    const env = await setupBridge();
    const fetch = vi.fn(env.relay.fetch);
    const sleep = vi.fn(async () => {});
    const client = new RelayClient({ identity: env.identity, fetch, sleep });
    env.relay.status5xx = 1;
    await expect(client.putPresence(true)).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
