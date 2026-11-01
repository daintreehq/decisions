// @vitest-environment happy-dom
import { act, createElement } from 'react';
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
      raw: async () => new Response('{}', { status: 502 }),
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

const view = { content: { question: 'Ship it?', options: [{ id: 'yes', label: 'Yes' }] } } as never;
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
