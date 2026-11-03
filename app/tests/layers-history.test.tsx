// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Layers = typeof import('../src/app/layers.js');
type Router = typeof import('../src/app/router.js');

/**
 * happy-dom traverses history synchronously; browsers do it later. Hold every `history.go` until `settle()` so the
 * window between the call and its popstate is real, as it is in a browser.
 */
const realGo = (Object.getPrototypeOf(history) as History).go;
let held: number[] = [];
function settle() {
  while (held.length) realGo.call(history, held.shift()!);
}

async function fresh(): Promise<{ layers: Layers; router: Router }> {
  vi.resetModules();
  const layers = await import('../src/app/layers.js');
  const router = await import('../src/app/router.js');
  return { layers, router };
}

const depth = () => (history.state as { layerDepth?: number } | null)?.layerDepth ?? 0;

interface Handle {
  setA: (v: boolean) => void;
  setB: (v: boolean) => void;
  a: boolean;
  b: boolean;
  /** The Close button / Escape of each layer. */
  dismissA: () => void;
  dismissB: () => void;
}

/** Two independent layers (the viewer and the navigator, say), each opened and closed by state. */
function mount(layers: Layers): { h: Handle; root: Root; host: HTMLElement } {
  const h = {} as Handle;
  function Two() {
    const [a, setA] = useState(false);
    const [b, setB] = useState(false);
    const dismissA = layers.useLayer(a, () => setA(false));
    const dismissB = layers.useLayer(b, () => setB(false));
    Object.assign(h, { a, b, setA, setB, dismissA, dismissB });
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Two)));
  return { h, root, host };
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  held = [];
  vi.spyOn(history, 'go').mockImplementation((n?: number) => void held.push(n ?? 0));
  history.pushState(null, '', '/');
  history.pushState(null, '', '/q/a');
});
afterEach(() => {
  cleanup?.();
  cleanup = null;
  settle();
  vi.restoreAllMocks();
});

function setup(layers: Layers) {
  const m = mount(layers);
  cleanup = () => {
    act(() => m.root.unmount());
    m.host.remove();
  };
  return m.h;
}

describe('layer history', () => {
  it('navigating through nested layers leaves exactly one entry per route (finding 9)', async () => {
    const { layers, router } = await fresh();
    const h = setup(layers);
    act(() => h.setA(true)); // the viewer
    act(() => h.setB(true)); // the navigator over it
    expect(depth()).toBe(2);

    act(() => router.navigate('/settings'));
    settle();
    expect(location.pathname).toBe('/settings');
    expect(h.a).toBe(false);
    expect(h.b).toBe(false);
    expect(layers.hasLayers()).toBe(false);

    // Back meets the question once, at its own entry, then the list.
    history.back();
    expect(location.pathname).toBe('/q/a');
    expect(depth()).toBe(0);
    history.back();
    expect(location.pathname).toBe('/');
  });

  it('a pending layer release cannot undo a newer navigation (finding 10)', async () => {
    const { layers, router } = await fresh();
    const h = setup(layers);
    act(() => h.setA(true));
    act(() => h.setA(false)); // closed by state: its entry unwinds later
    act(() => router.navigate('/q/b'));
    settle();
    expect(location.pathname).toBe('/q/b');
    history.back();
    expect(location.pathname).toBe('/q/a');
    expect(depth()).toBe(0);
  });

  it('closing a layer that was opened during a release cancels its push (finding 11)', async () => {
    const { layers } = await fresh();
    const h = setup(layers);
    act(() => h.setA(true));
    act(() => h.setA(false)); // release in flight
    act(() => h.setB(true)); // its push waits for the release
    act(() => h.setB(false)); // and is closed before the pop arrives
    settle();
    expect(layers.hasLayers()).toBe(false);
    expect(location.pathname).toBe('/q/a');
    expect(depth()).toBe(0);
  });

  it('a layer opened during a release still works once it lands', async () => {
    const { layers } = await fresh();
    const h = setup(layers);
    act(() => h.setA(true));
    act(() => h.setA(false));
    act(() => h.setB(true));
    settle();
    expect(layers.hasLayers()).toBe(true);
    expect(depth()).toBe(1);
    // Browser Back closes it.
    act(() => history.back());
    expect(h.b).toBe(false);
    expect(layers.hasLayers()).toBe(false);
    expect(depth()).toBe(0);
  });

  it('Back pops the question even when a layer release is still in flight', async () => {
    const { layers } = await fresh();
    const list = await import('../src/app/listState.js');
    history.replaceState(null, '', '/');
    list.openQuestion('q1', 'questions');
    const h = setup(layers);
    act(() => h.setA(true));
    act(() => h.setA(false)); // release in flight; history.state still says depth 1
    act(() => list.goBack());
    settle();
    expect(location.pathname).toBe('/');
    history.forward();
    expect(location.pathname).toBe('/q/q1');
  });

  it('locking the app with a layer open closes it without touching history', async () => {
    const { layers } = await fresh();
    const h = setup(layers);
    act(() => h.setA(true));
    act(() => h.setB(true));
    const go = vi.mocked(history.go);
    go.mockClear();
    act(() => layers.abandonLayers());
    expect(h.a).toBe(false);
    expect(h.b).toBe(false);
    expect(layers.hasLayers()).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });

  it('a second Close before the first lands closes the sheet without leaving the question', async () => {
    const { layers } = await fresh();
    const h = setup(layers);
    act(() => h.setA(true));
    expect(depth()).toBe(1);
    act(() => h.dismissA()); // Close
    act(() => h.dismissA()); // Escape, before the popstate arrives
    act(() => settle());
    expect(h.a).toBe(false);
    expect(layers.hasLayers()).toBe(false);
    expect(location.pathname).toBe('/q/a');
    expect(depth()).toBe(0);
  });

  it('route Back holds a later navigation until it lands', async () => {
    const { layers, router } = await fresh();
    const list = await import('../src/app/listState.js');
    history.replaceState(null, '', '/history');
    list.openQuestion('q1', 'history');
    const h = setup(layers);
    act(() => h.setA(true));
    act(() => list.goBack()); // traversal in flight
    act(() => router.navigate('/settings')); // tapped before it lands
    act(() => settle());
    expect(h.a).toBe(false);
    expect(location.pathname).toBe('/settings');
    // The question's origin is under the new page: the navigation waited for Back to land there.
    history.back();
    expect(location.pathname).toBe('/history');
  });

  describe('a traversal whose popstate does not arrive in time', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not leave an empty layer entry under the navigation it drains', async () => {
      const { layers, router } = await fresh();
      const h = setup(layers);
      act(() => h.setA(true));
      act(() => h.setA(false)); // its entry unwinds: held
      act(() => router.navigate('/settings')); // waits for that unwind
      held = []; // the browser never performs it
      act(() => vi.advanceTimersByTime(1000));
      expect(location.pathname).toBe('/settings');
      vi.advanceTimersByTime(5000); // the person goes Back some time later
      // Back meets the question itself, not the closed layer's entry, and then the list.
      history.back();
      expect(location.pathname).toBe('/q/a');
      expect(depth()).toBe(0);
      history.back();
      expect(location.pathname).toBe('/');
    });

    it('a late traversal does not undo the navigation that followed the timeout', async () => {
      const { layers, router } = await fresh();
      const h = setup(layers);
      act(() => h.setA(true));
      act(() => h.setA(false));
      act(() => router.navigate('/settings'));
      act(() => vi.advanceTimersByTime(1000));
      expect(location.pathname).toBe('/settings');
      act(() => settle()); // the held unwind finally runs
      expect(location.pathname).toBe('/settings');
      expect(layers.hasLayers()).toBe(false);
      history.back();
      expect(location.pathname).toBe('/q/a');
      expect(depth()).toBe(0);
    });

    it('a timed-out unwind is not mistaken for a later one landing', async () => {
      const { layers } = await fresh();
      const h = setup(layers);
      act(() => h.setA(true));
      act(() => h.setA(false)); // unwind of A held
      act(() => vi.advanceTimersByTime(1000)); // timed out
      act(() => h.setB(true)); // B gets an entry
      act(() => h.setB(false)); // and its unwind starts
      const go = vi.mocked(history.go);
      go.mockClear();
      act(() => settle()); // both traversals land, the late one first
      expect(location.pathname).toBe('/q/a');
      expect(depth()).toBe(0);
      expect(layers.hasLayers()).toBe(false);
    });
  });
});
