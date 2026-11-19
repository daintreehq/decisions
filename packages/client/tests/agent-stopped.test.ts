import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, parseAuthHeader } from '@daintreehq/decisions-protocol';
import {
  DecisionsBridge,
  MCP_BRIDGE_METHODS,
  MemoryLocalStore,
  PolicyRegistry,
  RelayClient,
  type AgentStoppedPushOutcome,
} from '../src/index.js';
import { FakeRelay, FakeSink, makeHost, makeIdentity, setupBridge } from './helpers.js';

/*
 * Asking for an agent-stopped push (docs/protocol.md section 11, `agent-stopped-push-v1`): the owner desktop's host
 * app asks, the request carries the protocol version alone, a relay that does not advertise the feature is never
 * asked, and every request is sent at most once, whatever comes of it.
 */

const PUSH_PATH = '/api/v1/push/agent-stopped';
const INFO_PATH = '/api/v1/info';
const MINUTE = 60_000;

/**
 * A started owner bridge whose relay client keeps the library's default retries (up to three, for network failures,
 * 429 and 5xx), so a test sees that this request never uses them. Its clock moves only with `pass`.
 */
async function world(o: { features?: string[] | undefined } = {}) {
  const env = await setupBridge();
  env.relay.features = 'features' in o ? o.features : ['thread-messages-v1', 'agent-stopped-push-v1'];
  let clock = Date.now();
  const sleep = vi.fn(async (_ms: number) => {});
  const client = new RelayClient({ identity: env.identity, fetch: env.relay.fetch, sleep });
  const bridge = new DecisionsBridge({
    identity: env.identity,
    store: env.store,
    sink: env.sink,
    client,
    policy: new PolicyRegistry(),
    pumpIntervalMs: 0,
    now: () => clock,
  });
  const errors: Error[] = [];
  bridge.on('error', (e) => errors.push(e));
  const posts = () => env.relay.calls.filter((c) => c.path === PUSH_PATH);
  const infos = () => env.relay.calls.filter((c) => c.path === INFO_PATH).length;
  /** Starts without a socket and lets the bridge's own start-up reads finish, so only the push talks after it. */
  const start = async () => {
    await bridge.start({ socket: false });
    await bridge.involvement.refresh();
    await bridge.pump();
    sleep.mockClear();
  };
  const pass = (ms: number) => {
    clock += ms;
  };
  const ask = async () => (await bridge.requestAgentStoppedPush()).outcome;
  return { ...env, client, bridge, sleep, errors, posts, infos, start, pass, ask };
}

describe('asking for a push', () => {
  it('sends the protocol version alone, once, and resolves with what the relay did', async () => {
    const w = await world();
    await w.start();
    const before = w.relay.calls.length;
    expect(await w.bridge.requestAgentStoppedPush()).toEqual({ outcome: 'sent' });
    // One feature check, then the request.
    expect(w.relay.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${INFO_PATH}`,
      `POST ${PUSH_PATH}`,
    ]);
    const [post] = w.posts();
    expect(post!.query).toBe('');
    expect(post!.body).toStrictEqual({ protocol_version: PROTOCOL_VERSION });
    expect(w.errors).toEqual([]);
  });

  it('carries nothing a host passes: the call takes no arguments', async () => {
    const w = await world();
    await w.start();
    const loose = w.bridge.requestAgentStoppedPush as unknown as (...a: unknown[]) => Promise<{
      outcome: AgentStoppedPushOutcome;
    }>;
    expect(
      await loose.call(w.bridge, 'claude in pane 3 finished', { pane: 'pane-1', project: 'x' }),
    ).toEqual({ outcome: 'sent' });
    expect(w.posts().map((c) => c.body)).toStrictEqual([{ protocol_version: PROTOCOL_VERSION }]);
    expect(JSON.stringify(w.posts()[0]!.headers)).not.toMatch(/pane|claude|project/);
  });

  it("resolves with each of the relay's outcomes as it gave it", async () => {
    const w = await world();
    await w.start();
    const outcomes = ['sent', 'failed', 'quiet-hours', 'rate-limited', 'no-subscription'] as const;
    for (const outcome of outcomes) w.relay.agentStoppedReplies.push({ status: 200, body: { outcome } });
    for (const outcome of outcomes) expect(await w.ask()).toBe(outcome);
    expect(w.posts()).toHaveLength(outcomes.length);
    expect(w.sleep).not.toHaveBeenCalled();
  });

  it('checks the features for each request, sharing one check between requests made together', async () => {
    const w = await world();
    await w.start();
    const infos = w.infos();
    expect(await Promise.all([w.ask(), w.ask(), w.ask()])).toEqual(['sent', 'sent', 'sent']);
    expect(w.infos()).toBe(infos + 1);
    expect(await w.ask()).toBe('sent');
    expect(w.infos()).toBe(infos + 2);
    expect(w.posts()).toHaveLength(4);
  });
});

describe('a relay without agent-stopped pushes', () => {
  for (const [name, features] of [
    ['a 0.3.0 relay listing no features', undefined],
    ['a relay listing none', []],
    ['a relay listing others only', ['thread-messages-v1', 'presence-v1']],
  ] as const) {
    it(`is never asked, and asking does nothing, without an error: ${name}`, async () => {
      const w = await world({ features: features ? [...features] : undefined });
      await w.start();
      const infos = w.infos();
      expect(await w.ask()).toBe('unsupported');
      // Believed for ten minutes: not even the features are read again meanwhile.
      w.pass(9 * MINUTE);
      expect(await w.ask()).toBe('unsupported');
      expect(w.infos()).toBe(infos + 1);
      expect(w.posts()).toEqual([]);
      expect(w.errors).toEqual([]);
    });
  }

  it('is picked up once upgraded', async () => {
    const w = await world({ features: ['thread-messages-v1'] });
    await w.start();
    expect(await w.ask()).toBe('unsupported');
    w.relay.features = ['thread-messages-v1', 'agent-stopped-push-v1'];
    w.pass(9 * MINUTE);
    expect(await w.ask()).toBe('unsupported');
    w.pass(MINUTE);
    expect(await w.ask()).toBe('sent');
    expect(w.posts()).toHaveLength(1);
  });

  it('that stops listing the feature is not asked again', async () => {
    const w = await world();
    await w.start();
    expect(await w.ask()).toBe('sent');
    w.relay.features = ['thread-messages-v1'];
    expect(await w.ask()).toBe('unsupported');
    expect(w.posts()).toHaveLength(1);
  });

  it('that lists the feature without the route is asked once, then left alone, quietly', async () => {
    const w = await world();
    w.relay.agentStoppedRoute = false;
    await w.start();
    const infos = w.infos();
    expect(await w.ask()).toBe('unsupported');
    expect(await w.ask()).toBe('unsupported');
    expect(w.posts()).toHaveLength(1);
    expect(w.infos()).toBe(infos + 1);
    expect(w.sleep).not.toHaveBeenCalled();
    expect(w.errors).toEqual([]);
  });

  it('whose features could not be read is not asked, and is checked again next time', async () => {
    const w = await world();
    await w.start();
    w.relay.failInfo = 1;
    expect(await w.ask()).toBe('dropped');
    expect(w.posts()).toEqual([]);
    expect(await w.ask()).toBe('sent');
  });
});

describe('never retried', () => {
  const ahead = () => new Date(Date.now() + 10 * MINUTE).toUTCString();
  for (const [name, reply] of [
    [
      "a 429 from the relay's request budget",
      {
        status: 429,
        body: { code: 'rate_limited', message: 'slow down', retry_after_ms: 1_000 },
      },
    ],
    ['a 503', { status: 503, body: { code: 'temporarily_unavailable', message: 'down' } }],
    ['push not configured', { status: 503, body: { code: 'not_configured', message: 'no' } }],
    ['a 400', { status: 400, body: { code: 'validation_error', message: 'no' } }],
    ['a 403', { status: 403, body: { code: 'forbidden', message: 'no' } }],
    ['a lost connection', 'reset'],
    [
      'a clock-skew refusal',
      { status: 401, body: { code: 'not_authenticated', message: 'skew' }, headers: { date: '' } },
    ],
    ['a reply that does not parse', { status: 200, body: 'not json' }],
    ['an outcome the library does not know', { status: 200, body: { outcome: 'queued' } }],
  ] as const) {
    it(`drops the request after ${name}`, async () => {
      const w = await world();
      await w.start();
      w.relay.agentStoppedReplies.push(
        typeof reply === 'string'
          ? reply
          : 'headers' in reply
            ? { ...reply, headers: { date: ahead() } }
            : { ...reply },
      );
      expect(await w.ask()).toBe('dropped');
      expect(w.posts()).toHaveLength(1);
      expect(w.sleep).not.toHaveBeenCalled();
      expect(w.errors).toEqual([]);
      // The next stop is a request of its own, and is sent.
      expect(await w.ask()).toBe('sent');
      expect(w.posts()).toHaveLength(2);
    });
  }

  it('learns the skew a refusal shows without resending, and signs the next request with it', async () => {
    const w = await world();
    await w.start();
    const at = new Date(Date.now() + 10 * MINUTE);
    w.relay.agentStoppedReplies.push({
      status: 401,
      body: { code: 'not_authenticated', message: 'skew' },
      headers: { date: at.toUTCString() },
    });
    expect(await w.ask()).toBe('dropped');
    expect(await w.ask()).toBe('sent');
    const stamps = w.posts().map((c) => parseAuthHeader(c.headers.authorization!)!.ts);
    expect(stamps).toHaveLength(2);
    expect(Math.abs(stamps[1]! - at.getTime())).toBeLessThan(5_000);
  });

  it('its relay client sends the request once even with retries on', async () => {
    const env = await setupBridge();
    const fetch = vi.fn(env.relay.fetch);
    const sleep = vi.fn(async () => {});
    const client = new RelayClient({ identity: env.identity, fetch, sleep });
    env.relay.status5xx = 1;
    await expect(client.postAgentStoppedPush()).rejects.toMatchObject({ status: 503 });
    env.relay.down = 1;
    await expect(client.postAgentStoppedPush()).rejects.toMatchObject({ code: 'network_error' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    // Nor does fetch send it again on a redirect.
    for (const [, init] of fetch.mock.calls) expect(init?.redirect).toBe('error');
  });
});

describe('the bridge', () => {
  it('must be started, and is refused again once stopped', async () => {
    const w = await world();
    await expect(w.bridge.requestAgentStoppedPush()).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(w.infos()).toBe(0);
    await w.start();
    await w.bridge.stop();
    const infos = w.infos();
    await expect(w.bridge.requestAgentStoppedPush()).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(w.infos()).toBe(infos);
    expect(w.posts()).toEqual([]);
  });

  it('sends nothing when it stops while the relay is asked for its features', async () => {
    const w = await world();
    await w.start();
    let release!: () => void;
    w.relay.holdInfo = new Promise<void>((r) => (release = r));
    const asking = w.ask();
    await vi.waitFor(() => expect(w.relay.calls.at(-1)?.path).toBe(INFO_PATH));
    await w.bridge.stop();
    w.relay.holdInfo = null;
    release();
    expect(await asking).toBe('dropped');
    expect(w.posts()).toEqual([]);
    // A restart asks afresh.
    await w.start();
    expect(await w.ask()).toBe('sent');
  });

  it('may not ask once the desktop is revoked', async () => {
    const w = await world();
    await w.start();
    w.relay.push('device.revoked', null, null, {
      device_id: w.identity.config.deviceId,
      key_epoch: 2,
    });
    await w.bridge.catchUp();
    expect(w.bridge.state).toBe('revoked');
    await expect(w.bridge.requestAgentStoppedPush()).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.posts()).toEqual([]);
  });
});

describe('who may ask', () => {
  it('a Remote Host is refused before anything is sent, by the bridge and by its relay client', async () => {
    const owner = await makeIdentity();
    const relay = new FakeRelay(owner);
    await relay.initOwner();
    relay.features = ['agent-stopped-push-v1'];
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
    await expect(bridge.requestAgentStoppedPush()).rejects.toMatchObject({ code: 'forbidden' });
    await expect(client.postAgentStoppedPush()).rejects.toThrow(/owner desktop/);
    expect(relay.calls.slice(before)).toEqual([]);
  });

  it('is no MCP tool', () => {
    expect(MCP_BRIDGE_METHODS).not.toContain('requestAgentStoppedPush');
  });
});
