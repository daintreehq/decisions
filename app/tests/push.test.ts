import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { declareAgentStoppedPush, enablePush, pushIsOn } from '../src/features/push.js';
import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import type { Relay } from '../src/data/relay.js';

const VAPID = 'BPx7z0p6bW3m2vYc8yQ1kQ';

function fakeSubscription(endpoint: string) {
  return {
    endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` } }),
    getKey: () => null,
  };
}

let current: ReturnType<typeof fakeSubscription> | null;
const subscribe = vi.fn(async () => (current = fakeSubscription('https://fcm.example/fresh')));
const requestPermission = vi.fn(async () => 'granted');

type Reply = (port: MessagePort) => void;
/** A service worker that answers the page's features request with `reply`, or never answers when it is null. */
function fakeWorker(reply: Reply | null, state: ServiceWorkerState = 'activated') {
  return {
    state,
    postMessage: vi.fn((msg: { type?: string }, transfer: MessagePort[]) => {
      if (msg?.type === 'FEATURES' && reply) reply(transfer[0]!);
    }),
  };
}
const canShow: Reply = (port) => port.postMessage({ features: ['agent-stopped-push-v1'] });
/** An older build: its message handler knows only SKIP_WAITING. */
const stale = () => fakeWorker(null);
/** A newer build installed behind the active worker: no push reaches it until it activates. */
const waitingUpdate = () => fakeWorker(canShow, 'installed');

let reg: {
  active: ReturnType<typeof fakeWorker> | null;
  waiting: ReturnType<typeof fakeWorker> | null;
  pushManager: { getSubscription: () => Promise<unknown>; subscribe: typeof subscribe };
};

beforeEach(() => {
  current = fakeSubscription('https://fcm.example/old');
  subscribe.mockClear();
  requestPermission.mockClear();
  reg = {
    active: fakeWorker(canShow),
    waiting: null,
    pushManager: { getSubscription: async () => current, subscribe },
  };
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve(reg) },
  });
});
afterEach(() => vi.unstubAllGlobals());

// A worker that answers has time to; one that never will is given up on quickly.
const served = { served: () => true, timeoutMs: 1_000 };
const servedSilent = { served: () => true, timeoutMs: 20 };
const notServed = { served: () => false, timeoutMs: 1_000 };
const asReg = () => reg as unknown as ServiceWorkerRegistration;

/** A relay with these rows that answers only the push routes; `listed` can hold the rows' answer open. */
function relayListing(
  subscriptions: unknown[],
  listed: () => Promise<void> | void = () => undefined,
) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const relay = {
    json: vi.fn(async (method: string, path: string, opts: { body?: unknown } = {}) => {
      calls.push({ method, path, body: opts.body });
      if (method === 'GET' && path === '/push/config') return { vapid_public_key: VAPID };
      if (method === 'GET' && path === '/push/subscriptions') {
        await listed();
        return { subscriptions };
      }
      if (method === 'POST' && path === '/push/subscriptions') return {};
      if (method === 'DELETE' && path.startsWith('/push/subscriptions/')) return { ok: true };
      throw new Error(`unexpected ${method} ${path}`);
    }),
  } as unknown as Relay;
  return { relay, calls };
}

const row = (
  id: string,
  enabled: boolean,
  last_error_code: string | null,
  features?: string[],
) => ({
  subscription_id: id,
  device_id: '01a19d9d7d5c7b7c84adf34e49bcccd3',
  created_at: '2026-11-02T10:00:00.000Z',
  last_success_at: null,
  last_error_code,
  enabled,
  ...(features ? { features } : {}),
});
const ROW = '01a19d9d9d477fca9bffc5c8097bf9a3';
const OTHER = '01a19d9d9d477fca9bffc5c8097bf9a4';
const DECLARED = ['agent-stopped-push-v1'];
const posted = (calls: { method: string; body?: unknown }[]) =>
  calls.filter((c) => c.method === 'POST').map((c) => c.body as Record<string, unknown>);
const declares = (body: Record<string, unknown> | undefined) => Object.hasOwn(body!, 'features');

describe('turning notifications on', () => {
  it('keeps a subscription the push service still has', async () => {
    const old = current!;
    const { relay, calls } = relayListing([row('01a19d9d9d477fca9bffc5c8097bf9a3', true, null)]);
    await enablePush(relay, notServed);
    expect(old.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      endpoint: 'https://fcm.example/old',
    });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('replaces one the push service said is gone, and drops the dead row', async () => {
    const old = current!;
    const { relay, calls } = relayListing([row('01a19d9d9d477fca9bffc5c8097bf9a3', false, 'gone')]);
    await enablePush(relay, notServed);
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      endpoint: 'https://fcm.example/fresh',
    });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/push/subscriptions/01a19d9d9d477fca9bffc5c8097bf9a3',
    ]);
  });
});

describe('whether notifications are on', () => {
  it("is off when the relay no longer sends to any of the phone's subscriptions", async () => {
    const live = relayListing([row('01a19d9d9d477fca9bffc5c8097bf9a3', true, null)]).relay;
    const dead = relayListing([row('01a19d9d9d477fca9bffc5c8097bf9a3', false, 'gone')]).relay;
    expect(await pushIsOn(live)).toBe(true);
    expect(await pushIsOn(dead)).toBe(false);
    current = null;
    expect(await pushIsOn(live)).toBe(false);
  });
});

describe('declaring the agent-stopped push when notifications are turned on', () => {
  it('declares it when the relay serves it and the active worker can show one', async () => {
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    await enablePush(relay, served);
    expect(posted(calls)).toEqual([
      expect.objectContaining({ endpoint: 'https://fcm.example/old', features: DECLARED }),
    ]);
  });

  it('declares nothing while a newer worker that could show it waits behind a stale active one', async () => {
    reg.active = stale();
    reg.waiting = waitingUpdate();
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    await enablePush(relay, servedSilent);
    const [body] = posted(calls);
    expect(body).toMatchObject({ endpoint: 'https://fcm.example/old' });
    expect(declares(body)).toBe(false);
    expect(reg.active.postMessage).toHaveBeenCalledOnce();
    expect(reg.waiting.postMessage).not.toHaveBeenCalled();
  });

  it('declares it for a capable active worker while an update waits', async () => {
    reg.waiting = waitingUpdate();
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    await enablePush(relay, served);
    expect(posted(calls)[0]).toMatchObject({ features: DECLARED });
    expect(reg.waiting.postMessage).not.toHaveBeenCalled();
  });

  it('never sends the declaration to a relay that does not serve it', async () => {
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    await enablePush(relay, notServed);
    expect(declares(posted(calls)[0])).toBe(false);
    expect(reg.active!.postMessage).not.toHaveBeenCalled();
  });

  it('reads whether the relay serves it again after the worker answers', async () => {
    let port: MessagePort | undefined;
    reg.active = fakeWorker((p) => (port = p));
    let serves = true;
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    const done = enablePush(relay, { served: () => serves, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(port).toBeDefined());
    serves = false;
    canShow(port!);
    await done;
    expect(declares(posted(calls)[0])).toBe(false);
  });

  it.each<[string, () => void, typeof served]>([
    ['there is no active worker', () => (reg.active = null), served],
    [
      'the answer is malformed',
      () => (reg.active = fakeWorker((port) => port.postMessage({ features: DECLARED[0] }))),
      served,
    ],
    [
      'the worker shows something else',
      () => (reg.active = fakeWorker((port) => port.postMessage({ features: ['presence-v1'] }))),
      served,
    ],
    ['the worker never answers', () => (reg.active = stale()), servedSilent],
    [
      'the answer comes too late',
      () => (reg.active = fakeWorker((port) => setTimeout(() => canShow(port), 60))),
      servedSilent,
    ],
    [
      'the worker cannot be messaged',
      () => {
        const w = fakeWorker(null);
        w.postMessage.mockImplementation(() => {
          throw new DOMException('gone', 'InvalidStateError');
        });
        reg.active = w;
      },
      served,
    ],
    [
      'a newer worker took its place after it answered',
      () =>
        (reg.active = fakeWorker((port) => {
          canShow(port);
          reg.active = stale();
        })),
      served,
    ],
  ])('declares nothing when %s', async (_, arrange, gate) => {
    arrange();
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    await enablePush(relay, gate);
    const [body] = posted(calls);
    expect(body).toMatchObject({ endpoint: 'https://fcm.example/old' });
    expect(declares(body)).toBe(false);
  });

  it('sends nothing for a pairing that ended while the worker was asked', async () => {
    let paired = true;
    reg.active = fakeWorker((port) => {
      paired = false;
      canShow(port);
    });
    const { relay, calls } = relayListing([row(ROW, false, 'gone')]);
    await enablePush(relay, { ...served, current: () => paired });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('declaring the agent-stopped push for an app updated in place', () => {
  it.each([
    ['an empty list', []],
    ['no list', undefined],
  ])(
    'declares the existing subscription whose row has %s, asking for and replacing nothing',
    async (_, features) => {
      const old = current!;
      const { relay, calls } = relayListing([row(ROW, true, null, features)]);
      expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(true);
      expect(posted(calls)).toEqual([
        {
          protocol_version: PROTOCOL_VERSION,
          endpoint: 'https://fcm.example/old',
          p256dh: 'p256dh-https://fcm.example/old',
          auth: 'auth-https://fcm.example/old',
          features: DECLARED,
        },
      ]);
      expect(requestPermission).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(old.unsubscribe).not.toHaveBeenCalled();
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    },
  );

  it('asks the worker before reading the rows, so the rows it sends on are fresh', async () => {
    const { relay } = relayListing([row(ROW, true, null)]);
    expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(true);
    const asked = reg.active!.postMessage.mock.invocationCallOrder[0]!;
    const json = vi.mocked(relay.json).mock;
    const listed = json.invocationCallOrder[json.calls.findIndex(([m]) => m === 'GET')]!;
    expect(asked).toBeLessThan(listed);
  });

  it('leaves it unmarked while the active worker is stale, even with a capable one waiting', async () => {
    reg.active = stale();
    reg.waiting = waitingUpdate();
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    expect(await declareAgentStoppedPush(relay, asReg(), servedSilent)).toBe(false);
    expect(posted(calls)).toEqual([]);
    expect(reg.active.postMessage).toHaveBeenCalledOnce();
    expect(reg.waiting.postMessage).not.toHaveBeenCalled();
  });

  it('declares it for a capable active worker while an update waits', async () => {
    reg.waiting = waitingUpdate();
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(true);
    expect(posted(calls)[0]).toMatchObject({ features: DECLARED });
  });

  it('never asks a relay that does not serve it', async () => {
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    expect(await declareAgentStoppedPush(relay, asReg(), notServed)).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([
    ['gone', 'gone'],
    ['disabled for another reason', null],
  ])('never turns a dead endpoint back on: a row %s', async (_, code) => {
    // Rows name no endpoint, so the dead one may be this browser's own.
    const { relay, calls } = relayListing([row(ROW, true, null), row(OTHER, false, code)]);
    expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(false);
    expect(posted(calls)).toEqual([]);
  });

  it('sends nothing once every row declares it', async () => {
    const { relay, calls } = relayListing([
      row(ROW, true, null, DECLARED),
      row(OTHER, true, null, DECLARED),
    ]);
    expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(false);
    expect(posted(calls)).toEqual([]);
  });

  it('declares beside a row left declared by notifications turned off and on again', async () => {
    const { relay, calls } = relayListing([
      row(ROW, true, null, DECLARED),
      row(OTHER, true, null, []),
    ]);
    expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(true);
    expect(posted(calls)).toEqual([expect.objectContaining({ features: DECLARED })]);
  });

  it.each<{
    name: string;
    arrange: () => void;
    rows: unknown[];
    /** Whether it reads the relay's rows before stopping. */
    lists: boolean;
    paired?: boolean;
  }>([
    {
      name: 'without permission',
      arrange: () => vi.stubGlobal('Notification', { permission: 'denied', requestPermission }),
      rows: [row(ROW, true, null)],
      lists: false,
    },
    {
      name: 'without a browser subscription',
      arrange: () => (current = null),
      rows: [row(ROW, true, null)],
      lists: false,
    },
    {
      name: 'for a pairing already ended',
      arrange: () => undefined,
      rows: [row(ROW, true, null)],
      lists: false,
      paired: false,
    },
    { name: 'with no relay row', arrange: () => undefined, rows: [], lists: true },
  ])('sends nothing $name', async ({ arrange, rows, lists, paired = true }) => {
    arrange();
    const { relay, calls } = relayListing(rows);
    const gate = { ...served, current: () => paired };
    expect(await declareAgentStoppedPush(relay, asReg(), gate)).toBe(false);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      lists ? ['GET /push/subscriptions'] : [],
    );
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it.each([
    ['the pairing ends', (s: { paired: boolean }) => (s.paired = false)],
    ['the relay stops serving it', (s: { serves: boolean }) => (s.serves = false)],
    [
      'permission is revoked',
      () => vi.stubGlobal('Notification', { permission: 'denied', requestPermission }),
    ],
    ['the subscription is replaced', () => (current = fakeSubscription('https://fcm.example/new'))],
    ['the subscription is removed', () => (current = null)],
    ['a newer worker takes over', () => (reg.active = stale())],
  ])('sends nothing when %s while the rows are read', async (_, change) => {
    const s = { paired: true, serves: true };
    let release: (() => void) | undefined;
    const { relay, calls } = relayListing(
      [row(ROW, true, null)],
      () => new Promise<void>((r) => (release = r)),
    );
    const result = declareAgentStoppedPush(relay, asReg(), {
      served: () => s.serves,
      current: () => s.paired,
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    change(s as never);
    release!();
    expect(await result).toBe(false);
    expect(posted(calls)).toEqual([]);
  });
});
