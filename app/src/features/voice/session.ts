import type { Capture } from './capture.js';

/** The subset of VoiceClient the session needs (lets tests drive it without a socket). */
export interface VoiceLike {
  start(): Promise<void>;
  sendAudio(frame: ArrayBuffer): void;
  stop(): Promise<string>;
  cancel(): void;
}

export interface SessionDeps {
  /** `onReady` must be invoked when the provider announces it is ready (transcript.created). */
  makeClient(onReady: () => void): VoiceLike;
  startMic(onFrame: (pcm: ArrayBuffer) => void, onLevel?: (rms: number) => void): Promise<Capture>;
  onLevel?: (rms: number) => void;
  readyTimeoutMs?: number;
}

export type SessionPhase = 'idle' | 'starting' | 'listening' | 'finishing';

/**
 * One dictation attempt from tap to transcript. Startup is several awaits long (session ticket, provider
 * handshake, microphone permission), and the human can release, cancel, lose the editor or leave the page at
 * any point in between. Every await re-checks a generation token, and any capture that arrives after
 * cancellation is stopped immediately, so a microphone can never keep running without a visible owner.
 */
export class DictationSession {
  phase: SessionPhase = 'idle';
  private generation = 0;
  private client: VoiceLike | null = null;
  private mic: Capture | null = null;
  /** Wakes a startup that is parked waiting for the provider so cancellation takes effect immediately. */
  private abortWait: (() => void) | null = null;

  constructor(
    private readonly deps: SessionDeps,
    private readonly onPhase?: (p: SessionPhase) => void,
  ) {}

  private set(p: SessionPhase) {
    this.phase = p;
    this.onPhase?.(p);
  }

  private cleanup() {
    this.mic?.stop();
    this.mic = null;
    this.client?.cancel();
    this.client = null;
  }

  async start(): Promise<'listening' | 'cancelled'> {
    if (this.phase !== 'idle') return 'cancelled';
    const gen = ++this.generation;
    const live = () => this.generation === gen;
    this.set('starting');

    let readyResolve: () => void = () => undefined;
    const ready = new Promise<void>((res) => (readyResolve = res));
    const client = this.deps.makeClient(() => readyResolve());
    this.client = client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await client.start();
      if (!live()) return 'cancelled';
      await Promise.race([
        ready,
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error('The dictation service did not respond.')),
            this.deps.readyTimeoutMs ?? 10_000,
          );
          this.abortWait = () => rej(new Error('cancelled'));
        }),
      ]);
      if (!live()) return 'cancelled';
      const mic = await this.deps.startMic((pcm) => {
        if (live()) client.sendAudio(pcm);
      }, this.deps.onLevel);
      if (!live()) {
        mic.stop(); // permission resolved after the human already let go: never leave it recording
        return 'cancelled';
      }
      this.mic = mic;
      this.set('listening');
      return 'listening';
    } catch (e) {
      if (live()) {
        this.cleanup();
        this.set('idle');
        throw e;
      }
      return 'cancelled';
    } finally {
      clearTimeout(timer);
      this.abortWait = null;
    }
  }

  /** Abort whatever is in progress and discard it. Safe to call in any phase, any number of times. */
  cancel(): void {
    this.generation++;
    this.abortWait?.();
    this.cleanup();
    if (this.phase !== 'idle') this.set('idle');
  }

  /**
   * Deliberate stop: the microphone is released first, then the provider is asked to finish and the collected
   * transcript is returned. Called during startup it is a cancel (nothing was recorded, nothing is returned).
   */
  async finish(): Promise<string> {
    if (this.phase === 'starting') {
      this.cancel();
      return '';
    }
    if (this.phase !== 'listening' || !this.client) return '';
    const client = this.client;
    this.mic?.stop();
    this.mic = null;
    this.set('finishing');
    const raw = await client.stop();
    if (this.client === client) this.client = null;
    this.set('idle');
    return raw;
  }
}
