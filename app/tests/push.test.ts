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
function fakeWorker(reply: Reply | null) {
  return {
    state: 'activated',
    postMessage: vi.fn((msg: { type?: string }, transfer: MessagePort[]) => {
      if (msg?.type === 'FEATURES' && reply) reply(transfer[0]!);
    }),
  };
}
const canShow: Reply = (port) => port.postMessage({ features: ['agent-stopped-push-v1'] });
/** An older build: its message handler knows only SKIP_WAITING. */
const stale = () => fakeWorker(null);

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

const served = { served: () => true, timeoutMs: 20 };
const notServed = { served: () => false, timeoutMs: 20 };
const asReg = () => reg as unknown as ServiceWorkerRegistration;

function relayListing(subscriptions: unknown[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const relay = {
    json: vi.fn(async (method: string, path: string, opts: { body?: unknown } = {}) => {
      calls.push({ method, path, body: opts.body });
      if (path === '/push/config') return { vapid_public_key: VAPID };
      if (path === '/push/subscriptions' && method === 'GET') return { subscriptions };
      return {};
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
const posted = (calls: { method: string; body?: unknown }[]) =>
  calls.filter((c) => c.method === 'POST').map((c) => c.body as Record<string, unknown>);

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
      expect.objectContaining({
        endpoint: 'https://fcm.example/old',
        features: ['agent-stopped-push-v1'],
      }),
    ]);
  });

  it('declares nothing while a newer worker that could show it waits behind a stale active one', async () => {
    reg.active = stale();
    reg.waiting = fakeWorker(canShow);
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    await enablePush(relay, served);
    const [body] = posted(calls);
    expect(body).toMatchObject({ endpoint: 'https://fcm.example/old' });
    expect(Object.hasOwn(body!, 'features')).toBe(false);
    expect(reg.active.postMessage).toHaveBeenCalledOnce();
    expect(reg.waiting.postMessage).not.toHaveBeenCalled();
  });

  it('never sends the declaration to a relay that does not serve it', async () => {
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    await enablePush(relay, notServed);
    expect(Object.hasOwn(posted(calls)[0]!, 'features')).toBe(false);
    expect(reg.active!.postMessage).not.toHaveBeenCalled();
  });

  it('reads whether the relay serves it again just before sending', async () => {
    let serves = true;
    reg.active = fakeWorker((port) => {
      serves = false;
      canShow(port);
    });
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    await enablePush(relay, { served: () => serves, timeoutMs: 20 });
    expect(Object.hasOwn(posted(calls)[0]!, 'features')).toBe(false);
  });

  it('declares nothing for a worker that answers wrongly, late, not at all, or is replaced', async () => {
    const cases: (() => void)[] = [
      () => (reg.active = null),
      () =>
        (reg.active = fakeWorker((port) =>
          port.postMessage({ features: 'agent-stopped-push-v1' }),
        )),
      () => (reg.active = fakeWorker((port) => port.postMessage({ features: ['presence-v1'] }))),
      () => (reg.active = fakeWorker((port) => setTimeout(() => canShow(port), 60))),
      () => {
        const w = fakeWorker(null);
        w.postMessage.mockImplementation(() => {
          throw new DOMException('gone', 'InvalidStateError');
        });
        reg.active = w;
      },
      // It said yes, then a newer worker took its place before the subscription was sent.
      () =>
        (reg.active = fakeWorker((port) => {
          canShow(port);
          reg.active = stale();
        })),
    ];
    for (const arrange of cases) {
      arrange();
      const { relay, calls } = relayListing([row(ROW, true, null)]);
      await enablePush(relay, served);
      const [body] = posted(calls);
      expect(body).toMatchObject({ endpoint: 'https://fcm.example/old' });
      expect(Object.hasOwn(body!, 'features')).toBe(false);
    }
  });
});

describe('declaring the agent-stopped push for an app updated in place', () => {
  it('declares the existing subscription without asking for permission or replacing anything', async () => {
    const old = current!;
    const { relay, calls } = relayListing([row(ROW, true, null, [])]);
    expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(true);
    expect(posted(calls)).toEqual([
      {
        protocol_version: PROTOCOL_VERSION,
        endpoint: 'https://fcm.example/old',
        p256dh: 'p256dh-https://fcm.example/old',
        auth: 'auth-https://fcm.example/old',
        features: ['agent-stopped-push-v1'],
      },
    ]);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(old.unsubscribe).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('leaves it unmarked while the active worker is stale, even with a capable one waiting', async () => {
    reg.active = stale();
    reg.waiting = fakeWorker(canShow);
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(false);
    expect(posted(calls)).toEqual([]);
    expect(reg.waiting.postMessage).not.toHaveBeenCalled();
  });

  it('never asks a relay that does not serve it', async () => {
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    expect(await declareAgentStoppedPush(relay, asReg(), notServed)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('never turns a dead endpoint back on', async () => {
    // Rows name no endpoint, so the dead one may be this browser's own.
    const { relay, calls } = relayListing([
      row(ROW, true, null),
      row('01a19d9d9d477fca9bffc5c8097bf9a4', false, 'gone'),
    ]);
    expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(false);
    expect(posted(calls)).toEqual([]);
  });

  it('sends nothing once a row declares it, so a stray undeclared row never costs a send per launch', async () => {
    const { relay, calls } = relayListing([
      row(ROW, true, null, ['agent-stopped-push-v1']),
      row('01a19d9d9d477fca9bffc5c8097bf9a4', true, null, []),
    ]);
    expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(false);
    expect(posted(calls)).toEqual([]);
  });

  it('sends nothing without permission, a subscription or a relay row', async () => {
    const tries: [() => void, unknown[]][] = [
      [
        () => vi.stubGlobal('Notification', { permission: 'denied', requestPermission }),
        [row(ROW, true, null)],
      ],
      [() => (current = null), [row(ROW, true, null)]],
      [() => undefined, []],
    ];
    for (const [arrange, rows] of tries) {
      arrange();
      const { relay, calls } = relayListing(rows);
      expect(await declareAgentStoppedPush(relay, asReg(), served)).toBe(false);
      expect(posted(calls)).toEqual([]);
    }
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('drops the declaration when the pairing ended while the worker was asked', async () => {
    let paired = true;
    reg.active = fakeWorker((port) => {
      paired = false;
      canShow(port);
    });
    const { relay, calls } = relayListing([row(ROW, true, null)]);
    expect(
      await declareAgentStoppedPush(relay, asReg(), { ...served, current: () => paired }),
    ).toBe(false);
    expect(posted(calls)).toEqual([]);
  });
});
