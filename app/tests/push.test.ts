import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enablePush, pushIsOn } from '../src/features/push.js';
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

beforeEach(() => {
  current = fakeSubscription('https://fcm.example/old');
  subscribe.mockClear();
  vi.stubGlobal('Notification', { requestPermission: async () => 'granted' });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { getSubscription: async () => current, subscribe },
      }),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

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

const row = (id: string, enabled: boolean, last_error_code: string | null) => ({
  subscription_id: id,
  device_id: '01a19d9d7d5c7b7c84adf34e49bcccd3',
  created_at: '2026-11-02T10:00:00.000Z',
  last_success_at: null,
  last_error_code,
  enabled,
});

describe('turning notifications on', () => {
  it('keeps a subscription the push service still has', async () => {
    const old = current!;
    const { relay, calls } = relayListing([row('01a19d9d9d477fca9bffc5c8097bf9a3', true, null)]);
    await enablePush(relay);
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
    await enablePush(relay);
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
