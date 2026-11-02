// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const state = {
    startGate: null as null | { resolve: () => void },
    micGate: null as null | { resolve: (c: { stop: () => void }) => void },
    clients: [] as { opts: Record<string, (...a: unknown[]) => void>; cancelled: boolean }[],
    micStops: 0,
    startMicCalls: 0,
    onChange: [] as string[],
    /** Answers POST /voice/correct; a 502 (clean-up unavailable) unless a test sets it. */
    correct: null as null | ((body: unknown) => Promise<Response>),
    setValue: null as null | ((v: string) => void),
  };
  return state;
});

vi.mock('../src/app/hooks.js', () => ({
  useApp: () => ({
    prefs: {
      voice: {
        consent: true,
        transcription: 'xai',
        correction: 'anthropic',
        mode: (globalThis as { __mode?: string }).__mode ?? 'hold',
      },
    },
    info: { voice: { xai: true, anthropic: true, openai: false } },
    config: { relayOrigin: 'https://relay.example' },
  }),
}));
vi.mock('../src/app/controller.js', () => ({
  app: {
    getRelay: () => ({
      json: async () => ({}),
      raw: async (_m: string, _p: string, body: unknown) =>
        h.correct ? h.correct(body) : new Response('{}', { status: 502 }),
    }),
    setPrefs: async () => undefined,
  },
}));
vi.mock('../src/features/voice/capture.js', () => ({
  MicUnavailableError: class MicUnavailableError extends Error {},
  startMic: () => {
    h.startMicCalls++;
    return new Promise((res) => {
      h.micGate = { resolve: res as (c: { stop: () => void }) => void };
    });
  },
}));
vi.mock('../src/features/voice/client.js', () => ({
  VoiceClient: class {
    cancelled = false;
    constructor(public opts: Record<string, (...a: unknown[]) => void>) {
      h.clients.push(this as never);
    }
    start() {
      return new Promise<void>((res) => {
        h.startGate = {
          resolve: () => {
            res();
            this.opts.onState?.('ready');
          },
        };
      });
    }
    sendAudio() {}
    async stop() {
      return 'hello world';
    }
    cancel() {
      this.cancelled = true;
    }
  },
}));

import { VoiceInput } from '../src/features/voice/VoiceInput.js';

const view = {
  createdAt: '2026-11-02T10:00:00.000Z',
  content: { question: 'Ship it?', options: [{ id: 'yes', label: 'Yes' }] },
} as never;
let root: Root;
let host: HTMLElement;

const render = (disabled = false) =>
  act(async () => {
    root.render(
      createElement(VoiceInput, {
        value: '',
        onChange: (v: string) => h.onChange.push(v),
        view,
        disabled,
      }),
    );
  });
/** A parent that keeps the answer text, as the answer editor does. */
function Host() {
  const [value, setValue] = useState('');
  h.setValue = setValue;
  return createElement(VoiceInput, {
    value,
    onChange: (v: string) => {
      h.onChange.push(v);
      setValue(v);
    },
    view,
  });
}
const renderHost = () => act(async () => root.render(createElement(Host)));
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name) as
    HTMLButtonElement | undefined;
const cleaned = (corrected: string) =>
  new Response(
    JSON.stringify({
      model: 'claude-haiku-5-5',
      result: {
        corrected_text: corrected,
        uncertain_spans: [],
        applied_commands: [],
        warnings: [],
      },
    }),
  );
/** Tap to start, let the provider and microphone come up, tap to finish: "hello world" is dictated. */
async function dictate() {
  await act(async () => mic().click());
  await act(async () => h.startGate!.resolve());
  await flush();
  await act(async () => h.micGate!.resolve({ stop: () => void h.micStops++ }));
  await flush();
  await act(async () => mic().click());
}
const mic = () => host.querySelector('button.mic') as HTMLButtonElement;
const pointer = (type: string) =>
  act(async () => {
    mic().dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
  });
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  h.startGate = h.micGate = null;
  h.clients.length = 0;
  h.micStops = h.startMicCalls = 0;
  h.onChange.length = 0;
  h.correct = null;
  h.setValue = null;
  (globalThis as { __mode?: string }).__mode = 'hold';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('hold-to-talk', () => {
  it('release during the provider handshake never reaches the microphone', async () => {
    await render();
    await pointer('pointerdown');
    expect(h.clients).toHaveLength(1);
    await pointer('pointerup'); // let go before the session is even ready
    await act(async () => h.startGate!.resolve());
    await flush();
    expect(h.startMicCalls).toBe(0);
    expect(h.clients[0]!.cancelled).toBe(true);
    expect(mic().textContent).toMatch(/Hold to dictate/);
  });

  it('pointercancel during microphone permission stops the capture that arrives late', async () => {
    await render();
    await pointer('pointerdown');
    await act(async () => h.startGate!.resolve());
    await flush();
    expect(h.startMicCalls).toBe(1);
    await pointer('pointercancel');
    await act(async () => h.micGate!.resolve({ stop: () => void h.micStops++ }));
    await flush();
    expect(h.micStops).toBe(1);
    expect(mic().textContent).toMatch(/Hold to dictate/);
    expect(h.onChange).toEqual([]); // nothing was dictated, nothing was inserted
  });

  it('the button stays pressable while connecting so the release can reach it', async () => {
    await render();
    await pointer('pointerdown');
    expect(mic().disabled).toBe(false);
    await pointer('pointerup');
  });
});

describe('disabling the editor', () => {
  it('stops capture and keeps the words so far when the editor locks mid-dictation', async () => {
    (globalThis as { __mode?: string }).__mode = 'tap';
    await render();
    await act(async () => mic().click());
    await act(async () => h.startGate!.resolve());
    await flush();
    await act(async () => h.micGate!.resolve({ stop: () => void h.micStops++ }));
    await flush();
    expect(mic().textContent).toMatch(/Tap to finish/);
    // Another device commits a newer revision: the editor becomes stale and passes disabled.
    await render(true);
    await flush();
    await flush();
    expect(h.micStops).toBe(1);
    expect(h.onChange).toEqual(['hello world']);
  });

  it('an unmount mid-startup cancels instead of leaving the microphone to start later', async () => {
    (globalThis as { __mode?: string }).__mode = 'tap';
    await render();
    await act(async () => mic().click());
    await act(async () => h.startGate!.resolve());
    await flush();
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => h.micGate!.resolve({ stop: () => void h.micStops++ }));
    await flush();
    expect(h.micStops).toBe(1);
  });
});

describe('clean-up lands as written, and the person stays in control', () => {
  it('replaces the dictated words, sends the question as context, and goes back in one tap', async () => {
    (globalThis as { __mode?: string }).__mode = 'tap';
    let sent: Record<string, unknown> = {};
    h.correct = async (body) => {
      sent = body as Record<string, unknown>;
      return cleaned('Hello, world.');
    };
    await renderHost();
    await dictate();
    await flush();
    expect(h.onChange).toEqual(['hello world', 'Hello, world.']);
    expect(sent).toMatchObject({
      raw_transcript: 'hello world',
      question: 'Ship it?',
      options: [{ label: 'Yes' }],
      asked_at: '2026-11-02T10:00:00.000Z',
      transcriber: 'xai',
    });
    expect(host.textContent).toMatch(/Cleaned up/);
    await act(async () => button('Use what I said')!.click());
    expect(h.onChange.at(-1)).toBe('hello world');
    expect(button('Use what I said')).toBeUndefined();
  });

  it('never overwrites text the person edited while the clean-up was running', async () => {
    (globalThis as { __mode?: string }).__mode = 'tap';
    let answer: (r: Response) => void = () => undefined;
    h.correct = () => new Promise<Response>((res) => (answer = res));
    await renderHost();
    await dictate();
    await flush();
    await act(async () => h.setValue!('hello world, and keep the old one'));
    await act(async () => answer(cleaned('Hello, world.')));
    await flush();
    expect(h.onChange).toEqual(['hello world']);
    expect(host.textContent).toMatch(/You edited the text/);
    expect(button('Use what I said')).toBeUndefined();
  });

  it('offers no way back once the cleaned text was edited', async () => {
    (globalThis as { __mode?: string }).__mode = 'tap';
    h.correct = async () => cleaned('Hello, world.');
    await renderHost();
    await dictate();
    await flush();
    expect(button('Use what I said')).toBeDefined();
    await act(async () => h.setValue!('Hello, world. Also ship it.'));
    expect(button('Use what I said')).toBeDefined(); // the cleaned passage itself is untouched
    await act(async () => h.setValue!('Hello world. Also ship it.'));
    expect(button('Use what I said')).toBeUndefined();
  });

  it('offers no way back once the text ahead of the passage changed, even if its offsets still match', async () => {
    (globalThis as { __mode?: string }).__mode = 'tap';
    h.correct = async () => cleaned('Hello, world.');
    await renderHost();
    await act(async () => h.setValue!('Hi. '));
    await dictate();
    await flush();
    expect(h.onChange.at(-1)).toBe('Hi. Hello, world.');
    expect(button('Use what I said')).toBeDefined();
    // The same words now sit where the passage was, but they are the person's own: never rewrite those.
    await act(async () => h.setValue!('Ok, Hello, world. Hello, world.'));
    expect(button('Use what I said')).toBeUndefined();
  });
});
