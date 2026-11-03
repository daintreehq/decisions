/**
 * One explicit recogniser for every pointer gesture on a file stage (inline preview, viewer, comparison pane).
 * Pure: it is fed pointer samples with timestamps and returns what they mean; the stage applies the meaning.
 *
 * Ownership (guide 5.4):
 * - One pointer moves less than `slop`: still a tap candidate.
 * - At Fit, horizontal intent (|dx| > ratio × |dy|) makes a swipe, which ends in exactly one commit (previous,
 *   next or settle back). Vertical intent at Fit is ignored here (the page or nothing scrolls).
 * - Zoomed (decided when the first pointer lands), every one-pointer drag pans. A zoomed drag never swipes, so
 *   an image panned to its edge never changes file.
 * - A second pointer starts a pinch, which owns input until every pointer lifts: the finger left behind after a
 *   pinch (the "tail") neither pans nor swipes.
 * - A gesture that moved (swipe, pan, pinch, vertical drag) suppresses the click the browser sends after it.
 */

export interface Point {
  x: number;
  y: number;
}

export interface GestureConfig {
  /** Movement below this many px is still a tap. */
  slop: number;
  /** Horizontal intent requires |dx| greater than this multiple of |dy|. */
  ratio: number;
  /** A swipe commits once it has travelled this fraction of the stage width. */
  commitFraction: number;
  /** Or once it is released faster than this (px/ms) in the direction it travelled. */
  flingVelocity: number;
  doubleTapMs: number;
  doubleTapSlop: number;
  tapMaxMs: number;
  /** How long after a drag ends its trailing click is swallowed. */
  clickSuppressMs: number;
}

export const DEFAULT_GESTURE: GestureConfig = {
  slop: 10,
  ratio: 1.3,
  commitFraction: 0.2,
  flingVelocity: 0.45,
  doubleTapMs: 300,
  doubleTapSlop: 24,
  tapMaxMs: 500,
  clickSuppressMs: 450,
};

export type GestureMode =
  'idle' | 'pending' | 'swipe' | 'pan' | 'vertical' | 'pinch' | 'pinch-tail';

export type GestureEvent =
  /** Total horizontal travel of a swipe in progress, for the track to follow the finger. */
  | { type: 'swipe-move'; dx: number }
  /** +1 next file, −1 previous file, 0 settle back. Exactly one per swipe. */
  | { type: 'swipe-end'; commit: -1 | 0 | 1 }
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'pinch-start'; mid: Point; dist: number }
  | { type: 'pinch-move'; mid: Point; dist: number }
  | { type: 'pinch-end' }
  | { type: 'tap'; x: number; y: number }
  | { type: 'double-tap'; x: number; y: number };

export interface GestureContext {
  /** Whether the image is zoomed beyond Fit. Read when the first pointer lands and held for the gesture. */
  zoomed: boolean;
  /** Stage width in px, for the commit distance. */
  width: number;
}

interface Sample {
  x: number;
  y: number;
  t: number;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class GestureRecognizer {
  mode: GestureMode = 'idle';
  private readonly cfg: GestureConfig;
  private pointers = new Map<number, Point>();
  /** The pointer a one-finger gesture follows. */
  private primary: number | null = null;
  /** The two fingers a pinch follows; any others are ignored until one of these lifts. */
  private pair: [number, number] | null = null;
  private start: Sample = { x: 0, y: 0, t: 0 };
  private last: Point = { x: 0, y: 0 };
  private samples: Sample[] = [];
  private zoomed = false;
  private lastTap: Sample | null = null;
  private suppressUntil = -Infinity;

  constructor(cfg: Partial<GestureConfig> = {}) {
    this.cfg = { ...DEFAULT_GESTURE, ...cfg };
  }

  get activePointers(): number {
    return this.pointers.size;
  }

  down(id: number, x: number, y: number, t: number, ctx: GestureContext): GestureEvent[] {
    this.pointers.set(id, { x, y });
    if (this.pointers.size === 1) {
      this.mode = 'pending';
      this.primary = id;
      this.zoomed = ctx.zoomed;
      this.start = { x, y, t };
      this.last = { x, y };
      this.samples = [{ x, y, t }];
      return [];
    }
    if (this.mode === 'pinch') return []; // a third finger does not change the pinch
    // A second finger (or a new one during a pinch tail) starts a pinch with a finger already down.
    const out: GestureEvent[] = [];
    if (this.mode === 'swipe') out.push({ type: 'swipe-end', commit: 0 });
    const other = [...this.pointers.keys()].find((k) => k !== id)!;
    this.pair = [other, id];
    this.mode = 'pinch';
    out.push({ type: 'pinch-start', ...this.pinchGeometry() });
    return out;
  }

  move(
    id: number,
    x: number,
    y: number,
    t: number,
    ctx: Pick<GestureContext, 'width'>,
  ): GestureEvent[] {
    if (!this.pointers.has(id)) return [];
    this.pointers.set(id, { x, y });
    void ctx;
    switch (this.mode) {
      case 'pinch':
        if (!this.pair?.includes(id)) return [];
        return [{ type: 'pinch-move', ...this.pinchGeometry() }];
      case 'pinch-tail':
      case 'vertical':
      case 'idle':
        return [];
      default:
        break;
    }
    if (id !== this.primary) return [];
    this.samples.push({ x, y, t });
    while (this.samples.length > 2 && t - this.samples[0]!.t > 100) this.samples.shift();
    const dx = x - this.start.x;
    const dy = y - this.start.y;

    if (this.mode === 'pending') {
      if (Math.hypot(dx, dy) < this.cfg.slop) return [];
      if (this.zoomed) {
        this.mode = 'pan';
        this.last = { x, y };
        return [{ type: 'pan', dx, dy }];
      }
      if (Math.abs(dx) > this.cfg.ratio * Math.abs(dy)) {
        this.mode = 'swipe';
        return [{ type: 'swipe-move', dx }];
      }
      this.mode = 'vertical';
      return [];
    }
    if (this.mode === 'swipe') return [{ type: 'swipe-move', dx }];
    if (this.mode === 'pan') {
      const ev: GestureEvent = { type: 'pan', dx: x - this.last.x, dy: y - this.last.y };
      this.last = { x, y };
      return [ev];
    }
    return [];
  }

  up(
    id: number,
    x: number,
    y: number,
    t: number,
    ctx: Pick<GestureContext, 'width'>,
  ): GestureEvent[] {
    if (!this.pointers.has(id)) return [];
    this.pointers.set(id, { x, y });
    const out: GestureEvent[] = [];
    if (this.mode === 'pinch' && this.pair?.includes(id)) {
      out.push({ type: 'pinch-end' });
      this.mode = 'pinch-tail';
      this.pair = null;
    }
    if (this.mode === 'swipe' && id === this.primary) {
      out.push({ type: 'swipe-end', commit: this.commitFor(x, t, ctx.width) });
    }
    if (this.mode === 'pending' && id === this.primary && this.pointers.size === 1) {
      out.push(...this.tapFor(x, y, t));
    }
    this.pointers.delete(id);
    if (this.pointers.size === 0) this.finish(t);
    else if (id === this.primary && this.mode !== 'pinch' && this.mode !== 'pinch-tail') {
      // The finger that was being followed lifted while another stays down: nothing more from this gesture.
      this.mode = 'pinch-tail';
    }
    return out;
  }

  cancel(id: number, t: number): GestureEvent[] {
    if (!this.pointers.has(id)) return [];
    const out: GestureEvent[] = [];
    if (this.mode === 'swipe') out.push({ type: 'swipe-end', commit: 0 });
    if (this.mode === 'pinch' && this.pair?.includes(id)) {
      out.push({ type: 'pinch-end' });
      this.mode = 'pinch-tail';
      this.pair = null;
    }
    this.pointers.delete(id);
    if (this.pointers.size === 0) this.finish(t);
    else if (this.mode !== 'pinch') this.mode = 'pinch-tail';
    return out;
  }

  /** True (once) for the click that trails a gesture which moved. */
  shouldSuppressClick(t: number): boolean {
    if (t <= this.suppressUntil) {
      this.suppressUntil = -Infinity;
      return true;
    }
    return false;
  }

  /** Abandon whatever is in progress (the stage unmounted or the file changed under it). */
  reset(): void {
    this.pointers.clear();
    this.primary = null;
    this.pair = null;
    this.mode = 'idle';
  }

  private finish(t: number) {
    if (this.mode !== 'pending' && this.mode !== 'idle')
      this.suppressUntil = t + this.cfg.clickSuppressMs;
    this.mode = 'idle';
    this.primary = null;
    this.pair = null;
  }

  private commitFor(x: number, t: number, width: number): -1 | 0 | 1 {
    const dx = x - this.start.x;
    if (dx === 0) return 0;
    const dir = dx < 0 ? 1 : -1; // finger travelling left brings the next file in
    if (Math.abs(dx) >= width * this.cfg.commitFraction) return dir;
    const first = this.samples[0]!;
    const dt = t - first.t;
    if (dt > 0) {
      const v = (x - first.x) / dt;
      if (Math.abs(v) >= this.cfg.flingVelocity && Math.sign(v) === Math.sign(dx)) return dir;
    }
    return 0;
  }

  private tapFor(x: number, y: number, t: number): GestureEvent[] {
    if (t - this.start.t > this.cfg.tapMaxMs) return [];
    const prev = this.lastTap;
    if (
      prev &&
      t - prev.t <= this.cfg.doubleTapMs &&
      Math.hypot(x - prev.x, y - prev.y) <= this.cfg.doubleTapSlop
    ) {
      this.lastTap = null;
      return [{ type: 'double-tap', x, y }];
    }
    this.lastTap = { x, y, t };
    return [{ type: 'tap', x, y }];
  }

  private pinchGeometry(): { mid: Point; dist: number } {
    const a = this.pointers.get(this.pair![0])!;
    const b = this.pointers.get(this.pair![1])!;
    return { mid: mid(a, b), dist: Math.max(1, dist(a, b)) };
  }
}
