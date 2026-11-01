import { VoiceSessionResponse, PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import type { WebSocketLike } from '../../data/sync.js';

export type VoiceState =
  'idle' | 'connecting' | 'ready' | 'streaming' | 'finalizing' | 'done' | 'error';

export interface VoiceClientOptions {
  postJson: <T>(path: string, body: unknown) => Promise<T>;
  origin: string;
  provider: 'xai' | 'openai';
  keyterms: string[];
  language?: string;
  wsFactory?: (url: string) => WebSocketLike;
  onState?: (s: VoiceState) => void;
  /** Live text: `final` is committed so far, `interim` may still change. */
  onText?: (t: { final: string; interim: string }) => void;
  onError?: (message: string) => void;
  doneTimeoutMs?: number;
}

/**
 * Speaks the normalised dictation protocol of the relay's voice proxy (docs/protocol.md section 13):
 * wait for `transcript.created` before any audio; binary PCM16 frames up; `finalize` for push-to-talk;
 * `audio.done` to finish; collect `transcript.partial`/`transcript.done`. Audio is never stored here.
 */
export class VoiceClient {
  state: VoiceState = 'idle';
  private ws: WebSocketLike | null = null;
  private finals: string[] = [];
  private interim = '';
  private doneText: string | null = null;
  private doneWaiter: ((raw: string) => void) | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  /** Frames offered before the provider said it was ready are dropped, never queued. */
  droppedFrames = 0;

  constructor(private readonly o: VoiceClientOptions) {}

  private set(s: VoiceState) {
    this.state = s;
    this.o.onState?.(s);
  }

  async start(): Promise<void> {
    this.set('connecting');
    const session = VoiceSessionResponse.parse(
      await this.o.postJson('/voice/session', {
        protocol_version: PROTOCOL_VERSION,
        provider: this.o.provider,
        consent: true,
        keyterms: this.o.keyterms,
        language: this.o.language,
      }),
    );
    const base = this.o.origin.replace(/^http/, 'ws');
    const path = session.ws_path.includes('ticket=')
      ? session.ws_path
      : `${session.ws_path}${session.ws_path.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(session.ticket)}`;
    const ws = this.o.wsFactory
      ? this.o.wsFactory(base + path)
      : (new WebSocket(base + path) as unknown as WebSocketLike);
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => this.fail('The dictation connection failed');
    ws.onclose = () => {
      if (this.state === 'finalizing') this.finish();
      else if (this.state !== 'done' && this.state !== 'idle' && this.state !== 'error')
        this.fail('Dictation stopped unexpectedly');
    };
  }

  private onMessage(data: unknown) {
    if (typeof data !== 'string') return;
    let m: { type?: string; text?: string; is_final?: boolean; message?: string };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    switch (m.type) {
      case 'transcript.created':
        if (this.state === 'connecting') this.set('ready');
        break;
      case 'transcript.partial': {
        const text = typeof m.text === 'string' ? m.text : '';
        if (m.is_final) {
          // Providers can repeat a locked chunk; ignore an exact consecutive duplicate.
          if (text && this.finals.at(-1) !== text) this.finals.push(text);
          this.interim = '';
        } else {
          this.interim = text;
        }
        this.emitText();
        break;
      }
      case 'transcript.done':
        this.doneText = typeof m.text === 'string' ? m.text : '';
        this.finish();
        break;
      case 'error':
        this.fail(typeof m.message === 'string' ? m.message : 'Dictation failed');
        break;
      default:
        break;
    }
  }

  private emitText() {
    this.o.onText?.({ final: this.finals.join(' ').trim(), interim: this.interim });
  }

  sendAudio(frame: ArrayBuffer): void {
    if ((this.state !== 'ready' && this.state !== 'streaming') || !this.ws) {
      this.droppedFrames++;
      return;
    }
    if (this.state === 'ready') this.set('streaming');
    (this.ws as unknown as { send(d: ArrayBuffer): void }).send(frame);
  }

  /** Push-to-talk release: ask the provider to lock the current utterance now. */
  finalize(): void {
    this.ws?.send(JSON.stringify({ type: 'finalize' }));
  }

  /** Deliberate stop. Resolves with the full raw transcript (provider's final text, else what we collected). */
  stop(): Promise<string> {
    if (this.state === 'done') return Promise.resolve(this.rawText());
    if (!this.ws || (this.state !== 'streaming' && this.state !== 'ready'))
      return Promise.resolve(this.rawText());
    this.set('finalizing');
    this.ws.send(JSON.stringify({ type: 'audio.done' }));
    return new Promise<string>((resolve) => {
      this.doneWaiter = resolve;
      this.doneTimer = setTimeout(() => this.finish(), this.o.doneTimeoutMs ?? 5000);
    });
  }

  rawText(): string {
    const collected = [...this.finals, this.interim].filter(Boolean).join(' ').trim();
    return (this.doneText ?? '').trim() || collected;
  }

  private finish() {
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.doneTimer = null;
    if (this.state !== 'error') this.set('done');
    const raw = this.rawText();
    const w = this.doneWaiter;
    this.doneWaiter = null;
    this.close();
    w?.(raw);
  }

  private fail(message: string) {
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.set('error');
    this.o.onError?.(message);
    const w = this.doneWaiter;
    this.doneWaiter = null;
    this.close();
    // Whatever was transcribed so far is still the user's to edit.
    w?.(this.rawText());
  }

  cancel(): void {
    this.close();
    this.set('idle');
  }

  private close() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, 'done');
      } catch {
        /* already closed */
      }
    }
  }
}
