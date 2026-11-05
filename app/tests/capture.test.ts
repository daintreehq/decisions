import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIC_FRAME_TIMEOUT_MS,
  MIC_SETUP_TIMEOUT_MS,
  MicUnavailableError,
  startMic,
} from '../src/features/voice/capture.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

/** A browser audio stack with a real startup/frame lifecycle and controllable browser failures. */
function browser(
  fail: {
    ctor?: boolean;
    resume?: boolean;
    node?: boolean;
    frames?: boolean;
    interrupted?: boolean;
  } = {},
  grant?: Promise<void>,
  stall: { addModule?: Promise<void>; resume?: Promise<void> } = {},
) {
  const released = { tracks: 0, closed: 0, contexts: 0 };
  const tracks = [0, 1].map(() => ({
    stop: () => void released.tracks++,
    onended: null as null | (() => void),
  }));
  const stream = { getTracks: () => tracks };
  let context!: Ctx;
  let node!: Node;
  class Ctx {
    state = fail.interrupted ? 'interrupted' : 'suspended';
    onstatechange: null | (() => void) = null;
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => void (await stall.addModule)) };
    constructor() {
      if (fail.ctor) throw new Error('AudioContext unavailable');
      context = this;
      released.contexts++;
    }
    resume = vi.fn(async () => {
      await stall.resume;
      if (fail.resume) throw new Error('resume refused');
      this.state = 'running';
    });
    close = async () => void released.closed++;
    createMediaStreamSource = () => ({ connect: (n: unknown) => n, disconnect: () => undefined });
    createGain = () => ({ gain: { value: 1 }, connect: (n: unknown) => n });
  }
  const frame = () => node.port.onmessage?.({ data: { pcm: new ArrayBuffer(3200), rms: 0 } });
  class Node {
    port = { onmessage: null as null | ((e: { data: { pcm: ArrayBuffer; rms: number } }) => void) };
    onprocessorerror: null | (() => void) = null;
    constructor() {
      if (fail.node) throw new Error('node failed');
      node = this;
    }
    connect(n: unknown) {
      if (!fail.frames) void Promise.resolve().then(frame);
      return n;
    }
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
  return {
    released,
    get context() {
      return context;
    },
    get node() {
      return node;
    },
    tracks,
    frame,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('microphone lifecycle', () => {
  for (const failure of ['ctor', 'resume', 'node'] as const) {
    it(`cleans up a failed ${failure}`, async () => {
      const t = browser({ [failure]: true });
      await expect(startMic(() => undefined)).rejects.toBeInstanceOf(MicUnavailableError);
      expect(t.released.tracks).toBe(failure === 'ctor' ? 0 : 2);
      expect(t.released.closed).toBe(failure === 'ctor' ? 0 : 1);
    });
  }

  it('unlocks audio before awaiting permission, and closes a grant that arrives after cancel', async () => {
    const grant = deferred<void>();
    const t = browser({}, grant.promise);
    const ctl = new AbortController();
    const p = startMic(() => undefined, undefined, ctl.signal);
    expect(t.context.resume).toHaveBeenCalledTimes(1);
    ctl.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(t.released.closed).toBe(1);
    expect(t.context.audioWorklet.addModule).not.toHaveBeenCalled();
    grant.resolve();
    await flush();
    expect(t.released.tracks).toBe(2);
  });

  it('keeps successful capture until stop, and releases only once', async () => {
    const t = browser();
    const onFrame = vi.fn();
    const c = await startMic(onFrame);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(t.released.tracks).toBe(0);
    c.stop();
    c.stop();
    expect(t.released).toEqual({ tracks: 2, closed: 1, contexts: 1 });
  });

  for (const step of ['addModule', 'resume'] as const) {
    it(`settles cancellation immediately while ${step} stalls`, async () => {
      const hang = deferred<void>();
      const t = browser({}, undefined, { [step]: hang.promise });
      const ctl = new AbortController();
      const p = startMic(() => undefined, undefined, ctl.signal);
      await flush();
      ctl.abort();
      // This must settle before the browser's hanging promise resolves.
      await expect(p).rejects.toBeInstanceOf(MicUnavailableError);
      expect(t.released.tracks).toBe(2);
      hang.resolve();
      await flush();
      expect(t.released.closed).toBe(1);
    });

    it(`times out ${step} even if the transcription provider is already ready`, async () => {
      vi.useFakeTimers();
      const t = browser({}, undefined, { [step]: new Promise(() => undefined) });
      const result = startMic(() => undefined).catch((e) => e);
      await vi.advanceTimersByTimeAsync(MIC_SETUP_TIMEOUT_MS);
      expect(await result).toBeInstanceOf(MicUnavailableError);
      expect(t.released.tracks).toBe(2);
      expect(t.released.closed).toBe(1);
    });
  }

  it('allows time to answer permission without spending the audio setup deadline', async () => {
    vi.useFakeTimers();
    const grant = deferred<void>();
    const t = browser({}, grant.promise);
    const p = startMic(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.released.closed).toBe(0);
    grant.resolve();
    const c = await p;
    c.stop();
  });

  it('times out if the worklet starts but never delivers a frame', async () => {
    vi.useFakeTimers();
    const t = browser({ frames: true });
    const result = startMic(() => undefined).catch((e) => e);
    await vi.advanceTimersByTimeAsync(MIC_SETUP_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(MicUnavailableError);
    expect(t.released.tracks).toBe(2);
  });

  it('resumes an interrupted context during startup and after capture begins', async () => {
    const t = browser({ interrupted: true });
    const failed = vi.fn();
    const c = await startMic(() => undefined, undefined, undefined, failed);
    expect(t.context.state).toBe('running');
    const before = t.context.resume.mock.calls.length;
    t.context.state = 'interrupted';
    t.context.onstatechange?.();
    await flush();
    expect(t.context.resume).toHaveBeenCalledTimes(before + 1);
    expect(t.context.state).toBe('running');
    expect(failed).not.toHaveBeenCalled();
    c.stop();
  });

  it('reports stalled audio once and frees the microphone, even if the context claims to be running', async () => {
    vi.useFakeTimers();
    const t = browser();
    const failed = vi.fn();
    const c = await startMic(() => undefined, undefined, undefined, failed);
    await vi.advanceTimersByTimeAsync(MIC_FRAME_TIMEOUT_MS);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(t.released.tracks).toBe(2);
    await vi.advanceTimersByTimeAsync(MIC_FRAME_TIMEOUT_MS);
    expect(failed).toHaveBeenCalledTimes(1);
    c.stop();
    expect(t.released.closed).toBe(1);
  });

  for (const cause of ['ended', 'processor'] as const) {
    it(`reports ${cause} failure and detaches every callback on stop`, async () => {
      const t = browser();
      const failed = vi.fn();
      const c = await startMic(() => undefined, undefined, undefined, failed);
      if (cause === 'ended') t.tracks[0]!.onended?.();
      else t.node.onprocessorerror?.();
      expect(failed).toHaveBeenCalledTimes(1);
      expect(t.node.port.onmessage).toBeNull();
      expect(t.context.onstatechange).toBeNull();
      expect(t.released.tracks).toBe(2);
      c.stop();
    });
  }
});
