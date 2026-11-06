import { describe, expect, it, vi } from 'vitest';
import { MicUnavailableError, type Capture } from '../src/features/voice/capture.js';
import {
  DictationSession,
  type SessionPhase,
  type VoiceLike,
} from '../src/features/voice/session.js';

/** A 100 ms PCM16 frame at a constant sample value (0 is digital silence). */
function pcm(value: number, samples = 1600): ArrayBuffer {
  const a = new Int16Array(samples);
  a.fill(value);
  return a.buffer;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function rig(
  opts: { readyImmediately?: boolean; readyTimeoutMs?: number; maxQueuedFrames?: number } = {},
) {
  const startGate = deferred();
  const micGate = deferred<Capture>();
  const log: string[] = [];
  const frames: ArrayBuffer[] = [];
  let onReady: () => void = () => undefined;
  let frameSink: (b: ArrayBuffer) => void = () => undefined;
  let micFailure: (error: MicUnavailableError) => void = () => undefined;
  const onFailure = vi.fn();
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
  const startMic = vi.fn(
    (
      onFrame: (b: ArrayBuffer) => void,
      _onLevel?: (rms: number) => void,
      _signal?: AbortSignal,
      onFailure?: (error: MicUnavailableError) => void,
    ) => {
      log.push('startMic');
      frameSink = onFrame;
      micFailure = onFailure ?? (() => undefined);
      return micGate.promise;
    },
  );
  const session = new DictationSession(
    {
      makeClient: (r) => {
        onReady = r;
        return client;
      },
      startMic,
      ...(opts.readyTimeoutMs ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
      ...(opts.maxQueuedFrames ? { maxQueuedFrames: opts.maxQueuedFrames } : {}),
      onMicLive: () => log.push('micLive'),
      onFailure,
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
    failMic: (error: MicUnavailableError) => micFailure(error),
    onFailure,
    flush: () => new Promise((r) => setTimeout(r, 0)),
  };
}

describe('dictation session startup races', () => {
  it('reports a runtime microphone failure, preserves received words, and ignores failures after cancel', async () => {
    const t = rig();
    const starting = t.session.start();
    t.startGate.resolve();
    t.micGate.resolve(t.mic);
    await starting;
    const error = new MicUnavailableError('The microphone disconnected. Try again.');
    t.failMic(error);
    expect(t.onFailure).toHaveBeenCalledWith(error);
    await expect(t.session.finish()).resolves.toBe('what was said');
    t.session.cancel();
    t.failMic(error);
    expect(t.onFailure).toHaveBeenCalledTimes(1);
  });
  it('goes idle → starting → listening and streams audio', async () => {
    const t = rig();
    const p = t.session.start();
    t.startGate.resolve();
    await vi.waitFor(() => expect(t.startMic).toHaveBeenCalled());
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('listening');
    expect(t.phases).toEqual(['starting', 'listening']);
    await t.flush();
    t.feed(new ArrayBuffer(8));
    expect(t.frames).toHaveLength(1);
  });

  it('opens the microphone in parallel with the provider handshake (Daintree parity)', async () => {
    const t = rig();
    void t.session.start();
    // The ticket and socket have not answered yet, and the microphone is already being opened.
    await vi.waitFor(() => expect(t.startMic).toHaveBeenCalled());
    t.session.cancel();
  });

  it('release while the provider handshake is pending: the late microphone is stopped and nothing streams', async () => {
    const t = rig();
    const p = t.session.start();
    t.session.cancel(); // hold-to-talk released / pointercancel
    t.startGate.resolve();
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('cancelled');
    await t.flush();
    expect(t.log).toContain('client.cancel');
    expect(t.log.filter((l) => l === 'mic.stop')).toHaveLength(1);
    t.feed(pcm(1000));
    expect(t.frames).toHaveLength(0);
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

  it('release while waiting for the provider to be ready cancels and stops the microphone', async () => {
    const t = rig({ readyImmediately: false });
    const p = t.session.start();
    t.startGate.resolve();
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('listening');
    t.session.cancel();
    expect(t.log).toEqual(expect.arrayContaining(['mic.stop', 'client.cancel']));
    expect(t.frames).toHaveLength(0);
  });

  it('finish() before the microphone opened is a cancel that returns nothing', async () => {
    const t = rig();
    const p = t.session.start();
    await expect(t.session.finish()).resolves.toBe('');
    t.startGate.resolve();
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('cancelled');
    expect(t.log).not.toContain('client.stop');
    expect(t.log).toContain('mic.stop');
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

  it('times out if the provider never becomes ready, releasing the microphone', async () => {
    const t = rig({ readyImmediately: false, readyTimeoutMs: 20 });
    const p = t.session.start();
    t.startGate.resolve();
    await expect(p).rejects.toThrow(/did not respond/);
    t.micGate.resolve(t.mic);
    await t.flush();
    expect(t.log).toContain('mic.stop');
    expect(t.session.phase).toBe('idle');
  });

  it('bounds the whole startup wait, a stalled voice ticket included, so Stop still ends', async () => {
    const t = rig({ readyTimeoutMs: 20 });
    const p = t.session.start(); // the ticket request (client.start) never answers
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('listening');
    const raw = await Promise.race([
      t.session.finish(),
      new Promise((r) => setTimeout(() => r('hung'), 500)),
    ]);
    expect(raw).toBe('');
    expect(t.session.phase).toBe('idle');
  });

  it('cancel() settles a Stop waiting on a stalled voice ticket at once', async () => {
    const t = rig();
    const p = t.session.start();
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('listening');
    const finishing = t.session.finish();
    t.session.cancel();
    const raw = await Promise.race([
      finishing,
      new Promise((r) => setTimeout(() => r('hung'), 200)),
    ]);
    expect(raw).toBe('');
  });

  it('passes the microphone a cancellation signal that cancel() aborts', async () => {
    const t = rig();
    void t.session.start();
    await vi.waitFor(() => expect(t.startMic).toHaveBeenCalled());
    const signal = t.startMic.mock.calls[0]![2] as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);
    t.session.cancel();
    expect(signal?.aborted).toBe(true);
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

describe('early capture', () => {
  it('queues what the microphone hears before the provider is ready, then sends it in order', async () => {
    const t = rig({ readyImmediately: false });
    const p = t.session.start();
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('listening');
    const a = pcm(100);
    const b = pcm(200);
    t.feed(a);
    t.feed(b);
    expect(t.frames).toHaveLength(0); // held, not dropped, while "Starting microphone…"
    t.startGate.resolve();
    await t.flush();
    // The handshake resolved but readiness (transcript.created) has not come: still held.
    expect(t.frames).toHaveLength(0);
  });

  it('flushes the queue the moment the provider is ready and streams live after', async () => {
    const t = rig();
    const p = t.session.start();
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('listening');
    const a = pcm(100);
    const b = pcm(200);
    t.feed(a);
    t.feed(b);
    expect(t.frames).toHaveLength(0);
    t.startGate.resolve();
    await vi.waitFor(() => expect(t.frames).toEqual([a, b]));
    const c = pcm(300);
    t.feed(c);
    expect(t.frames).toEqual([a, b, c]);
  });

  it('keeps about 15 s at most, dropping the oldest audio rather than failing', async () => {
    const t = rig({ maxQueuedFrames: 3 });
    const p = t.session.start();
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('listening');
    const f = [1, 2, 3, 4, 5].map((v) => pcm(v * 10));
    f.forEach((x) => t.feed(x));
    t.startGate.resolve();
    await vi.waitFor(() => expect(t.frames).toEqual(f.slice(2)));
    expect(t.session.droppedFrames).toBe(2);
  });

  it('reports the microphone live only once real audio arrives, never for digital silence', async () => {
    const t = rig();
    const p = t.session.start();
    t.micGate.resolve(t.mic);
    t.startGate.resolve();
    await p;
    t.feed(pcm(0));
    t.feed(pcm(2)); // warm-up dither
    expect(t.log).not.toContain('micLive');
    t.feed(pcm(40));
    expect(t.log.filter((l) => l === 'micLive')).toHaveLength(1);
  });

  it('a Stop before the provider is ready still delivers the queued words', async () => {
    const t = rig();
    const p = t.session.start();
    t.micGate.resolve(t.mic);
    await expect(p).resolves.toBe('listening');
    const a = pcm(500);
    t.feed(a);
    const raw = t.session.finish();
    expect(t.log).toContain('mic.stop'); // the microphone is released at once
    t.startGate.resolve();
    await expect(raw).resolves.toBe('what was said');
    expect(t.frames).toEqual([a]);
    expect(t.log.indexOf('sendAudio')).toBeLessThan(t.log.indexOf('client.stop'));
  });
});
