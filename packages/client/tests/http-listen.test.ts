import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_RETRY_MS,
  DEFAULT_POLL,
  DecisionsBridge,
  PolicyRegistry,
  RelayClient,
  RelayError,
  readHttpSyncStatus,
  isFatalSyncError,
  retryDelayMs,
  syncFailureReason,
  type HttpPollOptions,
  type HttpSyncStatus,
} from '../src/index.js';
import { FakeSink, origin, setupBridge } from './helpers.js';

/** `vi.waitFor` with room for a slow machine. */
const wait = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 5_000, interval: 5 });

/** Fast enough for a test, slow enough that a missing schedule shows. */
const POLL: HttpPollOptions = { intervalMs: 20, retryBaseMs: 10, retryCapMs: 40, rand: () => 0 };

type Env = Awaited<ReturnType<typeof setupBridge>>;

/**
 * Controls the relay's HTTP side as the bridge's client sees it: event pages can fail or be held open (honouring the
 * request's abort signal, as `fetch` does), every request can be refused, and overlapping event reads are counted.
 */
function control(env: Env, client: RelayClient = env.client) {
  const c = {
    failEvents: 0,
    hold: null as Promise<void> | null,
    refuse: null as { status: number; code: string; message: string } | null,
    /** Requests refused while `refuse` was set, whatever their path. */
    refused: 0,
    inFlight: 0,
    maxInFlight: 0,
    eventReads: [] as number[],
  };
  const inner = env.relay.fetch;
  (client as unknown as { f: typeof fetch }).f = (async (
    i: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(i));
    if (c.refuse) {
      c.refused++;
      return new Response(JSON.stringify({ code: c.refuse.code, message: c.refuse.message }), {
        status: c.refuse.status,
      });
    }
    if (url.pathname !== '/api/v1/events') return inner(i, init);
    c.eventReads.push(Number(url.searchParams.get('after')));
    c.inFlight++;
    c.maxInFlight = Math.max(c.maxInFlight, c.inFlight);
    try {
      if (c.hold) {
        const signal = init?.signal;
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          void c.hold!.then(resolve);
        });
      }
      if (c.failEvents > 0) {
        c.failEvents--;
        throw new TypeError('fetch failed');
      }
      return await inner(i, init);
    } finally {
      c.inFlight--;
    }
  }) as typeof fetch;
  return c;
}

/** Collects each `sync` the bridge reports. */
function syncs(bridge: DecisionsBridge): HttpSyncStatus[] {
  const seen: HttpSyncStatus[] = [];
  bridge.on('sync', (s) => seen.push(s));
  return seen;
}

/** A question asked through the running listener, published to the relay. */
async function ask(env: Env): Promise<string> {
  const r = await env.bridge.registerQuestion({
    origin: origin(),
    input: { question: 'Ship it?', options: [{ id: 'yes', label: 'Yes' }] },
  });
  await env.bridge.pump();
  expect(env.relay.questions.has(r.questionId)).toBe(true);
  return r.questionId;
}

const bridges: DecisionsBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
});

async function listening(over: { poll?: HttpPollOptions; now?: () => number } = {}) {
  const env = await setupBridge(over.now ? { now: over.now } : {});
  const ctl = control(env);
  const seen = syncs(env.bridge);
  bridges.push(env.bridge);
  await env.bridge.start({ socket: false, poll: over.poll ?? POLL });
  // The first sync runs straight away and finds nothing: the queue is empty.
  await wait(() => expect(seen.some((s) => s.outcome === 'ok')).toBe(true));
  expect(env.sink.typed).toHaveLength(0);
  return { ...env, ctl, seen };
}

describe('a socketless bridge that polls over HTTP', () => {
  const outcomes: [string, (env: Env, qid: string) => Promise<unknown>, string[]][] = [
    [
      'an answer',
      (env, qid) => env.relay.answerEvent({ questionId: qid, phone: env.phone, options: ['yes'] }),
      ['Yes'],
    ],
    [
      'a dismissal from the phone',
      (env, qid) =>
        env.relay.plainActionEvent({ questionId: qid, signer: env.phone, action: 'cancel' }),
      ['status: declined', 'authorised: no'],
    ],
    [
      'an expiry',
      async (env, qid) =>
        env.relay.push('decision.expired', qid, 0, {
          expired_at: new Date().toISOString(),
          target_host_id: 'x'.repeat(12),
        }),
      ['status: expired', 'NOT authorised to continue'],
    ],
  ];

  it.each(outcomes)(
    'delivers %s committed after its first, empty sync, with no call from the host',
    async (_name, commit, expected) => {
      const env = await listening();
      const qid = await ask(env);
      await commit(env, qid);
      await wait(() => expect(env.sink.typed).toHaveLength(1));
      expect(env.sink.typed[0]!.target.paneId).toBe('pane-1');
      expect(env.sink.typed[0]!.text).toContain(`question_id: ${qid}`);
      for (const line of expected) expect(env.sink.typed[0]!.text).toContain(line);
      // Delivered once: later polls find nothing new to type.
      const reads = env.ctl.eventReads.length;
      await wait(() => expect(env.ctl.eventReads.length).toBeGreaterThan(reads + 1));
      expect(env.sink.typed).toHaveLength(1);
    },
  );

  it('declares its features through a socket ticket it never opens, before reading events', async () => {
    const env = await listening();
    const paths = env.relay.calls.map((c) => `${c.method} ${c.path}`);
    const ticket = paths.indexOf('POST /api/v1/socket-ticket');
    expect(ticket).toBeGreaterThanOrEqual(0);
    expect(ticket).toBeLessThan(paths.indexOf('GET /api/v1/events'));
    const body = env.relay.calls[ticket]!.body as { features: string[] };
    expect(body.features).toEqual(expect.arrayContaining([...env.bridge.features]));
    // Once per start: later syncs only read events.
    await wait(() => expect(env.ctl.eventReads.length).toBeGreaterThan(2));
    expect(env.relay.calls.filter((c) => c.path === '/api/v1/socket-ticket')).toHaveLength(1);
  });

  it('keeps polling through an outage, backing off, and delivers once the relay is back', async () => {
    const env = await listening();
    const qid = await ask(env);
    env.ctl.failEvents = 3;
    await env.relay.answerEvent({ questionId: qid, phone: env.phone, options: ['yes'] });
    await wait(() => expect(env.sink.typed).toHaveLength(1));
    const failed = env.seen.filter((s) => s.outcome === 'degraded');
    expect(failed.map((s) => s.failures)).toEqual([1, 2, 3]);
    expect(failed.every((s) => s.reason === 'network_error')).toBe(true);
    // Each failure keeps the last success, so a reader can tell how stale the listener is.
    const lastOk = env.seen
      .slice(0, env.seen.indexOf(failed[0]!))
      .findLast((s) => s.outcome === 'ok')!;
    expect(failed[0]!.last_success_at).toBe(lastOk.last_success_at);
    expect(failed[0]!.last_success_cursor).toBe(lastOk.last_success_cursor);
    await wait(async () =>
      expect(await readHttpSyncStatus(env.store)).toMatchObject({ outcome: 'ok', failures: 0 }),
    );
  });

  it('never runs two event reads at once, whoever asks', async () => {
    const env = await listening();
    let release!: () => void;
    env.ctl.hold = new Promise<void>((r) => (release = r));
    await wait(() => expect(env.ctl.inFlight).toBe(1));
    const joined = [env.bridge.catchUp(), env.bridge.sync(), env.bridge.sync()];
    await new Promise((r) => setTimeout(r, 3 * POLL.intervalMs!));
    expect(env.ctl.maxInFlight).toBe(1);
    release();
    env.ctl.hold = null;
    await Promise.all(joined);
    await wait(() => expect(env.ctl.eventReads.length).toBeGreaterThan(3));
    expect(env.ctl.maxInFlight).toBe(1);
  });

  it('stops promptly with a read in flight, and records nothing for it', async () => {
    const env = await listening();
    env.ctl.hold = new Promise<void>(() => undefined); // the relay never answers
    await wait(() => expect(env.ctl.inFlight).toBe(1));
    const before = await readHttpSyncStatus(env.store);
    await env.bridge.stop();
    expect(env.ctl.inFlight).toBe(0);
    expect(await readHttpSyncStatus(env.store)).toEqual(before);
    const reads = env.ctl.eventReads.length;
    await new Promise((r) => setTimeout(r, 4 * POLL.intervalMs!));
    expect(env.ctl.eventReads.length).toBe(reads);
  });

  it('stops for good when the relay says the device was revoked', async () => {
    const env = await listening();
    const states: string[] = [];
    env.bridge.on('state', (s) => states.push(s));
    env.ctl.refuse = {
      status: 401,
      code: 'not_authenticated',
      message: 'unknown or revoked device',
    };
    await wait(() => expect(env.bridge.state).toBe('revoked'));
    expect(states).toEqual(['revoked']);
    expect(await readHttpSyncStatus(env.store)).toMatchObject({
      outcome: 'revoked',
      reason: 'device_revoked',
      next_attempt_at: null,
    });
    const calls = env.relay.calls.length;
    env.ctl.refuse = null;
    await new Promise((r) => setTimeout(r, 4 * POLL.intervalMs!));
    expect(env.relay.calls.length).toBe(calls);
  });

  it('retries any other refusal of its signature only every few minutes, without stopping', async () => {
    const env = await listening();
    env.ctl.refuse = { status: 401, code: 'not_authenticated', message: 'bad signature' };
    await wait(() => expect(env.seen.at(-1)?.outcome).toBe('degraded'));
    const s = env.seen.at(-1)!;
    expect(s.reason).toBe('not_authenticated');
    expect(s.next_attempt_at! - s.last_attempt_at!).toBeGreaterThanOrEqual(AUTH_RETRY_MS);
    expect(env.bridge.state).toBe('running');
    // It really waits: once work already under way has settled, no request at all is sent over many poll intervals.
    await new Promise((r) => setTimeout(r, 2 * POLL.intervalMs!));
    const refused = env.ctl.refused;
    const attempts = env.seen.length;
    await new Promise((r) => setTimeout(r, 6 * POLL.intervalMs!));
    expect(env.seen.length).toBe(attempts);
    expect(env.ctl.refused).toBe(refused);
  });

  it('stops polling, but not the bridge, when the relay needs a newer client', async () => {
    const env = await listening();
    env.ctl.refuse = {
      status: 426,
      code: 'upgrade_required',
      message: 'unsupported protocol version',
    };
    await wait(() => expect(env.seen.at(-1)?.outcome).toBe('fatal'));
    expect(env.seen.at(-1)).toMatchObject({ reason: 'upgrade_required', next_attempt_at: null });
    expect(await readHttpSyncStatus(env.store)).toMatchObject({ outcome: 'fatal' });
    const attempts = env.seen.length;
    env.ctl.refuse = null;
    await new Promise((r) => setTimeout(r, 4 * POLL.intervalMs!));
    expect(env.seen.length).toBe(attempts);
    expect(env.bridge.state).toBe('running');
  });

  it('keeps reading while the sink is still typing, and stops at once without waiting for it', async () => {
    const env = await listening();
    const qid = await ask(env);
    let typing = 0;
    env.sink.inject = () => {
      typing++;
      return new Promise(() => undefined); // a command that never exits
    };
    await env.relay.answerEvent({ questionId: qid, phone: env.phone, options: ['yes'] });
    await wait(() => expect(typing).toBe(1));
    // Polling goes on: a withdrawal or a revocation still arrives while the sink hangs.
    const reads = env.ctl.eventReads.length;
    await wait(() => expect(env.ctl.eventReads.length).toBeGreaterThan(reads + 2));
    const stopped = env.bridge.stop().then(() => 'stopped');
    const late = new Promise((r) => setTimeout(() => r('hung'), 1_000));
    expect(await Promise.race([stopped, late])).toBe('stopped');
  });

  it('declares its features again every few minutes, in case another process replaced them', async () => {
    let now = Date.now();
    const env = await listening({ now: () => now });
    const tickets = () => env.relay.calls.filter((c) => c.path === '/api/v1/socket-ticket').length;
    await wait(() => expect(env.ctl.eventReads.length).toBeGreaterThan(2));
    expect(tickets()).toBe(1);
    now += 5 * 60_000;
    await wait(() => expect(tickets()).toBe(2));
  });

  it('resumes from the stored cursor after a restart, typing only what it had not', async () => {
    const env = await listening();
    const first = await ask(env);
    await env.relay.answerEvent({ questionId: first, phone: env.phone, options: ['yes'] });
    await wait(() => expect(env.sink.typed).toHaveLength(1));
    // The terminal receipt for a second answer is lost in an outage, then the listener restarts.
    const second = await ask(env);
    const orig = (env.client as unknown as { f: typeof fetch }).f;
    (env.client as unknown as { f: typeof fetch }).f = (async (
      i: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(i).includes('/deliveries/terminal')) throw new TypeError('offline');
      return orig(i, init);
    }) as typeof fetch;
    await env.relay.answerEvent({ questionId: second, phone: env.phone, options: ['yes'] });
    await wait(() => expect(env.sink.typed).toHaveLength(2));
    const typedId = (await env.store.getQuestion(second))!.last_injection_id!;
    expect((await env.store.getIntent(typedId))!.state).toBe('typed');
    await env.bridge.stop();
    const cursor = await env.store.getCursor();

    // A third outcome is committed while nothing listens.
    const third = await (async () => {
      const r = await env.bridge.publisher.register(origin(), {
        question: 'And this?',
        options: [{ id: 'yes', label: 'Yes' }],
      });
      await env.bridge.publisher.flush();
      return r.questionId;
    })();
    await env.relay.answerEvent({ questionId: third, phone: env.phone, options: ['yes'] });

    // The same store and terminal (a stdout-like sink keeps no markers), a new process.
    const sink = new FakeSink();
    sink.addPane('pane-1');
    sink.hasMarker = async () => false;
    const client = new RelayClient({
      identity: env.identity,
      fetch: env.relay.fetch,
      sleep: async () => {},
      maxRetries: 0,
    });
    const restarted = new DecisionsBridge({
      identity: env.identity,
      store: env.store,
      sink,
      client,
      policy: new PolicyRegistry(),
      pumpIntervalMs: 0,
    });
    bridges.push(restarted);
    const ctl = control(env, client);
    await restarted.start({ socket: false, poll: POLL });
    await wait(() => expect(sink.typed).toHaveLength(1));
    expect(ctl.eventReads[0]).toBe(cursor);
    expect(sink.typed[0]!.text).toContain(`question_id: ${third}`);
    // The second answer was typed before the restart: it is settled, with its receipt, and never typed again.
    expect((await env.store.getQuestion(second))!.delivery_status).toBe('terminal-delivered');
    expect((await env.store.getIntent(typedId))!.state).toBe('acked');
    await new Promise((r) => setTimeout(r, 3 * POLL.intervalMs!));
    expect(sink.typed).toHaveLength(1);
  });

  it('settles a one-shot sync only once what it read is delivered', async () => {
    const env = await setupBridge();
    bridges.push(env.bridge);
    await env.bridge.start({ socket: false });
    const qid = await ask(env);
    await env.relay.answerEvent({ questionId: qid, phone: env.phone, options: ['yes'] });
    const s = await env.bridge.sync({ settle: true });
    expect(s.outcome).toBe('ok');
    expect(env.sink.typed).toHaveLength(1);
    expect(env.sink.typed[0]!.text).toContain(`question_id: ${qid}`);
  });

  it('cannot be asked to poll and keep a socket at once', async () => {
    const env = await setupBridge();
    bridges.push(env.bridge);
    await expect(env.bridge.start({ poll: POLL })).rejects.toThrow(/socket: false/);
    await expect(env.bridge.start({ socket: true, poll: POLL })).rejects.toThrow(/socket: false/);
    expect(env.bridge.state).toBe('created');
  });
});

describe('the HTTP retry schedule', () => {
  const o = { ...DEFAULT_POLL, rand: () => 0.999 };
  const lo = { ...DEFAULT_POLL, rand: () => 0 };

  it('doubles from 2 s up to a minute, with equal jitter', () => {
    const net = new RelayError('network_error', 'down', 0);
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => retryDelayMs(n, lo, net))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(retryDelayMs(1, o, net)).toBeLessThan(2_000);
    expect(retryDelayMs(20, o, net)).toBeLessThan(60_000);
  });

  it("honours the relay's Retry-After, within reason", () => {
    const limited = (ms: number) =>
      new RelayError('rate_limited', 'slow down', 429, { retryAfterMs: ms });
    expect(retryDelayMs(1, lo, limited(45_000))).toBe(45_000);
    expect(retryDelayMs(1, lo, limited(24 * 3_600_000))).toBe(15 * 60_000);
  });

  it('ignores a Retry-After that is not a positive number', () => {
    const odd = (ms: unknown) =>
      new RelayError('rate_limited', 'slow down', 429, { retryAfterMs: ms as number });
    for (const ms of [Number.NaN, -5, 'soon', 0]) expect(retryDelayMs(1, lo, odd(ms))).toBe(1_000);
  });

  it('records only codes the protocol defines, never free text from the relay', () => {
    expect(syncFailureReason(new RelayError('rate_limited', 'x', 429))).toBe('rate_limited');
    expect(syncFailureReason(new RelayError('network_error', 'x', 0))).toBe('network_error');
    const odd = new RelayError('Ship the release? Answer: yes' as never, 'x', 500);
    expect(syncFailureReason(odd)).toBe('unknown_error');
    expect(syncFailureReason(new RelayError('constructor' as never, 'x', 500))).toBe(
      'unknown_error',
    );
    expect(
      syncFailureReason(new RelayError('not_authenticated', 'unknown or revoked device', 401)),
    ).toBe('device_revoked');
    expect(
      syncFailureReason(new Error('relay returned a page that does not advance the cursor')),
    ).toBe('invalid_page');
  });

  it('is fatal only for a real 426, not a transient failure that says upgrade_required', () => {
    expect(isFatalSyncError(new RelayError('upgrade_required', 'x', 426))).toBe(true);
    expect(isFatalSyncError(new RelayError('upgrade_required', 'x', 503))).toBe(false);
  });

  it('waits minutes after a refused signature', () => {
    const refused = new RelayError('not_authenticated', 'bad signature', 401);
    expect(retryDelayMs(1, lo, refused)).toBe(AUTH_RETRY_MS);
  });
});
