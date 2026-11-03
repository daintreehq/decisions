// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The app the dictation owner and the draft store talk to, with drafts kept in memory. */
const h = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  prefs: {
    theme: 'system',
    dismissedInstall: false,
    voice: { consent: true, transcription: 'xai', correction: 'anthropic', mode: 'tap' },
  },
}));
vi.mock('../src/app/controller.js', () => ({
  app: {
    subscribe: () => () => undefined,
    getSnapshot: () => ({ phase: 'ready', prefs: h.prefs, online: true, info: null, config: null }),
    getRelay: () => null,
    registerUpdateGuard: () => () => undefined,
    drafts: {
      save: async (k: string, d: unknown) => void h.stored.set(k, structuredClone(d)),
      load: async (k: string) => (h.stored.get(k) as never) ?? null,
      delete: async (k: string) => void h.stored.delete(k),
    },
  },
}));

import { drafts } from '../src/features/compose/draftStore.js';
import {
  DictationController,
  MESSAGES,
  type Binding,
  type DictationDeps,
} from '../src/features/voice/dictation.js';
import type { CorrectionOutcome } from '../src/features/voice/correction.js';
import { composeShape, verdict } from '../src/domain/compose.js';
import { DictateButton } from '../src/components/workspace/AnswerDock.js';

interface FakeClient {
  opts: Record<string, (...a: unknown[]) => void>;
  cancelled: boolean;
  stopped: boolean;
  timedOut: boolean;
  interim: string;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

/** A dictation owner wired to fakes: a client the test speaks through, a microphone gate and a cleanup gate. */
function rig(over: Partial<DictationDeps> = {}) {
  const clients: FakeClient[] = [];
  const mic = { gate: deferred<{ stop: () => void }>(), stops: 0, calls: 0 };
  const cleanup = { gate: null as null | ReturnType<typeof deferred<CorrectionOutcome>>, calls: 0 };
  const deps: DictationDeps = {
    makeClient: (o) => {
      const c: FakeClient = {
        opts: o as never,
        cancelled: false,
        stopped: false,
        timedOut: false,
        interim: '',
      };
      clients.push(c);
      return {
        start: async () => void queueMicrotask(() => c.opts.onState?.('ready')),
        sendAudio: () => undefined,
        stop: async () => {
          c.stopped = true;
          return '';
        },
        cancel: () => void (c.cancelled = true),
        get timedOut() {
          return c.timedOut;
        },
        pendingInterim: () => c.interim,
      };
    },
    startMic: () => {
      mic.calls++;
      return mic.gate.promise;
    },
    prefs: () => h.prefs as never,
    info: () => ({ xai: true, openai: false, anthropic: true }),
    relayOrigin: () => 'https://relay.example',
    relay: () => ({ json: async () => ({}) as never, raw: async () => new Response('{}') }),
    online: () => true,
    setConsent: async () => void (h.prefs.voice.consent = true),
    correct: async () => {
      cleanup.calls++;
      cleanup.gate = deferred<CorrectionOutcome>();
      return cleanup.gate.promise;
    },
    ...over,
  };
  const d = new DictationController(deps);
  return {
    d,
    clients,
    mic,
    cleanup,
    say: (text: string) => act(async () => clients.at(-1)!.opts.onFinal?.(text)),
    async listen() {
      mic.gate.resolve({ stop: () => void mic.stops++ });
      await flush();
      await flush();
    },
  };
}

let seq = 0;
function bindingFor(text = '', caret?: number): Binding {
  const questionId = `q_test_${++seq}`;
  const draft = drafts.ensure(questionId, 'answer', 0);
  if (text) drafts.edit(draft.key, { text });
  if (caret !== undefined) drafts.setCaret(draft.key, { field: 'text', start: caret, end: caret });
  const now = drafts.get(draft.key)!;
  return {
    questionId,
    revision: 0,
    mode: 'answer',
    field: 'text',
    key: now.key,
    epoch: now.epoch,
    question: 'Which version should the guide describe?',
    options: [],
  };
}
const text = (b: Binding) => drafts.get(b.key)!.text;
const cleaned = (corrected: string): CorrectionOutcome => ({
  kind: 'applied',
  result: { corrected_text: corrected, uncertain_spans: [], applied_commands: [], warnings: [] },
  model: 'claude-haiku',
  spans: [],
  changed: true,
  lowConfidence: false,
});

beforeEach(() => {
  h.stored.clear();
  h.prefs.voice = { consent: true, transcription: 'xai', correction: 'anthropic', mode: 'tap' };
});

describe('words land live, at the caret, and only finalized words', () => {
  it('writes each finalized chunk into the draft at the caret captured when recording started', async () => {
    const t = rig();
    const b = bindingFor('Use v3. Thanks', 7);
    const started = t.d.start(b);
    await t.listen();
    await started;
    expect(t.d.getState().phase).toBe('recording');
    await t.say('and move v2 to an appendix');
    // Live: in the draft before Stop.
    expect(text(b)).toBe('Use v3. and move v2 to an appendix Thanks');
    // Interim words are shown, never written.
    await act(async () => t.clients[0]!.opts.onText?.({ final: 'x', interim: 'at the' }));
    expect(text(b)).toBe('Use v3. and move v2 to an appendix Thanks');
    expect(t.d.getState().interim).toBe('at the');
  });

  it('turns a spoken "new line" and "new paragraph" into breaks, and nothing else', async () => {
    const t = rig({ correct: undefined });
    h.prefs.voice.correction = 'off';
    const b = bindingFor();
    const started = t.d.start(b);
    await t.listen();
    await started;
    await t.say('first point new line');
    await t.say('second point. New paragraph.');
    await t.say('send it');
    expect(text(b)).toBe('first point\nsecond point.\n\nsend it');
  });
});

describe('the capture-versus-send gate', () => {
  it('holds Send while starting, recording, finishing and cleaning, and releases it once settled', async () => {
    const t = rig();
    const b = bindingFor();
    const shape = composeShape(
      {
        content_version: 1,
        question: 'Q',
        kind: 'text',
        options: [],
        attachments: [],
        allow_text: true,
      },
      'answer',
    );
    const can = () =>
      verdict({
        shape,
        mode: 'answer',
        selected: [],
        text: text(b),
        reason: '',
        attachments: 0,
        evidence: { total: 0, loaded: 0, expired: 0, failed: 0 },
        stale: false,
        capturing: t.d.busyFor(b.key),
      }).canSend;
    const starting = t.d.start(b);
    expect(t.d.busyFor(b.key)).toBe('capturing');
    await t.listen();
    await starting;
    await t.say('ship it');
    expect(text(b)).toBe('ship it');
    expect(can()).toBe(false); // words are there, but capture has not settled
    const stopping = act(() => t.d.stop());
    expect(t.d.busyFor(b.key)).toBe('capturing');
    await stopping;
    expect(t.d.busyFor(b.key)).toBe('cleaning');
    expect(can()).toBe(false);
    await act(async () => t.cleanup.gate!.resolve(cleaned('Ship it.')));
    await flush();
    expect(t.d.busyFor(b.key)).toBe(false);
    expect(can()).toBe(true);
  });

  it('a draft sent mid-dictation refuses every later word and cancels capture', async () => {
    const t = rig();
    const b = bindingFor();
    const started = t.d.start(b);
    await t.listen();
    await started;
    await t.say('first');
    await act(() => drafts.sent(b.key));
    await t.say('second');
    expect(text(b)).toBe('');
    expect(t.mic.stops).toBe(1);
    expect(t.clients[0]!.cancelled).toBe(true);
  });
});

describe('cleanup lands only on its own untouched passage', () => {
  async function dictated(t: ReturnType<typeof rig>, before = '') {
    const b = bindingFor(before);
    const started = t.d.start(b);
    await t.listen();
    await started;
    await t.say('hello world');
    await act(() => t.d.stop());
    return b;
  }

  it('replaces the passage, sends the question as context, underlines what changed, and goes back in one tap', async () => {
    let sent: Record<string, unknown> = {};
    const t = rig({
      correct: async (req) => {
        sent = req as never;
        return cleaned('Hello, whole world.');
      },
    });
    const b = await dictated(t, 'Hi.');
    await flush();
    expect(sent).toMatchObject({
      raw: 'hello world',
      question: 'Which version should the guide describe?',
      precedingText: 'Hi.',
    });
    expect(text(b)).toBe('Hi. Hello, whole world.');
    // Punctuation and a sentence's capital land quietly; the new word is underlined, with what was heard.
    const marks = t.d.getState().review!.marks;
    expect(marks.map((m) => text(b).slice(m.from, m.to))).toEqual(['whole']);
    expect(t.d.canUseOriginal(drafts.get(b.key)!)).toBe(true);
    act(() => t.d.useOriginal(b.key));
    expect(text(b)).toBe('Hi. hello world');
    expect(t.d.canUseOriginal(drafts.get(b.key)!)).toBe(false);
  });

  it('never overwrites text the person edited while the cleanup was running', async () => {
    const t = rig();
    const b = await dictated(t);
    expect(t.d.getState().phase).toBe('cleaning');
    act(() => drafts.edit(b.key, { text: 'hello world, and keep the old one' }));
    await act(async () => t.cleanup.gate!.resolve(cleaned('Hello, world.')));
    await flush();
    expect(text(b)).toBe('hello world, and keep the old one');
    expect(t.d.getState().message?.text).toBe(MESSAGES.edited);
    expect(t.d.canUseOriginal(drafts.get(b.key)!)).toBe(false);
  });

  it('"Use original wording" beats a cleanup that arrives later', async () => {
    const t = rig();
    const b = await dictated(t);
    expect(t.d.busyFor(b.key)).toBe('cleaning');
    act(() => t.d.useOriginal(b.key));
    expect(t.d.busyFor(b.key)).toBe(false); // Send is free at once
    await act(async () => t.cleanup.gate!.resolve(cleaned('Hello, world.')));
    await flush();
    expect(text(b)).toBe('hello world');
  });

  it('offers no way back once the cleaned passage, or the text ahead of it, changed', async () => {
    const t = rig({ correct: async () => cleaned('Hello, world.') });
    const b = await dictated(t, 'Hi.');
    await flush();
    expect(text(b)).toBe('Hi. Hello, world.');
    act(() => drafts.edit(b.key, { text: 'Hi. Hello, world. Also ship it.' }));
    expect(t.d.canUseOriginal(drafts.get(b.key)!)).toBe(true); // the passage itself is untouched
    act(() => drafts.edit(b.key, { text: 'Ok, Hello, world. Also ship it.' }));
    expect(t.d.canUseOriginal(drafts.get(b.key)!)).toBe(false);
    act(() => drafts.edit(b.key, { text: 'Hi. Hello world. Also ship it.' }));
    expect(t.d.canUseOriginal(drafts.get(b.key)!)).toBe(false);
  });

  it('keeps the raw words when the cleanup fails', async () => {
    const t = rig({ correct: async () => ({ kind: 'kept-raw', reason: 'timeout' }) });
    const b = await dictated(t);
    await flush();
    expect(text(b)).toBe('hello world');
    expect(t.d.getState().message?.text).toBe(MESSAGES.cleanupFailed);
  });
});

describe('navigation during dictation', () => {
  it('Stop & questions leaves the words only in the original draft, late words and late cleanup included', async () => {
    const t = rig();
    const a = bindingFor();
    const started = t.d.start(a);
    await t.listen();
    await started;
    await t.say('for the first question');
    // Stop & questions: stop at once; the person picks another question while the last words are finishing.
    const stopping = t.d.stop();
    const other = bindingFor();
    act(() => drafts.edit(other.key, { text: 'typed in the second' }));
    await t.say('and its last words');
    await act(() => stopping);
    await act(async () =>
      t.cleanup.gate!.resolve(cleaned('For the first question and its last words.')),
    );
    await flush();
    expect(text(a)).toBe('For the first question and its last words.');
    expect(text(other)).toBe('typed in the second');
    // The raw words were checkpointed to storage before the cleanup.
    expect((h.stored.get(a.key) as { text: string }).text).toMatch(/first question/);
    expect(h.stored.get(other.key) as { text: string } | undefined).not.toMatchObject({
      text: expect.stringMatching(/first question/),
    });
  });

  it('a release during microphone permission stops the capture that arrives late, and writes nothing', async () => {
    const t = rig();
    const b = bindingFor();
    const starting = t.d.start(b);
    await flush();
    expect(t.mic.calls).toBe(1);
    await act(() => t.d.stop()); // hold-to-talk released before the permission resolved
    t.mic.gate.resolve({ stop: () => void t.mic.stops++ });
    await starting;
    await flush();
    expect(t.mic.stops).toBe(1);
    expect(t.d.getState().phase).toBe('idle');
    expect(text(b)).toBe('');
  });

  it('a connection drop stops recording and keeps the words, including ones not yet locked', async () => {
    const t = rig({ correct: undefined });
    h.prefs.voice.correction = 'off';
    const b = bindingFor();
    const started = t.d.start(b);
    await t.listen();
    await started;
    await t.say('kept words');
    t.clients[0]!.interim = 'and these';
    await act(async () => t.clients[0]!.opts.onError?.('Dictation stopped unexpectedly'));
    await flush();
    expect(text(b)).toBe('kept words and these');
    expect(t.d.getState().message?.text).toBe(MESSAGES.dropped);
  });
});

describe('discard', () => {
  it('Escape twice discards the passage, with Undo', async () => {
    const t = rig();
    const b = bindingFor('Already here.');
    const started = t.d.start(b);
    await t.listen();
    await started;
    await t.say('scratch that');
    expect(text(b)).toBe('Already here. scratch that');
    act(() => void t.d.escape());
    expect(t.d.getState().escArmed).toBe(true);
    expect(text(b)).toBe('Already here. scratch that');
    act(() => void t.d.escape());
    expect(text(b)).toBe('Already here.');
    expect(t.mic.stops).toBe(1);
    act(() => drafts.get(b.key)!.undo!.restore());
    expect(text(b)).toBe('Already here. scratch that');
  });
});

describe('first use', () => {
  it('asks before the microphone, and consent comes only from "Enable and start dictation"', async () => {
    h.prefs.voice.consent = false;
    const t = rig();
    const b = bindingFor();
    act(() => t.d.request(b));
    expect(t.d.getState().phase).toBe('consent');
    expect(t.mic.calls).toBe(0);
    act(() => t.d.declineConsent());
    expect(h.prefs.voice.consent).toBe(false);
    act(() => t.d.request(b));
    void t.d.acceptConsent();
    await flush();
    expect(h.prefs.voice.consent).toBe(true);
    expect(t.mic.calls).toBe(1);
  });

  it('says why when dictation is not set up or offline, without touching the microphone', () => {
    const t = rig({ info: () => ({ xai: false, openai: false, anthropic: false }) });
    act(() => t.d.request(bindingFor()));
    expect(t.d.getState().message?.text).toBe(MESSAGES.unconfigured);
    const u = rig({ online: () => false });
    act(() => u.d.request(bindingFor()));
    expect(u.d.getState().message?.text).toBe(MESSAGES.offline);
    expect(t.mic.calls + u.mic.calls).toBe(0);
  });
});

describe('the Dictate button', () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const idle = {
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
  } as const;

  it('stays pressable while starting so a hold-to-talk release can reach it', () => {
    const onHoldEnd = vi.fn();
    act(() =>
      root.render(
        createElement(DictateButton, {
          dict: { ...idle, phase: 'starting' },
          holdMode: true,
          fieldLabel: 'answer',
          onToggle: () => undefined,
          onHoldStart: () => undefined,
          onHoldEnd,
        }),
      ),
    );
    const btn = host.querySelector('button')!;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Cancel dictation');
    act(() => void btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })));
    expect(onHoldEnd).toHaveBeenCalled();
  });

  it('is Stop, not Send, while recording', () => {
    act(() =>
      root.render(
        createElement(DictateButton, {
          dict: { ...idle, phase: 'recording', micLive: true, startedAt: Date.now() },
          holdMode: false,
          fieldLabel: 'answer',
          onToggle: () => undefined,
          onHoldStart: () => undefined,
          onHoldEnd: () => undefined,
        }),
      ),
    );
    const btn = host.querySelector('button')!;
    expect(btn.getAttribute('aria-label')).toBe('Stop dictation');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).not.toMatch(/Send/);
  });
});
