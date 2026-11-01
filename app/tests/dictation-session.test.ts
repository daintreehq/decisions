import { describe, expect, it, vi } from 'vitest';
import type { Capture } from '../src/features/voice/capture.js';
import {
  DictationSession,
  type SessionPhase,
  type VoiceLike,
} from '../src/features/voice/session.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function rig(opts: { readyImmediately?: boolean; readyTimeoutMs?: number } = {}) {
  const startGate = deferred();
  const micGate = deferred<Capture>();
  const log: string[] = [];
  const frames: ArrayBuffer[] = [];
  let onReady: () => void = () => undefined;
  let frameSink: (b: ArrayBuffer) => void = () => undefined;
  const client: VoiceLike & { collected: string } = {
    collected: 'what was said',
    start: () => startGate.promise.then(() => void (opts.readyImmediately !== false && onReady())),
    sendAudio: (f) => {
      frames.push(f);
      log.push('sendAudio');
    },
    stop: async () => {
      log.push('client.stop');
      return client.collected;
    },
    cancel: () => void log.push('client.cancel'),
  };
  const mic: Capture = { stop: () => void log.push('mic.stop') };
  const phases: SessionPhase[] = [];
  const startMic = vi.fn((onFrame: (b: ArrayBuffer) => void) => {
    log.push('startMic');
    frameSink = onFrame;
    return micGate.promise;
  });
  const session = new DictationSession(
    {
      makeClient: (r) => {
        onReady = r;
        return client;
      },
      startMic,
      ...(opts.readyTimeoutMs ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
    },
    (p) => phases.push(p),
  );
  return {
    session,
    startGate,
    micGate,
    log,
    frames,
    mic,
    startMic,
    phases,
    client,
    feed: (b: ArrayBuffer) => frameSink(b),
    flush: () => new Promise((r) => setTimeout(r, 0)),
  };
}

describe('dictation session startup races', () => {
  it('goes idle → starting → listening and streams audio', async () => {
    const t = rig();
    const p = t.session.start();
    t.startGate.resolve();
    await vi.waitFor(() => expect(t.startMic).toHaveBeenCalled());
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('listening');
    expect(t.phases).toEqual(['starting', 'listening']);
    t.feed(new ArrayBuffer(8));
    expect(t.frames).toHaveLength(1);
  });

  it('release while the provider handshake is pending: the microphone is never requested', async () => {
    const t = rig();
    const p = t.session.start();
    t.session.cancel(); // hold-to-talk released / pointercancel
    t.startGate.resolve();
    await expect(p).resolves.toBe('cancelled');
    expect(t.startMic).not.toHaveBeenCalled();
    expect(t.log).toContain('client.cancel');
    expect(t.session.phase).toBe('idle');
  });

  it('release while microphone permission is pending: the late capture is stopped at once and never streams', async () => {
    const t = rig();
    const p = t.session.start();
    t.startGate.resolve();
    await vi.waitFor(() => expect(t.startMic).toHaveBeenCalled());
    t.session.cancel();
    t.micGate.resolve(t.mic); // the OS grants it after the human let go
    await expect(p).resolves.toBe('cancelled');
    expect(t.log.filter((l) => l === 'mic.stop')).toHaveLength(1);
    t.feed(new ArrayBuffer(8)); // even a frame already in flight is dropped
    expect(t.frames).toHaveLength(0);
    expect(t.session.phase).toBe('idle');
  });

  it('release while waiting for the provider to be ready cancels without touching the microphone', async () => {
    const t = rig({ readyImmediately: false });
    const p = t.session.start();
    t.startGate.resolve();
    await t.flush();
    t.session.cancel();
    await expect(p).resolves.toBe('cancelled');
    expect(t.startMic).not.toHaveBeenCalled();
  });

  it('finish() during startup is a cancel that returns nothing', async () => {
    const t = rig();
    const p = t.session.start();
    await expect(t.session.finish()).resolves.toBe('');
    t.startGate.resolve();
    await expect(p).resolves.toBe('cancelled');
    expect(t.log).not.toContain('client.stop');
    expect(t.startMic).not.toHaveBeenCalled();
  });

  it('a failed start cleans up fully and reports the error', async () => {
    const t = rig();
    const p = t.session.start();
    t.startGate.resolve();
    await vi.waitFor(() => expect(t.startMic).toHaveBeenCalled());
    t.micGate.reject(new Error('Microphone access was denied.'));
    await expect(p).rejects.toThrow(/denied/);
    expect(t.log).toContain('client.cancel');
    expect(t.session.phase).toBe('idle');
  });

  it('times out if the provider never becomes ready', async () => {
    const t = rig({ readyImmediately: false, readyTimeoutMs: 20 });
    const p = t.session.start();
    t.startGate.resolve();
    await expect(p).rejects.toThrow(/did not respond/);
    expect(t.startMic).not.toHaveBeenCalled();
    expect(t.session.phase).toBe('idle');
  });

  it('ignores a second start while one is running', async () => {
    const t = rig();
    void t.session.start();
    await expect(t.session.start()).resolves.toBe('cancelled');
  });
});

describe('stopping a live capture', () => {
  async function listening() {
    const t = rig();
    const p = t.session.start();
    t.startGate.resolve();
    await vi.waitFor(() => expect(t.startMic).toHaveBeenCalled());
    t.micGate.resolve(t.mic);
    await p;
    return t;
  }

  it('releases the microphone before asking the provider to finish, and keeps the transcript', async () => {
    const t = await listening();
    const raw = await t.session.finish();
    expect(raw).toBe('what was said');
    expect(t.log.indexOf('mic.stop')).toBeLessThan(t.log.indexOf('client.stop'));
    expect(t.session.phase).toBe('idle');
  });

  it('cancel() while live stops both the microphone and the socket', async () => {
    const t = await listening();
    t.session.cancel();
    expect(t.log).toEqual(expect.arrayContaining(['mic.stop', 'client.cancel']));
    expect(t.session.phase).toBe('idle');
    t.feed(new ArrayBuffer(8));
    expect(t.frames).toHaveLength(0);
  });
});
