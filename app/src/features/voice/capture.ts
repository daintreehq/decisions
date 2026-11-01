export interface Capture {
  stop(): void;
}

export class MicUnavailableError extends Error {}

/** Microphone → 16 kHz mono PCM16 frames (~100 ms) via an AudioWorklet. Starts only from a user gesture. */
export async function startMic(
  onFrame: (pcm: ArrayBuffer) => void,
  onLevel?: (rms: number) => void,
): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new MicUnavailableError('This browser cannot record audio.');
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
  } catch {
    throw new MicUnavailableError(
      'Microphone access was denied. You can type your answer instead.',
    );
  }
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    await ctx.audioWorklet.addModule('/voice-worklet.js');
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    throw new MicUnavailableError('Dictation is not supported in this browser.');
  }
  if (ctx.state === 'suspended') await ctx.resume();
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
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
