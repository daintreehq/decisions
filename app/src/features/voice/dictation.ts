import { useSyncExternalStore } from 'react';
import { LIMITS } from '@daintreehq/decisions-protocol';
import { app } from '../../app/controller.js';
import type { LocalPrefs } from '../../app/prefs.js';
import type { ComposeMode, FieldId } from '../../domain/compose.js';
import { announce } from '../../lib/announce.js';
import { drafts, fieldValue, type DraftModel, type Passage } from '../compose/draftStore.js';
import { MicUnavailableError, startMic as realStartMic, type Capture } from './capture.js';
import { VoiceClient } from './client.js';
import {
  buildKeyterms,
  dictationLanguage,
  precedingText,
  runCorrection,
  type CorrectionRequest,
  type CorrectionOutcome,
  type Span as UnsureSpan,
} from './correction.js';
import {
  diffCorrection,
  mapThroughEdit,
  planVoiceBreak,
  planVoiceWords,
  splitDictationCommands,
  type ChangedRun,
  type Span,
} from './insertion.js';
import { DictationSession, type VoiceLike } from './session.js';

/**
 * The one owner of dictation in the app. It outlives the editor sheet, the file viewer and even the workspace, and
 * every passage is bound to one question, revision, mode, field and draft epoch. Finalized words go into that draft
 * at the caret captured when recording started, as they arrive; interim words only ever show in the dock. A cleanup
 * replaces only its own untouched passage; any edit, a send, a clear or "Use original wording" beats it.
 */

export interface Binding {
  questionId: string;
  revision: number;
  mode: ComposeMode;
  field: FieldId;
  /** Draft row key and the epoch it was at when the passage began. */
  key: string;
  epoch: number;
  question: string;
  context?: string;
  options: { label: string; description?: string }[];
  askedAt?: string;
  projectLabel?: string;
}

export type DictPhase = 'idle' | 'consent' | 'starting' | 'recording' | 'finishing' | 'cleaning';

export interface DictMessage {
  text: string;
  tone: 'info' | 'warn' | 'error';
  /** Offer to try again (device failure, nothing captured). */
  retry?: boolean;
}

/** After a cleanup lands: the changed words, underlined for a few seconds (Daintree's correction review). */
export interface Review {
  key: string;
  field: FieldId;
  /** Offsets into the field's text at landing. */
  start: number;
  cleaned: string;
  marks: ChangedRun[];
}

export interface Unsure {
  key: string;
  field: FieldId;
  /** The field text the spans were computed against; they are void once it changes. */
  text: string;
  spans: UnsureSpan[];
}

export interface DictState {
  phase: DictPhase;
  binding: Binding | null;
  /** The microphone is delivering real audio. Until then the UI says "Starting microphone…". */
  micLive: boolean;
  /** No audio within the grace period: say so, keep listening. */
  micSilent: boolean;
  /** Permission prompt likely showing. */
  permission: boolean;
  /** When capture began (for "Recording · 00:24"). */
  startedAt: number | null;
  /** Locked words of this passage, and the words still being recognised. */
  final: string;
  interim: string;
  /** The relay's session cap is near. */
  capWarning: boolean;
  message: DictMessage | null;
  review: Review | null;
  unsure: Unsure | null;
  /** Escape was pressed once; a second press within 4 s discards the passage. */
  escArmed: boolean;
}

const IDLE: DictState = {
  phase: 'idle',
  binding: null,
  micLive: false,
  micSilent: false,
  permission: false,
  startedAt: null,
  final: '',
  interim: '',
  capWarning: false,
  message: null,
  review: null,
  unsure: null,
  escArmed: false,
};

export const MESSAGES = {
  offline: 'Dictation needs a connection. You can keep typing.',
  unconfigured: "Dictation isn't set up for this relay.",
  denied: 'Microphone access is blocked. Allow it in your browser’s site settings, then try again.',
  noDevice: 'No microphone is available.',
  device: "The microphone couldn't start.",
  dropped: 'Recording stopped when the connection dropped. Your words so far are in your answer.',
  nothing: 'No words were captured.',
  timedOut: 'Kept the words received so far. Check the ending.',
  cleanupFailed: 'Kept your original wording.',
  edited: 'You edited the text, so your wording was kept.',
  hidden: 'Recording stopped when the app was hidden. Your words so far are in your answer.',
  changed: 'Recording stopped because the question changed. Your words so far are kept.',
  capStop: 'Recording stopped at the five-minute limit. Your words so far are in your answer.',
  service: 'The dictation service did not respond. You can keep typing.',
} as const;

export const REVIEW_MS = 5_000;
export const ESC_CONFIRM_MS = 4_000;
const CAP_WARNING_MS = 15_000;

export interface DictationDeps {
  makeClient(
    opts: ConstructorParameters<typeof VoiceClient>[0],
  ): VoiceLike & { timedOut?: boolean; pendingInterim?: () => string };
  startMic(onFrame: (pcm: ArrayBuffer) => void, onLevel?: (rms: number) => void): Promise<Capture>;
  prefs(): LocalPrefs;
  /** Which providers the relay has keys for. */
  info(): { xai: boolean; openai: boolean; anthropic: boolean } | null;
  relayOrigin(): string | null;
  relay(): {
    json<T>(method: string, path: string, opts: { body: unknown }): Promise<T>;
    raw(method: string, path: string, body: unknown, signal: AbortSignal): Promise<Response>;
  } | null;
  online(): boolean;
  setConsent(): Promise<void>;
  correct?: (r: CorrectionRequest) => Promise<CorrectionOutcome>;
  now?: () => number;
  /** Ask the browser whether the microphone permission is still to be granted (to explain the prompt). */
  permissionState?: () => Promise<'granted' | 'denied' | 'prompt' | 'unknown'>;
}

export class DictationController {
  private state: DictState = IDLE;
  private listeners = new Set<() => void>();
  private session: DictationSession | null = null;
  private client: ReturnType<DictationDeps['makeClient']> | null = null;
  /** Bumps for every attempt and every cancel; a callback from an older attempt is ignored. */
  private gen = 0;
  /** Bumps when a cleanup is bypassed or superseded, so its late result is dropped. */
  private cleanGen = 0;
  /** Where the next words go, and the field text as this controller last left it. */
  private anchor: Span = { from: 0, to: 0 };
  private lastText = '';
  /** The passage written so far: [start, end) of the field, and what the field held before it began. */
  private region: { start: number; end: number } | null = null;
  private preText = '';
  private preEditGen = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private reviewTimer: ReturnType<typeof setTimeout> | undefined;
  private escTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingConsent: Binding | null = null;
  /** Raw voice level 0..1 for the orbit ring (read per animation frame, never re-rendered). */
  level = 0;

  constructor(private readonly deps: DictationDeps) {}

  /* ---------- store plumbing ---------- */

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = (): DictState => this.state;
  private set(p: Partial<DictState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  /* ---------- availability ---------- */

  /** Why dictation cannot start here, or null when it can. */
  unavailable(): 'unconfigured' | 'offline' | null {
    const info = this.deps.info();
    const v = this.deps.prefs().voice;
    if (!info || !(v.transcription === 'xai' ? info.xai : info.openai)) return 'unconfigured';
    if (!this.deps.online()) return 'offline';
    return null;
  }

  /** Capture or its cleanup has not settled: Send must wait. */
  busyFor(key: string): false | 'capturing' | 'cleaning' {
    const s = this.state;
    if (!s.binding || s.binding.key !== key) return false;
    if (s.phase === 'starting' || s.phase === 'recording' || s.phase === 'finishing')
      return 'capturing';
    if (s.phase === 'cleaning') return 'cleaning';
    return false;
  }

  isActive(): boolean {
    const p = this.state.phase;
    return p === 'starting' || p === 'recording' || p === 'finishing';
  }

  /* ---------- start ---------- */

  /** Dictate was tapped: the disclosure first if consent was never given, then the microphone. */
  request(binding: Binding): void {
    const why = this.unavailable();
    if (why) {
      this.set({
        message: { text: MESSAGES[why], tone: 'info' },
        binding: this.state.phase === 'idle' ? binding : this.state.binding,
      });
      return;
    }
    if (!this.deps.prefs().voice.consent) {
      this.pendingConsent = binding;
      this.set({ phase: 'consent', binding, message: null });
      return;
    }
    void this.start(binding);
  }

  /** "Enable and start dictation": consent is recorded only by this. */
  async acceptConsent(): Promise<void> {
    const b = this.pendingConsent;
    this.pendingConsent = null;
    await this.deps.setConsent();
    this.set({ phase: 'idle' });
    if (b) await this.start(b);
  }

  declineConsent(): void {
    this.pendingConsent = null;
    if (this.state.phase === 'consent') this.set({ phase: 'idle', binding: null });
  }

  async start(binding: Binding): Promise<void> {
    if (this.isActive()) return;
    // Dictating again during a cleanup keeps the original wording of the previous passage.
    if (this.state.phase === 'cleaning') this.cleanGen++;
    const d = drafts.get(binding.key);
    if (!d || d.epoch !== binding.epoch) return;
    const gen = ++this.gen;
    const v = this.deps.prefs().voice;
    const text = fieldValue(d, binding.field);
    const caret = d.caret?.field === binding.field ? d.caret : null;
    this.anchor = caret
      ? { from: Math.min(caret.start, text.length), to: Math.min(caret.end, text.length) }
      : { from: text.length, to: text.length };
    this.lastText = text;
    this.region = null;
    this.preText = text;
    this.preEditGen = d.editGen;
    this.level = 0;
    this.clearTimers();
    this.set({
      ...IDLE,
      phase: 'starting',
      binding,
      permission: false,
    });
    void this.deps.permissionState?.().then((p) => {
      if (this.gen === gen && this.state.phase === 'starting' && p === 'prompt')
        this.set({ permission: true });
    });

    const origin = this.deps.relayOrigin();
    const relay = this.deps.relay();
    if (!origin || !relay) {
      this.set({ ...IDLE, message: { text: MESSAGES.unconfigured, tone: 'info' } });
      return;
    }
    const keyterms = buildKeyterms(
      binding.question,
      binding.options.map((o) => o.label),
    );
    const session = new DictationSession(
      {
        makeClient: (onReady) => {
          const c = this.deps.makeClient({
            origin,
            provider: v.transcription,
            keyterms,
            language: dictationLanguage(),
            postJson: (path, body) => relay.json('POST', path, { body }),
            onState: (st) => st === 'ready' && onReady(),
            onText: (t) => this.gen === gen && this.set({ final: t.final, interim: t.interim }),
            onFinal: (t) => this.onFinal(gen, t),
            onError: () => this.onDropped(gen),
          });
          this.client = c;
          return c;
        },
        startMic: this.deps.startMic,
        onLevel: (rms) => {
          if (this.gen === gen) this.level = Math.min(1, Math.sqrt(rms * 6));
        },
        onMicLive: () => {
          if (this.gen !== gen) return;
          this.set({ micLive: true, micSilent: false, permission: false });
          announce('Recording.');
        },
        onMicSilent: () => this.gen === gen && this.set({ micSilent: true }),
        onFailure: () => this.onDropped(gen, MESSAGES.service),
        segmentAfterQuietFrames: v.transcription === 'openai' ? 7 : undefined,
      },
      (p) => {
        if (this.gen !== gen) return;
        if (p === 'listening') this.set({ phase: 'recording', permission: false });
      },
    );
    this.session = session;
    const t0 = this.now();
    try {
      const r = await session.start();
      if (r !== 'listening' || this.gen !== gen) return;
      this.set({ startedAt: this.now() });
      const cap = LIMITS.voiceMaxSessionMs;
      const elapsed = this.now() - t0;
      this.timers.push(
        setTimeout(
          () => this.gen === gen && this.set({ capWarning: true }),
          Math.max(0, cap - CAP_WARNING_MS - 1_500 - elapsed),
        ),
        setTimeout(
          () => this.gen === gen && void this.stop(MESSAGES.capStop),
          Math.max(0, cap - 1_500 - elapsed),
        ),
      );
    } catch (e) {
      if (this.gen !== gen) return;
      this.session = null;
      this.client = null;
      const text =
        e instanceof MicUnavailableError
          ? e.kind === 'denied'
            ? MESSAGES.denied
            : e.kind === 'no-device'
              ? MESSAGES.noDevice
              : e.kind === 'unsupported'
                ? e.message
                : MESSAGES.device
          : !this.deps.online()
            ? MESSAGES.offline
            : MESSAGES.service;
      this.set({
        ...IDLE,
        binding,
        message: {
          text,
          tone: 'error',
          retry: e instanceof MicUnavailableError && e.kind === 'failed',
        },
      });
    }
  }

  /* ---------- live words ---------- */

  /** One locked chunk: written into the bound draft at the anchor, live, and checkpointed. */
  private onFinal(gen: number, chunk: string) {
    if (this.gen !== gen) return;
    const b = this.state.binding;
    if (!b) return;
    const { words, breaks } = splitDictationCommands(chunk.trim());
    if (!words && !breaks) return;
    const ok = drafts.write(b.key, { epoch: b.epoch }, (d) => this.plan(d, b.field, words, breaks));
    // The draft was sent or cleared under us: nothing more may land in it.
    if (!ok) this.cancelCapture();
  }

  private plan(d: DraftModel, field: FieldId, words: string, breaks: number) {
    let text = fieldValue(d, field);
    // The person may have typed while dictating: carry the anchor and passage through their edit.
    if (text !== this.lastText) {
      this.anchor = {
        from: mapThroughEdit(this.lastText, text, this.anchor.from, -1),
        to: mapThroughEdit(this.lastText, text, this.anchor.to, 1),
      };
      if (this.region)
        this.region = {
          start: mapThroughEdit(this.lastText, text, this.region.start, -1),
          end: mapThroughEdit(this.lastText, text, this.region.end, 1),
        };
    }
    if (words) {
      const p = planVoiceWords(text, this.anchor, words);
      text = p.next;
      this.region = this.region
        ? { start: Math.min(this.region.start, p.words.from), end: p.words.to }
        : { start: p.words.from, end: p.words.to };
      this.anchor = p.anchor;
    }
    for (let i = 0; i < breaks; i++) {
      const p = planVoiceBreak(text, this.anchor);
      text = p.next;
      if (this.region) this.region = { ...this.region, end: Math.max(this.region.end, p.words.to) };
      else this.region = { start: p.words.from, end: p.words.to };
      this.anchor = p.anchor;
    }
    this.lastText = text;
    return field === 'reason'
      ? { reason: text, caret: { field, start: this.anchor.from, end: this.anchor.from } }
      : { text, caret: { field, start: this.anchor.from, end: this.anchor.from } };
  }

  /* ---------- stop ---------- */

  private onDropped(gen: number, text: string = MESSAGES.dropped) {
    if (this.gen !== gen || !this.isActive()) return;
    void this.stop(text);
  }

  /**
   * Stop: the microphone is released at once, then a bounded wait for the last words. The raw passage is in the
   * draft (and flushed to storage) before any cleanup starts. Resolves once that raw checkpoint is durable.
   */
  stop(note?: string, opts: { cleanup?: boolean } = {}): Promise<void> {
    // A second Stop while the first is finishing waits for the same raw checkpoint.
    if (this.stopping) return this.stopping;
    const run = this.doStop(note, opts).finally(() => {
      if (this.stopping === run) this.stopping = null;
    });
    this.stopping = run;
    return run;
  }

  private stopping: Promise<void> | null = null;

  private async doStop(note?: string, opts: { cleanup?: boolean } = {}): Promise<void> {
    const session = this.session;
    const b = this.state.binding;
    if (!session || !b) {
      if (this.state.phase === 'consent') this.declineConsent();
      return;
    }
    const gen = this.gen;
    if (session.phase === 'starting') {
      this.cancelCapture();
      this.set({ ...IDLE, message: note ? { text: note, tone: 'info' } : null });
      return;
    }
    this.clearTimers();
    this.set({ phase: 'finishing', capWarning: false, escArmed: false });
    announce('Recording stopped.');
    await session.finish();
    if (this.gen !== gen) return;
    const client = this.client;
    this.session = null;
    this.client = null;
    let message: DictMessage | null = note ? { text: note, tone: 'info' } : null;
    // Words heard but never locked (the provider timed out, or the connection dropped) are still the person's.
    const tail = client?.pendingInterim?.() ?? '';
    if (tail) this.onFinal(gen, tail);
    if (client?.timedOut && !note) message = { text: MESSAGES.timedOut, tone: 'warn' };
    try {
      await drafts.flush(b.key);
    } catch {
      /* the draft shows its own save failure, with Retry and Copy */
    }
    const region = this.region;
    const d = drafts.get(b.key);
    const text = d ? fieldValue(d, b.field) : '';
    const raw = region ? text.slice(region.start, region.end) : '';
    if (!region || !raw.trim() || !d || d.epoch !== b.epoch) {
      this.set({
        ...IDLE,
        binding: b,
        message: message ?? { text: MESSAGES.nothing, tone: 'info', retry: true },
      });
      return;
    }
    const passage: Passage = {
      field: b.field,
      start: region.start,
      before: text.slice(0, region.start),
      raw,
      cleaned: raw,
    };
    drafts.write(b.key, { epoch: b.epoch }, () => ({ passage }));
    if (opts.cleanup === false || !this.cleanupProvider()) {
      this.set({ ...IDLE, binding: b, message });
      return;
    }
    void this.cleanup(b, passage, message);
  }

  private cleanupProvider(): 'anthropic' | 'openai' | null {
    const v = this.deps.prefs().voice;
    const info = this.deps.info();
    if (!info || v.correction === 'off' || !this.deps.relay()) return null;
    if (v.correction === 'anthropic' && info.anthropic) return 'anthropic';
    if (v.correction === 'openai' && info.openai) return 'openai';
    return null;
  }

  private async cleanup(b: Binding, passage: Passage, message: DictMessage | null) {
    const provider = this.cleanupProvider()!;
    const relay = this.deps.relay()!;
    const cg = ++this.cleanGen;
    const d0 = drafts.get(b.key)!;
    const editGen = d0.editGen;
    const at = fieldValue(d0, b.field);
    this.set({ ...IDLE, phase: 'cleaning', binding: b, message });
    const outcome = await (this.deps.correct ?? runCorrection)({
      provider,
      raw: passage.raw,
      question: b.question,
      context: b.context,
      options: b.options,
      askedAt: b.askedAt,
      projectLabel: b.projectLabel,
      precedingText: precedingText(at, passage.start),
      transcriber: this.deps.prefs().voice.transcription,
      language: dictationLanguage(),
      editorAtStart: at,
      getEditorText: () => {
        const d = drafts.get(b.key);
        return d ? fieldValue(d, b.field) : '';
      },
      post: (path, body, signal) => relay.raw('POST', path, body, signal),
    });
    // "Use original wording", a new passage, a send or a clear got there first: the late result is dropped.
    if (cg !== this.cleanGen) return;
    const settle = (m: DictMessage | null) => this.set({ ...IDLE, binding: b, message: m });
    if (outcome.kind === 'kept-raw') {
      settle(
        outcome.reason === 'editor-changed'
          ? { text: MESSAGES.edited, tone: 'info' }
          : { text: MESSAGES.cleanupFailed, tone: 'info' },
      );
      return;
    }
    const cleaned = outcome.result.corrected_text;
    if (!outcome.changed && outcome.spans.length === 0) {
      settle(message);
      return;
    }
    let landed: Passage | null = null;
    const ok = drafts.write(b.key, { epoch: b.epoch, editGen }, (d) => {
      const text = fieldValue(d, b.field);
      const end = passage.start + passage.raw.length;
      // Edit wins: only the untouched passage, with untouched text ahead of it, is replaced.
      if (
        text.slice(0, passage.start) !== passage.before ||
        text.slice(passage.start, end) !== passage.raw
      )
        return null;
      const next = text.slice(0, passage.start) + cleaned + text.slice(end);
      landed = { ...passage, cleaned };
      const caret = {
        field: b.field,
        start: passage.start + cleaned.length,
        end: passage.start + cleaned.length,
      };
      return b.field === 'reason'
        ? { reason: next, passage: landed, caret }
        : { text: next, passage: landed, caret };
    });
    if (!ok || !landed) {
      settle({ text: MESSAGES.edited, tone: 'info' });
      return;
    }
    const d = drafts.get(b.key)!;
    const now = fieldValue(d, b.field);
    const marks = diffCorrection(passage.raw, cleaned).map((m) => ({
      ...m,
      from: m.from + passage.start,
      to: m.to + passage.start,
    }));
    const spans = outcome.spans.map((s) => ({
      ...s,
      start: s.start + passage.start,
      end: s.end + passage.start,
    }));
    this.set({
      ...IDLE,
      binding: b,
      message: outcome.lowConfidence
        ? { text: 'Tidied, but some words were guesses. Check it before sending.', tone: 'info' }
        : message,
      review: marks.length
        ? { key: b.key, field: b.field, start: passage.start, cleaned, marks }
        : null,
      unsure: spans.length ? { key: b.key, field: b.field, text: now, spans } : null,
    });
    announce('Wording tidied. Use original wording is available.');
    clearTimeout(this.reviewTimer);
    this.reviewTimer = setTimeout(() => this.set({ review: null }), REVIEW_MS);
  }

  /* ---------- after a passage ---------- */

  /**
   * Whether "Use original wording" applies to this draft now: the cleaned passage, and the text ahead of it, are
   * exactly as the cleanup left them. During cleaning it always applies (it bypasses the cleanup).
   */
  canUseOriginal(d: DraftModel): boolean {
    if (this.state.phase === 'cleaning' && this.state.binding?.key === d.key) return true;
    const p = d.passage;
    if (!p || p.raw === p.cleaned) return false;
    const text = fieldValue(d, p.field);
    return (
      text.slice(0, p.start) === p.before &&
      text.slice(p.start, p.start + p.cleaned.length) === p.cleaned
    );
  }

  /** Put back exactly what was said. Beats a cleanup still in flight. */
  useOriginal(key: string): void {
    if (this.state.phase === 'cleaning' && this.state.binding?.key === key) {
      this.cleanGen++;
      this.set({
        ...IDLE,
        binding: this.state.binding,
        message: { text: 'Kept your original wording.', tone: 'info' },
      });
      return;
    }
    const d = drafts.get(key);
    if (!d || !this.canUseOriginal(d)) return;
    const p = d.passage!;
    const text = fieldValue(d, p.field);
    const next = text.slice(0, p.start) + p.raw + text.slice(p.start + p.cleaned.length);
    const caret = { field: p.field, start: p.start + p.raw.length, end: p.start + p.raw.length };
    drafts.edit(key, {
      ...(p.field === 'reason' ? { reason: next } : { text: next }),
      passage: { ...p, cleaned: p.raw },
      caret,
    });
    this.set({
      review: null,
      unsure: null,
      message: { text: 'Back to exactly what you said.', tone: 'info' },
    });
  }

  /** Discard the passage being dictated: capture is cancelled and its words leave the draft, with Undo. */
  discard(): void {
    const b = this.state.binding;
    if (!b || !this.isActive()) return;
    const region = this.region;
    const pre = this.preText;
    const preGen = this.preEditGen;
    this.cancelCapture();
    this.set({ ...IDLE });
    const d = drafts.get(b.key);
    if (!d || d.epoch !== b.epoch || !region) return;
    const before = fieldValue(d, b.field);
    // Untouched since dictation began: back to exactly what was there. Otherwise only the passage goes.
    const next =
      d.editGen === preGen
        ? pre
        : before.slice(0, region.start).replace(/ $/, '') + before.slice(region.end);
    const patch = b.field === 'reason' ? { reason: next } : { text: next };
    drafts.edit(b.key, patch);
    drafts.offerUndo(b.key, 'Dictation discarded', () =>
      drafts.edit(b.key, b.field === 'reason' ? { reason: before } : { text: before }),
    );
    announce('Dictation discarded.');
  }

  /** Escape on desktop: the first press arms, a second within 4 s discards (Daintree's press-again rule). */
  escape(): boolean {
    if (!this.isActive()) return false;
    if (this.state.escArmed) {
      clearTimeout(this.escTimer);
      this.discard();
      return true;
    }
    this.set({ escArmed: true });
    announce('Press Escape again to discard dictation.');
    clearTimeout(this.escTimer);
    this.escTimer = setTimeout(() => this.set({ escArmed: false }), ESC_CONFIRM_MS);
    return true;
  }

  /** The unsure-word review moved on (a span resolved) or was dismissed. */
  setUnsure(u: Unsure | null): void {
    this.set({ unsure: u });
  }

  dismissMessage(): void {
    if (this.state.message) this.set({ message: null });
  }

  /** The draft this controller is bound to was sent or cleared: drop everything still in flight for it. */
  release(key: string): void {
    if (this.state.binding?.key !== key) return;
    if (this.isActive()) this.cancelCapture();
    this.cleanGen++;
    this.set({ ...IDLE });
  }

  private cancelCapture() {
    this.gen++;
    this.session?.cancel();
    this.session = null;
    this.client = null;
    this.level = 0;
    this.clearTimers();
  }

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
}

/* ---------- the app's controller ---------- */

export const dictation = new DictationController({
  makeClient: (o) => new VoiceClient(o),
  startMic: realStartMic,
  prefs: () => app.getSnapshot().prefs,
  info: () => app.getSnapshot().info?.voice ?? null,
  relayOrigin: () => app.getSnapshot().config?.relayOrigin ?? null,
  relay: () => app.getRelay(),
  online: () => app.getSnapshot().online && (globalThis.navigator?.onLine ?? true),
  setConsent: async () => {
    const v = app.getSnapshot().prefs.voice;
    await app.setPrefs({ voice: { ...v, consent: true } });
  },
  permissionState: async () => {
    try {
      const p = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
      return p?.state ?? 'unknown';
    } catch {
      return 'unknown';
    }
  },
});

if (typeof document !== 'undefined') {
  // Never keep recording while the app is hidden or the device locks; never restart on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dictation.isActive())
      void dictation.stop(MESSAGES.hidden);
  });
  // An update reload first stops capture and makes every draft durable.
  app.registerUpdateGuard(async () => {
    await dictation.stop();
    await drafts.flushAll();
    return true;
  });
}

export function useDictation(): DictState {
  return useSyncExternalStore(dictation.subscribe, dictation.getState);
}
