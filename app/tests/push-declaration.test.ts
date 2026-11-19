// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushFeatureGate } from '../src/features/push.js';

const declare = vi.hoisted(() => vi.fn());
vi.mock('../src/features/push.js', async (original) => ({
  ...(await original<typeof import('../src/features/push.js')>()),
  declareAgentStoppedPush: declare,
}));

const { AppController } = await import('../src/app/controller.js');
type Controller = InstanceType<typeof AppController>;

/** The controller's private seams, reached the way its own code reaches them. */
type Inside = { patch(p: { phase: string }): void; relay: unknown };
const inside = (c: Controller) => c as unknown as Inside;

type Gate = PushFeatureGate & { current: () => boolean };
const gateOf = (call: number): Gate => declare.mock.calls[call]![2] as Gate;

const relay = { json: vi.fn() };
const reg = Object.assign(new EventTarget(), { waiting: null, installing: null });
let container: EventTarget & { controller: null };

function info(features: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ voice: { xai: false, openai: false }, features }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

const pair = (c: Controller) => {
  inside(c).relay = relay;
  inside(c).patch({ phase: 'ready' });
  // What boot does once the pairing is ready.
  c.declarePushFeatures();
};
const registerWorker = (c: Controller) =>
  c.setServiceWorker(reg as unknown as ServiceWorkerRegistration);
const answerInfo = (c: Controller) => c.ensureInfo();
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  declare.mockReset();
  declare.mockResolvedValue(true);
  container = Object.assign(new EventTarget(), { controller: null });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  info(['agent-stopped-push-v1']);
});
afterEach(() => vi.unstubAllGlobals());

describe('declaring the agent-stopped push on an app updated in place', () => {
  it('declares once the pairing, the relay answer and the worker are all in, whichever comes last', async () => {
    const steps = { pair, registerWorker, answerInfo };
    for (const last of Object.keys(steps) as (keyof typeof steps)[]) {
      declare.mockClear();
      const c = new AppController('https://relay.example');
      for (const [name, step] of Object.entries(steps)) if (name !== last) await step(c);
      expect(declare, `before ${last}`).not.toHaveBeenCalled();
      await steps[last](c);
      expect(declare, `after ${last}`).toHaveBeenCalledOnce();
      expect(declare.mock.calls[0]![0]).toBe(relay);
      expect(declare.mock.calls[0]![1]).toBe(reg);
      expect(gateOf(0).served()).toBe(true);
    }
  });

  it('never declares to a relay that does not serve it', async () => {
    info(['presence-v1']);
    const c = new AppController('https://relay.example');
    pair(c);
    registerWorker(c);
    await answerInfo(c);
    c.declarePushFeatures();
    expect(declare).not.toHaveBeenCalled();
  });

  it('asks again each time a worker takes over the page', async () => {
    const c = new AppController('https://relay.example');
    await answerInfo(c);
    pair(c);
    registerWorker(c);
    await vi.waitFor(() => expect(declare).toHaveBeenCalledOnce());
    for (const times of [2, 3]) {
      await settle();
      container.dispatchEvent(new Event('controllerchange'));
      await vi.waitFor(() => expect(declare).toHaveBeenCalledTimes(times));
    }
  });

  it.each(['resolves', 'rejects'])(
    'runs one pass at a time, and requests during one that %s get exactly one more',
    async (outcome) => {
      let finish!: () => void;
      declare.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve, reject) => {
            finish = () => (outcome === 'resolves' ? resolve(false) : reject(new Error('offline')));
          }),
      );
      const c = new AppController('https://relay.example');
      await answerInfo(c);
      pair(c);
      registerWorker(c);
      expect(declare).toHaveBeenCalledOnce();
      c.declarePushFeatures();
      c.declarePushFeatures();
      expect(declare).toHaveBeenCalledOnce();
      finish();
      await vi.waitFor(() => expect(declare).toHaveBeenCalledTimes(2));
      await settle();
      await settle();
      expect(declare).toHaveBeenCalledTimes(2);
    },
  );

  it('a pass outlived by its pairing or its worker registration is no longer current', async () => {
    const c = new AppController('https://relay.example');
    await answerInfo(c);
    pair(c);
    registerWorker(c);
    await vi.waitFor(() => expect(declare).toHaveBeenCalledOnce());
    expect(gateOf(0).current()).toBe(true);
    // Paired again: the relay client is a new one while the app stays ready.
    inside(c).relay = { json: vi.fn() };
    expect(gateOf(0).current()).toBe(false);
    inside(c).relay = relay;
    expect(gateOf(0).current()).toBe(true);
    await settle();
    c.setServiceWorker(
      Object.assign(new EventTarget(), {
        waiting: null,
        installing: null,
      }) as unknown as ServiceWorkerRegistration,
    );
    expect(gateOf(0).current()).toBe(false);
    inside(c).patch({ phase: 'unpaired' });
    expect(gateOf(1).current()).toBe(false);
  });

  it("gives the Settings tap a gate that reads the relay's answer and the pairing live", async () => {
    const c = new AppController('https://relay.example');
    pair(c);
    const gate = c.pushFeatureGate();
    expect(gate.served()).toBe(false);
    await answerInfo(c);
    expect(gate.served()).toBe(true);
    expect(gate.current!()).toBe(true);
    inside(c).patch({ phase: 'revoked' });
    expect(gate.current!()).toBe(false);
  });
});
