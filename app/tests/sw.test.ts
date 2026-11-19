import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** The service worker's handlers, registered on a stand-in for its global scope. */
const handlers = new Map<string, (event: unknown) => void>();
const showNotification = vi.fn(async (_title: string, _options: NotificationOptions) => undefined);
const openWindow = vi.fn(async (_url: string) => null);

beforeAll(async () => {
  vi.stubGlobal('__PRECACHE__', []);
  vi.stubGlobal('__BUILD_ID__', 'test');
  vi.stubGlobal('self', {
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      handlers.set(type, handler),
    registration: { showNotification },
    clients: { matchAll: async () => [], openWindow },
    location: { origin: 'https://relay.example' },
    skipWaiting: vi.fn(async () => undefined),
  });
  // The worker builds on its own (tsconfig.sw.json), so it is loaded by path, not typed into this program.
  const worker = '../src/sw.ts';
  await import(/* @vite-ignore */ worker);
});
afterAll(() => vi.unstubAllGlobals());

/** Dispatch an event to the worker and wait for the work it hands to `waitUntil`. */
async function dispatch(type: string, event: object) {
  const work: Promise<unknown>[] = [];
  handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => work.push(p) });
  await Promise.all(work);
}

describe('the service worker', () => {
  it('says it can show an agent-stopped push when the page asks', async () => {
    const { port1, port2 } = new MessageChannel();
    const reply = new Promise((resolve) => (port1.onmessage = (e) => resolve(e.data)));
    await dispatch('message', { data: { type: 'FEATURES' }, ports: [port2] });
    expect(await reply).toEqual({ features: ['agent-stopped-push-v1'] });
    port1.close();
  });

  it('shows agent-stopped pushes as one replaceable notification that opens the question list', async () => {
    const push = { data: { json: () => ({ type: 'agent-stopped' }) } };
    await dispatch('push', push);
    await dispatch('push', push);
    expect(showNotification).toHaveBeenCalledTimes(2);
    for (const [title, options] of showNotification.mock.calls) {
      expect(title).toBe('Daintree Decisions');
      expect(options).toMatchObject({
        body: 'An agent stopped',
        tag: 'agent-stopped',
        renotify: true,
        data: { url: '/' },
      });
    }
    const [, shown] = showNotification.mock.calls[0]!;
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: shown.data } });
    expect(openWindow).toHaveBeenCalledWith('/');
  });
});
