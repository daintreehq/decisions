import workletUrl from './pcm-worklet.js?url';

export interface Capture {
  stop(): void;
}

export type MicFailure = 'denied' | 'no-device' | 'unsupported' | 'failed';

export class MicUnavailableError extends Error {
  /** Why the microphone could not start, so the caller can offer the right help. Defaults to `failed`. */
  readonly kind: MicFailure;
  constructor(message: string, kind: MicFailure = 'failed') {
    super(message);
    this.kind = kind;
  }
}

/** Permission can take as long as the person needs; audio setup after permission is bounded. */
export const MIC_SETUP_TIMEOUT_MS = 8_000;
export const MIC_FRAME_TIMEOUT_MS = 5_000;

/**
 * Microphone → 16 kHz mono PCM16 frames (~100 ms). Unlock Web Audio in the initiating gesture, before awaiting
 * permission. A capture is ready only when its worklet delivers a frame (even silence). Every failure/cancel closes
 * the context and tracks, including a permission grant that arrives after cancellation.
 */
export async function startMic(
  onFrame: (pcm: ArrayBuffer) => void,
  onLevel?: (rms: number) => void,
  signal?: AbortSignal,
  onFailure?: (error: MicUnavailableError) => void,
): Promise<Capture> {
  const cancelled = () => new MicUnavailableError('Microphone start was cancelled.');
  if (signal?.aborted) throw cancelled();
  if (!navigator.mediaDevices?.getUserMedia)
    throw new MicUnavailableError('This browser cannot record audio.', 'unsupported');

  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let released = false;
  let started = false;
  let lastFrame = 0;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  let rejectWait: (error: MicUnavailableError) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => (rejectWait = reject));
  // Failure can precede the next await (for example, cancellation while permission is open).
  void failed.catch(() => undefined);
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener('abort', abort);
    clearTimeout(setupTimer);
    clearInterval(frameTimer);
    if (node) {
      node.port.onmessage = null;
      node.onprocessorerror = null;
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    try {
      source?.disconnect();
    } catch {
      /* already disconnected */
    }
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (ctx) {
      ctx.onstatechange = null;
      void ctx.close().catch(() => undefined);
    }
  };
  const fail = (error: MicUnavailableError) => {
    if (released) return;
    release();
    rejectWait(error);
    if (started) onFailure?.(error);
  };
  const abort = () => fail(cancelled());
  signal?.addEventListener('abort', abort, { once: true });
  const wait = async <T>(p: Promise<T>): Promise<T> => {
    const value = await Promise.race([p, failed]);
    if (released) throw cancelled();
    return value;
  };

  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctx();
    // Do not await this unlock: a browser can hold it until permission is granted. Retry after capture starts,
    // when Safari's media-capture exemption can apply. Neither promise is allowed to reject unobserved.
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    const permission = navigator.mediaDevices
      .getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((granted) => {
        if (released) {
          granted.getTracks().forEach((track) => track.stop());
          throw cancelled();
        }
        stream = granted;
        return granted;
      });
    const granted = await wait(permission);
    setupTimer = setTimeout(
      () => fail(new MicUnavailableError('The microphone did not start. Try again.')),
      MIC_SETUP_TIMEOUT_MS,
    );
    for (const track of granted.getTracks())
      track.onended = () =>
        fail(new MicUnavailableError('The microphone disconnected. Try again.'));
    try {
      await wait(ctx.audioWorklet.addModule(workletUrl));
    } catch (error) {
      if (released) throw error;
      throw new MicUnavailableError('Dictation is not supported in this browser.', 'unsupported');
    }
    // Safari also uses "interrupted". Treat every non-running state as needing an explicit resume.
    if (ctx.state !== 'running') await wait(ctx.resume());
    source = ctx.createMediaStreamSource(granted);
    node = new AudioWorkletNode(ctx, 'pcm16-downsampler', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { targetRate: 16000, frameSamples: 1600 },
    });
    let firstFrame: () => void = () => undefined;
    const frames = new Promise<void>((resolve) => (firstFrame = resolve));
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      if (released) return;
      lastFrame = Date.now();
      firstFrame();
      onFrame(e.data.pcm);
      onLevel?.(e.data.rms);
    };
    node.onprocessorerror = () =>
      fail(new MicUnavailableError('The microphone stopped working. Try again.'));
    const mute = ctx.createGain();
    mute.gain.value = 0; // some engines only run a node that is connected to the destination
    source.connect(node).connect(mute).connect(ctx.destination);
    await wait(frames);
    clearTimeout(setupTimer);
    started = true;
    // A live capture still owns the abort signal: leaving the page or stopping the session releases it at once.
    let resuming = false;
    ctx.onstatechange = () => {
      if (released || !ctx || ctx.state === 'running' || resuming) return;
      resuming = true;
      void ctx
        .resume()
        .catch(() => undefined)
        .finally(() => (resuming = false));
    };
    frameTimer = setInterval(() => {
      if (Date.now() - lastFrame >= MIC_FRAME_TIMEOUT_MS)
        fail(new MicUnavailableError('Sound stopped reaching the microphone. Try again.'));
    }, 1_000);
    return { stop: release };
  } catch (error) {
    release();
    if (error instanceof MicUnavailableError) throw error;
    const name = (error as { name?: string } | null)?.name;
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      throw new MicUnavailableError('No microphone is available.', 'no-device');
    if (name === 'NotAllowedError' || name === 'SecurityError')
      throw new MicUnavailableError('Microphone access is blocked.', 'denied');
    throw new MicUnavailableError("The microphone couldn't start.", 'failed');
  }
}
