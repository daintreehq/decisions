import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicUnavailableError, startMic } from '../src/features/voice/capture.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A browser audio stack where any one step can fail, counting what was released. */
function browser(
  fail: { ctor?: boolean; resume?: boolean; node?: boolean } = {},
  grant?: Promise<void>,
  stall: { addModule?: Promise<void>; resume?: Promise<void> } = {},
) {
  const released = { tracks: 0, closed: 0, contexts: 0 };
  const tracks = [{ stop: () => void released.tracks++ }, { stop: () => void released.tracks++ }];
  const stream = { getTracks: () => tracks };
  class Ctx {
    state = 'suspended';
    destination = {};
    audioWorklet = { addModule: async () => void (await stall.addModule) };
    constructor() {
      if (fail.ctor) throw new Error('AudioContext unavailable');
      released.contexts++;
    }
    resume = async () => {
      await stall.resume;
      if (fail.resume) throw new Error('resume refused');
      this.state = 'running';
    };
    close = async () => void released.closed++;
    createMediaStreamSource = () => ({ connect: (n: unknown) => n, disconnect: () => undefined });
    createGain = () => ({ gain: { value: 1 }, connect: (n: unknown) => n });
  }
  class Node {
    port = { onmessage: null };
    constructor() {
      if (fail.node) throw new Error('node failed');
    }
    connect = (n: unknown) => n;
    disconnect = () => undefined;
  }
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        await grant;
        return stream;
      },
    },
  });
  vi.stubGlobal('window', { AudioContext: Ctx });
  vi.stubGlobal('AudioWorkletNode', Node);
  return released;
}

afterEach(() => vi.unstubAllGlobals());

describe('microphone setup releases the microphone on every failure after permission', () => {
  it('a rejected resume() stops every track and closes the context', async () => {
    const r = browser({ resume: true });
    await expect(startMic(() => undefined)).rejects.toBeInstanceOf(MicUnavailableError);
    expect(r.tracks).toBe(2);
    expect(r.closed).toBe(1);
  });

  it('a failing AudioContext constructor stops every track', async () => {
    const r = browser({ ctor: true });
    await expect(startMic(() => undefined)).rejects.toBeInstanceOf(MicUnavailableError);
    expect(r.tracks).toBe(2);
  });

  it('a failed node creation stops every track and closes the context', async () => {
    const r = browser({ node: true });
    await expect(startMic(() => undefined)).rejects.toBeInstanceOf(MicUnavailableError);
    expect(r.tracks).toBe(2);
    expect(r.closed).toBe(1);
  });

  it('a permission granted after cancellation releases its tracks before any further setup', async () => {
    const grant = deferred<void>();
    const r = browser({}, grant.promise);
    const ctl = new AbortController();
    const p = startMic(() => undefined, undefined, ctl.signal);
    ctl.abort();
    grant.resolve();
    await expect(p).rejects.toThrow();
    expect(r.tracks).toBe(2);
    expect(r.contexts).toBe(0);
  });

  it('a successful start keeps the tracks until stop()', async () => {
    const r = browser();
    const c = await startMic(() => undefined);
    expect(r.tracks).toBe(0);
    c.stop();
    expect(r.tracks).toBe(2);
    expect(r.closed).toBe(1);
  });

  for (const step of ['addModule', 'resume'] as const) {
    it(`cancelling while ${step}() stalls releases the microphone at once, and only once`, async () => {
      const hang = deferred<void>();
      const r = browser({}, undefined, { [step]: hang.promise });
      const ctl = new AbortController();
      const p = startMic(() => undefined, undefined, ctl.signal);
      p.catch(() => undefined);
      // Let permission and the context come up, then setup waits on the stalled step.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(r.contexts).toBe(1);
      expect(r.tracks).toBe(0);
      ctl.abort();
      expect(r.tracks).toBe(2);
      await Promise.resolve();
      expect(r.closed).toBe(1);
      // The step finally finishes: setup sees the abort, and nothing is released twice.
      hang.resolve();
      await expect(p).rejects.toBeInstanceOf(MicUnavailableError);
      expect(r.tracks).toBe(2);
      expect(r.closed).toBe(1);
    });
  }
});
