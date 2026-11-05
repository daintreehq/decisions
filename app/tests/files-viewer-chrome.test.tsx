// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDescriptor } from '@daintreehq/decisions-protocol';
import type { QuestionView } from '../src/domain/model.js';
import type { DictState } from '../src/features/voice/dictation.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Dictation is a controllable stand-in: the viewer only reads its state and calls Stop.
const dict = vi.hoisted(() => ({
  state: { phase: 'idle', startedAt: null } as unknown as DictState,
  stop: vi.fn(async () => undefined),
}));
vi.mock('../src/features/voice/dictation.js', () => ({
  useDictation: () => dict.state,
  dictation: { stop: dict.stop },
}));

import { Viewer } from '../src/components/files/Viewer.js';
import type { FilesModel } from '../src/components/files/model.js';
import { FIT_NORMAL } from '../src/components/files/zoom.js';
import { onAnnounce } from '../src/lib/announce.js';

const descs: AttachmentDescriptor[] = [1, 2].map((n) => ({
  attachment_id: `att${n}`,
  role: 'other',
  mime: 'image/png',
  size: 10,
  sha256: String(n).repeat(64),
  nonce: 'n'.repeat(16),
  key_epoch: 1,
}));
const items = descs.map((d, index) => ({
  d,
  index,
  label: `Image ${index + 1}`,
  spoken: `Image ${index + 1}`,
  key: `${d.attachment_id}:${d.sha256}`,
}));

function model(): FilesModel {
  return {
    view: { id: 'q1', revision: 1, content: { question: 'Ship it?' } } as unknown as QuestionView,
    items,
    results: Object.fromEntries(
      descs.map((d) => [
        d.attachment_id,
        {
          ok: true,
          image: { url: `blob:test/${d.attachment_id}`, sha256: d.sha256, mime: 'image/png' },
        },
      ]),
    ),
    naturals: Object.fromEntries(descs.map((d) => [d.attachment_id, { w: 800, h: 600 }])),
    onNatural: () => undefined,
    retry: () => undefined,
    zoomOf: () => FIT_NORMAL,
    setZoom: vi.fn(),
    present: () => undefined,
  };
}

/** Where the image area sits with the chrome shown, in viewport px. */
const TRACK = { top: 56, left: 0, width: 400, height: 600 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let announced: string[] = [];
let stopAnnounce: (() => void) | null = null;
let m: FilesModel;
let onClose: ReturnType<typeof vi.fn>;

function props(active = 0) {
  return {
    model: m,
    active,
    onActive: () => undefined,
    onClose,
    onQuestion: () => undefined,
    focusFallback: () => null,
    covered: false,
  };
}

async function render(active = 0) {
  await act(async () => root!.render(createElement(Viewer, props(active))));
}

const viewer = () => document.querySelector<HTMLElement>('.fx-viewer')!;
const stage = () => document.querySelector<HTMLElement>('.fx-viewer-stage')!;
const bare = () => viewer().classList.contains('is-bare');

let clock = 1000;
function pointer(type: string, x: number, y: number, id = 1) {
  const e = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: id,
    pointerType: 'touch',
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(e, 'timeStamp', { value: clock });
  act(() => void stage().dispatchEvent(e));
}
function tap(x = 200, y = 300) {
  pointer('pointerdown', x, y);
  clock += 60;
  pointer('pointerup', x, y);
}
const wait = (ms: number) => {
  clock += ms;
  act(() => void vi.advanceTimersByTime(ms));
};
function key(el: HTMLElement, k: string, init: KeyboardEventInit = {}) {
  act(
    () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })),
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...TRACK,
    x: TRACK.left,
    y: TRACK.top,
    right: TRACK.left + TRACK.width,
    bottom: TRACK.top + TRACK.height,
    toJSON: () => ({}),
  } as DOMRect);
  dict.state = { phase: 'idle', startedAt: null } as unknown as DictState;
  dict.stop.mockClear();
  announced = [];
  stopAnnounce = onAnnounce((msg) => announced.push(msg));
  m = model();
  onClose = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = host = null;
  stopAnnounce?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the viewer chrome toggle', () => {
  it('a single tap hides the bar and the tools once the double-tap window has passed', () => {
    tap();
    wait(200);
    expect(bare()).toBe(false);
    wait(150);
    expect(bare()).toBe(true);
    expect(document.querySelector('.fx-bar')!.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.fx-tools')!.hasAttribute('inert')).toBe(true);
    expect(announced.at(-1)).toMatch(/Controls hidden.*Space to show them/);
    expect(stage().getAttribute('aria-label')).toMatch(/Controls hidden/);

    // Another tap brings it all back.
    wait(400);
    tap();
    wait(350);
    expect(bare()).toBe(false);
    expect(document.querySelector('.fx-bar')!.hasAttribute('inert')).toBe(false);
    expect(announced.at(-1)).toBe('Controls shown.');
  });

  it('keeps the image area where it was: the shown layout’s rect pins the track', () => {
    tap();
    wait(350);
    const s = viewer().style;
    expect(s.getPropertyValue('--fx-bare-t')).toBe('56px');
    expect(s.getPropertyValue('--fx-bare-l')).toBe('0px');
    expect(s.getPropertyValue('--fx-bare-w')).toBe('400px');
    expect(s.getPropertyValue('--fx-bare-h')).toBe('600px');
    // A new viewport has no "where it was": the image area takes the whole stage.
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(bare()).toBe(true);
    expect(viewer().style.getPropertyValue('--fx-bare-t')).toBe('');
  });

  it('a double-tap zooms and never toggles, not even for a moment', () => {
    tap();
    wait(150);
    tap();
    expect(m.setZoom).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) {
      wait(100);
      expect(bare()).toBe(false);
    }
  });

  it('a drag or a pinch never toggles', () => {
    pointer('pointerdown', 200, 300);
    clock += 40;
    pointer('pointermove', 200, 360);
    clock += 40;
    pointer('pointerup', 200, 360);
    wait(500);
    expect(bare()).toBe(false);

    pointer('pointerdown', 150, 300, 1);
    pointer('pointerdown', 250, 300, 2);
    clock += 40;
    pointer('pointerup', 150, 300, 1);
    pointer('pointerup', 250, 300, 2);
    wait(500);
    expect(bare()).toBe(false);
  });

  it('Space on the stage toggles; Space on a control is the control’s own', () => {
    key(stage(), ' ');
    expect(bare()).toBe(true);
    key(stage(), ' ', { repeat: true });
    expect(bare()).toBe(true);
    key(stage(), ' ');
    expect(bare()).toBe(false);
    key(document.querySelector<HTMLElement>('.fx-tools button')!, ' ');
    expect(bare()).toBe(false);
  });

  it('hiding never strands focus on a hidden control', () => {
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close viewer"]')!;
    close.focus();
    tap();
    wait(350);
    expect(bare()).toBe(true);
    expect(document.activeElement).toBe(stage());
  });

  it('stays hidden on another file, and Escape still closes', async () => {
    tap();
    wait(350);
    await render(1);
    expect(bare()).toBe(true);
    key(stage(), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a file change cancels a tap still waiting out the double-tap window', async () => {
    tap();
    await render(1);
    wait(400);
    expect(bare()).toBe(false);
  });

  it('opening the viewer again starts with the chrome shown', async () => {
    tap();
    wait(350);
    await act(async () => root!.unmount());
    root = createRoot(host!);
    await render();
    expect(bare()).toBe(false);
  });

  it('Stop stays on screen while recording, and only stops', async () => {
    tap();
    wait(350);
    expect(document.querySelector('.fx-stop')).toBeNull();

    dict.state = { phase: 'recording', startedAt: Date.now() } as unknown as DictState;
    await render();
    const stop = document.querySelector<HTMLButtonElement>('.fx-stop-btn')!;
    expect(stop.getAttribute('aria-label')).toBe('Stop dictation');
    expect(document.querySelector('.fx-stop')!.textContent).toMatch(/Recording/);
    act(() => stop.click());
    expect(dict.stop).toHaveBeenCalledTimes(1);

    // Finishing: shown, but a second press does nothing.
    dict.state = { phase: 'finishing', startedAt: null } as unknown as DictState;
    await render();
    act(() => document.querySelector<HTMLButtonElement>('.fx-stop-btn')!.click());
    expect(dict.stop).toHaveBeenCalledTimes(1);

    // With the chrome shown, the dock's own Stop is on screen instead.
    dict.state = { phase: 'recording', startedAt: Date.now() } as unknown as DictState;
    key(stage(), ' ');
    expect(document.querySelector('.fx-stop')).toBeNull();
  });
});
