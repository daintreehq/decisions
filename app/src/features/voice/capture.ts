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

/**
 * Microphone → 16 kHz mono PCM16 frames (~100 ms) via an AudioWorklet. Starts only from a user gesture. Once
 * permission is granted the tracks are always released on failure, and a `signal` aborted while permission or setup
 * is pending releases them before any further step.
 */
export async function startMic(
  onFrame: (pcm: ArrayBuffer) => void,
  onLevel?: (rms: number) => void,
  signal?: AbortSignal,
): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new MicUnavailableError('This browser cannot record audio.', 'unsupported');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      throw new MicUnavailableError('No microphone is available.', 'no-device');
    if (name === 'NotAllowedError' || name === 'SecurityError')
      throw new MicUnavailableError('Microphone access is blocked.', 'denied');
    throw new MicUnavailableError("The microphone couldn't start.", 'failed');
  }
  let ctx: AudioContext | null = null;
  const release = () => {
    stream.getTracks().forEach((t) => t.stop());
    if (ctx) void ctx.close().catch(() => undefined);
  };
  const cancelled = () => {
    if (signal?.aborted) throw new MicUnavailableError('Microphone start was cancelled.');
  };
  try {
    cancelled();
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctx();
    try {
      await ctx.audioWorklet.addModule('/voice-worklet.js');
    } catch {
      throw new MicUnavailableError('Dictation is not supported in this browser.', 'unsupported');
    }
    cancelled();
    if (ctx.state === 'suspended') await ctx.resume();
    cancelled();
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm16-downsampler', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { targetRate: 16000, frameSamples: 1600 },
    });
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      onFrame(e.data.pcm);
      onLevel?.(e.data.rms);
    };
    const mute = ctx.createGain();
    mute.gain.value = 0; // some engines only run a node that is connected to the destination
    source.connect(node).connect(mute).connect(ctx.destination);
    return {
      stop() {
        node.port.onmessage = null;
        try {
          source.disconnect();
          node.disconnect();
        } catch {
          /* already disconnected */
        }
        release();
      },
    };
  } catch (e) {
    release();
    throw e instanceof MicUnavailableError
      ? e
      : new MicUnavailableError("The microphone couldn't start.", 'failed');
  }
}
