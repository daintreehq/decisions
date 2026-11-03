import type { Capture } from './capture.js';

/** The subset of VoiceClient the session needs (lets tests drive it without a socket). */
export interface VoiceLike {
  start(): Promise<void>;
  sendAudio(frame: ArrayBuffer): void;
  stop(): Promise<string>;
  cancel(): void;
  /** Ask the provider to lock the utterance so far (push-to-talk release, or a pause in speech). */
  finalize?(): void;
}

export interface SessionDeps {
  /** `onReady` must be invoked when the provider announces it is ready (transcript.created). */
  makeClient(onReady: () => void): VoiceLike;
  /** `signal` aborts when the attempt is cancelled, so a permission granted late releases its tracks at once. */
  startMic(
    onFrame: (pcm: ArrayBuffer) => void,
    onLevel?: (rms: number) => void,
    signal?: AbortSignal,
  ): Promise<Capture>;
  onLevel?: (rms: number) => void;
  /** The microphone delivered something other than digital silence (Daintree's mic-live signal). */
  onMicLive?: () => void;
  /** No real audio arrived within the grace period. Capture continues; this only lets the UI say so. */
  onMicSilent?: () => void;
  /** The provider failed after capture began (the words received so far are still returned by `finish`). */
  onFailure?: (e: Error) => void;
  /** Bounds the whole provider startup: the voice ticket, the socket and readiness. */
  readyTimeoutMs?: number;
  silenceGraceMs?: number;
  /** Frames held while the provider connects: ~15 s of 100 ms frames; past that the oldest are dropped. */
  maxQueuedFrames?: number;
  /**
   * Lock an utterance after this many quiet frames that follow speech, so a provider that only transcribes what was
   * committed (OpenAI here, with no server turn detection) still produces words while the person talks.
   */
  segmentAfterQuietFrames?: number;
}

export type SessionPhase = 'idle' | 'starting' | 'listening' | 'finishing';

/** Mic-liveness floor: a peak of 4 LSB on PCM16, just above warm-up dither (Daintree's MIC_LIVE_PEAK_THRESHOLD). */
const LIVE_PEAK = 4;
/** Speech-ish RMS for segmenting on pauses. */
const SPEECH_RMS = 0.02;
/** A segment is locked at the latest after this many frames (~20 s) even without a pause. */
const MAX_SEGMENT_FRAMES = 200;

function peakOf(pcm: ArrayBuffer): number {
  const s = new Int16Array(pcm, 0, pcm.byteLength >> 1);
  let peak = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s[i]!;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak;
}

function rmsOf(pcm: ArrayBuffer): number {
  const s = new Int16Array(pcm, 0, pcm.byteLength >> 1);
  if (!s.length) return 0;
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i]! * s[i]!;
  return Math.sqrt(sum / s.length) / 32768;
}

/**
 * One dictation attempt from tap to transcript. As in Daintree, the microphone opens in parallel with the relay
 * session and captured frames are queued until the provider is ready, so words spoken while "Starting
 * microphone…" are kept. Startup is several awaits long (ticket, provider handshake, microphone permission), and the
 * person can release, cancel, lose the editor or leave the page at any point: every await re-checks a generation
 * token, and a capture that arrives after cancellation is stopped at once, so a microphone never keeps running
 * without a visible owner.
 */
export class DictationSession {
  phase: SessionPhase = 'idle';
  private generation = 0;
  private client: VoiceLike | null = null;
  private mic: Capture | null = null;
  private queue: ArrayBuffer[] | null = null;
  private ready: Promise<void> | null = null;
  private live = false;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Wakes a startup parked on the provider so cancellation takes effect at once. */
  private abortWait: (() => void) | null = null;
  /** Aborts the microphone's own startup when this attempt is cancelled. */
  private micAbort: AbortController | null = null;
  /** Frames dropped from the head of a full startup queue. */
  droppedFrames = 0;
  private speaking = false;
  private quiet = 0;
  private segmentFrames = 0;

  constructor(
    private readonly deps: SessionDeps,
    private readonly onPhase?: (p: SessionPhase) => void,
  ) {}

  private set(p: SessionPhase) {
    this.phase = p;
    this.onPhase?.(p);
  }

  /** Whether the microphone has delivered real audio in this attempt. */
  get micLive(): boolean {
    return this.live;
  }

  private cleanup() {
    clearTimeout(this.silenceTimer);
    this.micAbort?.abort();
    this.micAbort = null;
    this.mic?.stop();
    this.mic = null;
    this.client?.cancel();
    this.client = null;
    this.queue = null;
    this.ready = null;
  }

  private onFrame(gen: number, client: VoiceLike, pcm: ArrayBuffer) {
    if (this.generation !== gen) return;
    if (!this.live && peakOf(pcm) >= LIVE_PEAK) {
      this.live = true;
      clearTimeout(this.silenceTimer);
      this.deps.onMicLive?.();
    }
    if (this.queue) {
      this.queue.push(pcm);
      const max = this.deps.maxQueuedFrames ?? 150;
      while (this.queue.length > max) {
        this.queue.shift();
        this.droppedFrames++;
      }
      return;
    }
    client.sendAudio(pcm);
    this.segment(client, pcm);
  }

  private segment(client: VoiceLike, pcm: ArrayBuffer) {
    const after = this.deps.segmentAfterQuietFrames;
    if (!after || !client.finalize) return;
    this.segmentFrames++;
    if (rmsOf(pcm) >= SPEECH_RMS) {
      this.speaking = true;
      this.quiet = 0;
    } else if (this.speaking && ++this.quiet >= after) {
      this.speaking = false;
      this.quiet = 0;
      this.segmentFrames = 0;
      client.finalize();
      return;
    }
    if (this.segmentFrames >= MAX_SEGMENT_FRAMES && this.speaking) {
      this.segmentFrames = 0;
      client.finalize();
    }
  }

  async start(): Promise<'listening' | 'cancelled'> {
    if (this.phase !== 'idle') return 'cancelled';
    const gen = ++this.generation;
    const current = () => this.generation === gen;
    this.live = false;
    this.droppedFrames = 0;
    this.speaking = false;
    this.quiet = this.segmentFrames = 0;
    this.queue = [];
    this.set('starting');

    let readyResolve: () => void = () => undefined;
    const readySignal = new Promise<void>((res) => (readyResolve = res));
    const client = this.deps.makeClient(() => readyResolve());
    this.client = client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, rej) => {
      this.abortWait = () => rej(new Error('cancelled'));
    });
    aborted.catch(() => undefined);
    const micAbort = new AbortController();
    this.micAbort = micAbort;

    // The provider side: ticket, socket, `transcript.created`, then drain what the microphone already heard. The
    // deadline covers all of it, the ticket request included, and a cancel ends the wait at any step.
    const provider = (async () => {
      const deadline = new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error('The dictation service did not respond.')),
          this.deps.readyTimeoutMs ?? 10_000,
        );
      });
      try {
        await Promise.race([client.start(), aborted, deadline]);
        if (!current()) throw new Error('cancelled');
        await Promise.race([readySignal, aborted, deadline]);
      } finally {
        clearTimeout(timer);
      }
      if (!current()) throw new Error('cancelled');
      const held = this.queue ?? [];
      this.queue = null;
      for (const f of held) client.sendAudio(f);
    })();
    provider.catch(() => undefined);
    this.ready = provider;

    try {
      const opening = this.deps.startMic(
        (pcm) => this.onFrame(gen, client, pcm),
        this.deps.onLevel,
        micAbort.signal,
      );
      // A microphone this attempt never adopts (cancelled, or the provider failed first) is stopped the moment the
      // permission resolves, so none keeps running without a visible owner.
      opening.then(
        (m) => {
          if (this.generation !== gen) m.stop();
        },
        () => undefined,
      );
      const mic = await Promise.race([
        opening,
        // A provider failure before the permission prompt is answered ends the attempt now.
        provider.then(() => new Promise<never>(() => undefined)),
        aborted,
      ]);
      // Permission resolved after the person already let go: the handler above has stopped it.
      if (!current()) return 'cancelled';
      this.mic = mic;
      if (!this.live) {
        this.silenceTimer = setTimeout(() => {
          if (current() && !this.live && this.mic) this.deps.onMicSilent?.();
        }, this.deps.silenceGraceMs ?? 3_000);
      }
      this.set('listening');
      // Capture is running; a provider failure from here on is reported, and Stop still returns what was heard.
      provider.catch((e: unknown) => {
        if (!current() || this.phase === 'finishing') return;
        this.deps.onFailure?.(e instanceof Error ? e : new Error(String(e)));
      });
      return 'listening';
    } catch (e) {
      if (current()) {
        // Retire this attempt, so a microphone that resolves after the failure is stopped on arrival.
        this.generation++;
        this.cleanup();
        this.set('idle');
        throw e;
      }
      return 'cancelled';
    }
  }

  /** Abort whatever is in progress and discard it. Safe to call in any phase, any number of times. */
  cancel(): void {
    this.generation++;
    this.abortWait?.();
    this.abortWait = null;
    this.cleanup();
    if (this.phase !== 'idle') this.set('idle');
  }

  /**
   * Deliberate stop: the microphone is released first, then queued audio reaches the provider, then it is asked to
   * finish and the transcript is returned. Before the microphone opened it is a cancel (nothing was recorded).
   */
  async finish(): Promise<string> {
    if (this.phase === 'starting') {
      this.cancel();
      return '';
    }
    if (this.phase !== 'listening' || !this.client) return '';
    const gen = this.generation;
    const client = this.client;
    clearTimeout(this.silenceTimer);
    this.mic?.stop();
    this.mic = null;
    this.set('finishing');
    try {
      await this.ready;
    } catch {
      // The provider never came up: nothing was transcribed.
      if (this.generation === gen) {
        this.cleanup();
        this.set('idle');
      }
      return '';
    }
    if (this.generation !== gen) return '';
    const raw = await client.stop();
    if (this.client === client) this.client = null;
    if (this.generation === gen) this.set('idle');
    return raw;
  }
}
