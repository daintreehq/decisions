import { describe, expect, it } from 'vitest';
import { GestureRecognizer, type GestureEvent } from '../src/components/files/gesture.js';
import { stepIndex } from '../src/components/files/sequence.js';
import {
  FIT,
  MAX_ZOOM,
  panBounds,
  panBy,
  zoomAt,
  type View,
} from '../src/components/files/zoom.js';

const WIDTH = 390;
const natural = { w: 1280, h: 800 };
const stage = { w: WIDTH, h: 600 };

/** Drives a recogniser like a stage does, applying its events to a file index and a view. */
function harness(opts: { index?: number; total?: number; view?: View } = {}) {
  const rec = new GestureRecognizer();
  const state = { index: opts.index ?? 0, total: opts.total ?? 4, view: opts.view ?? FIT };
  const events: GestureEvent[] = [];
  let t = 1000;
  const apply = (evs: GestureEvent[]) => {
    for (const ev of evs) {
      events.push(ev);
      if (ev.type === 'swipe-end' && ev.commit)
        state.index = stepIndex(state.index, ev.commit, state.total);
      if (ev.type === 'pan') state.view = panBy(state.view, ev.dx, ev.dy, natural, stage);
    }
  };
  const ctx = () => ({ zoomed: state.view.scale > 1.001, width: WIDTH });
  return {
    rec,
    state,
    events,
    down: (id: number, x: number, y: number) => apply(rec.down(id, x, y, (t += 16), ctx())),
    move: (id: number, x: number, y: number, dt = 16) =>
      apply(rec.move(id, x, y, (t += dt), ctx())),
    up: (id: number, x: number, y: number, dt = 16) => apply(rec.up(id, x, y, (t += dt), ctx())),
    cancel: (id: number) => apply(rec.cancel(id, (t += 16))),
    click: (dt = 10) => rec.shouldSuppressClick((t += dt)),
    /** A slow horizontal drag from x0 to x1 in 10 px steps. */
    drag(id: number, x0: number, x1: number, y = 300) {
      this.down(id, x0, y);
      const dir = Math.sign(x1 - x0);
      for (let x = x0 + dir * 10; dir > 0 ? x <= x1 : x >= x1; x += dir * 10)
        this.move(id, x, y, 40);
      this.up(id, x1, y, 40);
    },
  };
}

describe('file gesture recogniser', () => {
  it('a swipe at Fit changes exactly one file', () => {
    const h = harness({ index: 1 });
    h.drag(1, 300, 60); // 240 px left: well past a fifth of the width
    expect(h.state.index).toBe(2);
    expect(h.events.filter((e) => e.type === 'swipe-end')).toEqual([
      { type: 'swipe-end', commit: 1 },
    ]);
    expect(h.events.some((e) => e.type === 'pan')).toBe(false);

    h.drag(2, 60, 300); // and back again
    expect(h.state.index).toBe(1);
  });

  it('a short slow swipe settles back; a short fast one (a fling) commits', () => {
    const h = harness({ index: 1 });
    h.drag(1, 200, 160); // 40 px, slow
    expect(h.state.index).toBe(1);
    expect(h.events.at(-1)).toEqual({ type: 'swipe-end', commit: 0 });

    h.down(2, 200, 300);
    h.move(2, 185, 300, 8);
    h.move(2, 160, 300, 8);
    h.up(2, 140, 300, 8); // 60 px in 24 ms
    expect(h.state.index).toBe(2);
  });

  it('never wraps past the first or last file', () => {
    const h = harness({ index: 3, total: 4 });
    h.drag(1, 300, 40);
    expect(h.state.index).toBe(3);
    const g = harness({ index: 0 });
    g.drag(1, 40, 300);
    expect(g.state.index).toBe(0);
  });

  it('vertical intent at Fit is not a swipe', () => {
    const h = harness({ index: 1 });
    h.down(1, 200, 100);
    h.move(1, 212, 140); // |dx| is not > 1.3 × |dy|
    h.move(1, 260, 300);
    h.up(1, 260, 300);
    expect(h.state.index).toBe(1);
    expect(h.events.some((e) => e.type === 'swipe-move')).toBe(false);
  });

  it('movement inside the 10 px slop stays a tap', () => {
    const h = harness();
    h.down(1, 100, 100);
    h.move(1, 106, 104);
    h.up(1, 106, 104);
    expect(h.events.map((e) => e.type)).toEqual(['tap']);
    expect(h.click()).toBe(false);
  });

  it('the same swipe when zoomed only pans, including at an edge', () => {
    const zoomed = zoomAt(FIT, 3, { x: 0, y: 0 }, natural, stage);
    const h = harness({ index: 1, view: zoomed });
    h.drag(1, 300, 60);
    expect(h.state.index).toBe(1);
    expect(h.events.some((e) => e.type === 'swipe-move' || e.type === 'swipe-end')).toBe(false);
    expect(h.events.some((e) => e.type === 'pan')).toBe(true);

    // Pan to the right-hand edge, then keep swiping: the image stops at its bound and the file never changes.
    const bound = panBounds(natural, stage, h.state.view.scale);
    for (let i = 0; i < 6; i++) h.drag(1, 380, 20);
    expect(h.state.view.x).toBe(-bound.w);
    expect(h.state.index).toBe(1);
    h.drag(1, 380, 20);
    expect(h.state.view.x).toBe(-bound.w);
    expect(h.state.index).toBe(1);
  });

  it('a pinch tail never changes file', () => {
    const h = harness({ index: 1 });
    h.down(1, 150, 300);
    h.down(2, 250, 300);
    expect(h.rec.mode).toBe('pinch');
    h.move(1, 120, 300);
    h.move(2, 280, 300);
    h.up(2, 280, 300); // one finger lifts; the other stays down
    expect(h.rec.mode).toBe('pinch-tail');
    for (let x = 110; x > -200; x -= 20) h.move(1, x, 300, 10); // a long, fast horizontal tail
    h.up(1, -200, 300, 10);
    expect(h.state.index).toBe(1);
    expect(
      h.events.some((e) => e.type === 'swipe-move' || e.type === 'swipe-end' || e.type === 'pan'),
    ).toBe(false);
    expect(h.events.map((e) => e.type)).toEqual([
      'pinch-start',
      'pinch-move',
      'pinch-move',
      'pinch-end',
    ]);
  });

  it('a pinch follows its own two fingers: a third finger never jumps the zoom', () => {
    const h = harness({ index: 1 });
    h.down(1, 100, 300);
    h.down(2, 200, 300); // 100 px apart
    h.down(3, 500, 300); // a third finger lands far away
    h.move(3, 520, 300);
    expect(h.events.filter((e) => e.type === 'pinch-move')).toEqual([]);
    h.move(2, 201, 300);
    expect(h.events.at(-1)).toEqual({ type: 'pinch-move', mid: { x: 150.5, y: 300 }, dist: 101 });
    // One of the pinching fingers lifts: the pinch ends; the third finger is a tail and does nothing.
    h.up(1, 100, 300);
    expect(h.events.at(-1)).toEqual({ type: 'pinch-end' });
    const before = h.events.length;
    h.move(3, 300, 300);
    h.move(2, 0, 300);
    expect(h.events.length).toBe(before);
    h.up(2, 0, 300);
    h.up(3, 300, 300);
    expect(h.state.index).toBe(1);
  });

  it('a second finger during a swipe settles it back and becomes a pinch', () => {
    const h = harness({ index: 1 });
    h.down(1, 300, 300);
    h.move(1, 250, 300);
    h.move(1, 150, 300);
    h.down(2, 100, 400);
    h.up(1, 100, 300);
    h.up(2, 100, 400);
    expect(h.state.index).toBe(1);
    expect(h.events.filter((e) => e.type === 'swipe-end')).toEqual([
      { type: 'swipe-end', commit: 0 },
    ]);
  });

  it('a completed drag suppresses the click that follows it, once', () => {
    const h = harness({ index: 1 });
    h.drag(1, 300, 260); // settles back, but it was still a drag
    expect(h.click()).toBe(true);
    expect(h.click()).toBe(false);

    const z = harness({ view: zoomAt(FIT, 2, { x: 0, y: 0 }, natural, stage) });
    z.drag(1, 200, 150);
    expect(z.click()).toBe(true);

    const p = harness();
    p.down(1, 150, 300);
    p.down(2, 250, 300);
    p.up(1, 150, 300);
    p.up(2, 250, 300);
    expect(p.click()).toBe(true);
  });

  it('a cancelled pointer (the browser took over to scroll) ends the swipe without a commit', () => {
    const h = harness({ index: 1 });
    h.down(1, 300, 300);
    h.move(1, 200, 300);
    h.cancel(1);
    expect(h.state.index).toBe(1);
    expect(h.events.at(-1)).toEqual({ type: 'swipe-end', commit: 0 });
    expect(h.rec.mode).toBe('idle');
  });

  it('two taps close together make a double-tap', () => {
    const h = harness();
    h.down(1, 100, 100);
    h.up(1, 100, 100);
    h.down(1, 104, 102);
    h.up(1, 104, 102);
    expect(h.events.map((e) => e.type)).toEqual(['tap', 'double-tap']);
  });

  it('zoom is a multiple of Fit capped at 8×', () => {
    expect(zoomAt(FIT, 50, { x: 0, y: 0 }, natural, stage).scale).toBe(MAX_ZOOM);
    expect(zoomAt(FIT, 0.2, { x: 0, y: 0 }, natural, stage).scale).toBe(1);
  });
});
