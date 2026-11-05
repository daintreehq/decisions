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

/** Where each part sits with the chrome shown, in viewport px: a phone-width image area under the bar. */
type Box = { top: number; left: number; width: number; height: number };
let boxes: Record<string, Box>;
const phone = (): Record<string, Box> => ({
  'fs-track': { top: 56, left: 0, width: 400, height: 600 },
  'fx-bar': { top: 0, left: 0, width: 400, height: 56 },
  'fx-tools': { top: 600, left: 120, width: 160, height: 48 },
  other: { top: 56, left: 0, width: 400, height: 664 },
});
function rectOf(el: HTMLElement): DOMRect {
  const k = Object.keys(boxes).find((c) => el.classList.contains(c)) ?? 'other';
  const b = boxes[k]!;
  return {
    ...b,
    x: b.left,
    y: b.top,
    right: b.left + b.width,
    bottom: b.top + b.height,
    toJSON: () => ({}),
  } as DOMRect;
}

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
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  boxes = phone();
  Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return rectOf(this);
  });
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
  const inert = (sel: string) => document.querySelector(sel)!.hasAttribute('inert');

  it('a single tap hides the bar and the tools once the double-tap window has passed', () => {
    expect(stage().getAttribute('aria-label')).toMatch(/Tap or press Space to hide the controls/);
    tap();
    wait(200);
    expect(bare()).toBe(false);
    expect(announced).toEqual([]);
    wait(150);
    expect(bare()).toBe(true);
    expect(inert('.fx-bar')).toBe(true);
    expect(inert('.fx-tools')).toBe(true);
    expect(announced).toEqual(['Controls hidden. Tap the image or press Space to show them.']);
    expect(stage().getAttribute('aria-label')).toMatch(/Controls hidden: tap or press Space/);

    // Another tap brings it all back.
    wait(400);
    tap();
    wait(350);
    expect(bare()).toBe(false);
    expect(inert('.fx-bar')).toBe(false);
    expect(inert('.fx-tools')).toBe(false);
    expect(announced.at(-1)).toBe('Controls shown.');
    expect(stage().getAttribute('aria-label')).toMatch(/Tap or press Space to hide the controls/);
  });

  it('pins the image area and the bars where the shown layout had them', () => {
    tap();
    wait(350);
    const v = (k: string) => viewer().style.getPropertyValue(k);
    // The track's own rect, not the stage's or the viewer's.
    expect([v('--fx-bare-t'), v('--fx-bare-l'), v('--fx-bare-w'), v('--fx-bare-h')]).toEqual([
      '56px',
      '0px',
      '400px',
      '600px',
    ]);
    expect([v('--fx-bare-bar-t'), v('--fx-bare-bar-l'), v('--fx-bare-bar-w')]).toEqual([
      '0px',
      '0px',
      '400px',
    ]);
    expect([v('--fx-bare-tools-t'), v('--fx-bare-tools-l'), v('--fx-bare-tools-w')]).toEqual([
      '600px',
      '120px',
      '160px',
    ]);
    // On a phone the image area spans the screen, so its neighbours stay laid out for a swipe.
    expect(viewer().classList.contains('is-inset')).toBe(false);
    // A new viewport has no "where it was": the image area takes the whole stage.
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(bare()).toBe(true);
    expect(v('--fx-bare-t')).toBe('');
  });

  it('beside a sidebar, the image area is marked inset so its neighbours stay out of sight', () => {
    boxes['fx-bar'] = { top: 32, left: 320, width: 960, height: 56 };
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    boxes['fs-track'] = { top: 56, left: 320, width: 960, height: 600 };
    tap();
    wait(350);
    expect(viewer().classList.contains('is-inset')).toBe(true);
    expect(viewer().style.getPropertyValue('--fx-bare-l')).toBe('320px');
    expect(viewer().style.getPropertyValue('--fx-bare-bar-t')).toBe('32px');
  });

  it('a double-tap zooms into that point and never toggles, not even for a moment', () => {
    tap();
    wait(150);
    tap();
    expect(m.setZoom).toHaveBeenCalledTimes(1);
    const [key, nv] = (m.setZoom as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(key).toBe(items[0]!.key);
    expect(nv.scale).toBeCloseTo(2.5);
    for (let i = 0; i < 10; i++) {
      wait(100);
      expect(bare()).toBe(false);
    }
    expect(announced).toEqual([]);
  });

  it('a second contact held past the first tap’s deadline cancels it (and a long press is no tap)', () => {
    tap();
    wait(100);
    pointer('pointerdown', 200, 300);
    wait(400);
    expect(bare()).toBe(false);
    wait(200);
    pointer('pointerup', 200, 300);
    wait(400);
    expect(bare()).toBe(false);
  });

  it('a swipe, a vertical drag or a moving pinch never toggles, and a swipe still changes file', async () => {
    const onActive = vi.fn();
    await act(async () => root!.render(createElement(Viewer, { ...props(0), onActive })));
    // A tap still pending when the swipe starts is cancelled by it.
    tap();
    wait(50);
    pointer('pointerdown', 300, 300);
    for (let x = 280; x >= 160; x -= 20) {
      clock += 16;
      pointer('pointermove', x, 300);
    }
    pointer('pointerup', 160, 300);
    expect(onActive).toHaveBeenCalledWith(1);
    wait(500);
    expect(bare()).toBe(false);

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
    pointer('pointermove', 120, 300, 1);
    pointer('pointermove', 280, 300, 2);
    pointer('pointerup', 120, 300, 1);
    pointer('pointerup', 280, 300, 2);
    expect(m.setZoom).toHaveBeenCalled();
    wait(500);
    expect(bare()).toBe(false);
    expect(announced).toEqual([]);
  });

  it('Space on the stage toggles; Space on a control or with a modifier is not the stage’s', () => {
    key(stage(), ' ');
    expect(bare()).toBe(true);
    key(stage(), ' ', { repeat: true });
    expect(bare()).toBe(true);
    key(stage(), ' ');
    expect(bare()).toBe(false);
    key(stage(), ' ', { ctrlKey: true });
    key(stage(), ' ', { metaKey: true });
    key(stage(), ' ', { altKey: true });
    expect(bare()).toBe(false);
    const next = document.querySelector<HTMLButtonElement>('[aria-label="Next file"]')!;
    expect(next.disabled).toBe(false);
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => void next.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(false);
    expect(bare()).toBe(false);
  });

  it('hiding never strands focus on a hidden control, in the viewer or out of it', () => {
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close viewer"]')!;
    close.focus();
    tap();
    wait(350);
    expect(bare()).toBe(true);
    expect(document.activeElement).toBe(stage());
    key(stage(), ' ');

    // The dock (outside the viewer) took focus while the tap waited.
    const composer = document.createElement('textarea');
    document.body.append(composer);
    tap();
    composer.focus();
    wait(350);
    expect(bare()).toBe(true);
    expect(document.activeElement).toBe(stage());
    composer.remove();
  });

  it('hiding leaves Move mode, so showing again brings back the ordinary tools', () => {
    m.zoomOf = () => ({ scale: 2.5, fx: 0, fy: 0 });
    act(() => root!.render(createElement(Viewer, props(0))));
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Move"]')!.click());
    expect(document.querySelector('[aria-label="Move around the image"]')).not.toBeNull();
    key(stage(), ' ');
    key(stage(), ' ');
    expect(document.querySelector('[aria-label="Move around the image"]')).toBeNull();
    expect(document.querySelector('[aria-label="Move"]')).not.toBeNull();
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
    // The next tap on the new file is a tap of its own, not the second half of a double-tap.
    tap();
    expect(m.setZoom).not.toHaveBeenCalled();
    wait(350);
    expect(bare()).toBe(true);
  });

  it('closing with a tap pending announces nothing, and reopening starts with the chrome shown', async () => {
    tap();
    await act(async () => root!.unmount());
    wait(400);
    expect(announced).toEqual([]);
    root = createRoot(host!);
    await render();
    key(stage(), ' ');
    expect(bare()).toBe(true);
    await act(async () => root!.unmount());
    root = createRoot(host!);
    await render();
    expect(bare()).toBe(false);
  });

  it('recording carries on across hiding; Stop stays on screen and only stops', async () => {
    dict.state = { phase: 'recording', startedAt: Date.now() } as unknown as DictState;
    await render();
    expect(document.querySelector('.fx-stop')).toBeNull(); // the dock's own Stop is on screen
    tap();
    wait(350);
    expect(dict.stop).not.toHaveBeenCalled();
    const stop = document.querySelector<HTMLButtonElement>('.fx-stop-btn')!;
    expect(stop.getAttribute('aria-label')).toBe('Stop dictation');
    expect(document.querySelector('.fx-stop')!.textContent).toMatch(/Recording · 00:00/);
    wait(2100);
    expect(document.querySelector('.fx-stop')!.textContent).toMatch(/Recording · 00:02/);
    act(() => stop.click());
    expect(dict.stop).toHaveBeenCalledTimes(1);

    // Finishing: shown and disabled, so a second press does nothing.
    dict.state = { phase: 'finishing', startedAt: null } as unknown as DictState;
    await render();
    const fin = document.querySelector<HTMLButtonElement>('.fx-stop-btn')!;
    expect(fin.getAttribute('aria-disabled')).toBe('true');
    act(() => fin.click());
    expect(dict.stop).toHaveBeenCalledTimes(1);

    // Starting: the same control cancels.
    dict.state = { phase: 'starting', startedAt: null } as unknown as DictState;
    await render();
    expect(document.querySelector('.fx-stop-btn')!.getAttribute('aria-label')).toBe(
      'Cancel dictation',
    );

    // Showing the chrome again hands Stop back to the dock.
    key(stage(), ' ');
    expect(document.querySelector('.fx-stop')).toBeNull();
  });

  it('when dictation ends under a focused Stop, focus goes to the stage', async () => {
    dict.state = { phase: 'recording', startedAt: Date.now() } as unknown as DictState;
    await render();
    key(stage(), ' ');
    document.querySelector<HTMLButtonElement>('.fx-stop-btn')!.focus();
    dict.state = { phase: 'idle', startedAt: null } as unknown as DictState;
    await render();
    expect(document.querySelector('.fx-stop')).toBeNull();
    expect(document.activeElement).toBe(stage());
  });
});
