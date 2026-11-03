import { describe, expect, it } from 'vitest';
import {
  FIT,
  clampView,
  displayedSize,
  doubleTapView,
  fitScale,
  fromNormal,
  panBounds,
  panBy,
  pinchView,
  toNormal,
  zoomAt,
} from '../src/components/files/zoom.js';

const natural = { w: 1280, h: 800 };
const stage = { w: 400, h: 600 };

describe('zoom and pan maths', () => {
  it('Fit is contain without upscaling', () => {
    expect(fitScale(natural, stage)).toBeCloseTo(400 / 1280);
    expect(displayedSize(natural, stage, 1)).toEqual({ w: 400, h: 250 });
    // A small image is shown at its own size, never stretched.
    expect(fitScale({ w: 100, h: 80 }, stage)).toBe(1);
  });

  it('pan is bounded so the image never leaves the stage', () => {
    // At Fit there is nowhere to go.
    expect(panBy(FIT, 200, 200, natural, stage)).toEqual(FIT);
    const z = zoomAt(FIT, 4, { x: 0, y: 0 }, natural, stage); // 1600 × 1000 on a 400 × 600 stage
    const b = panBounds(natural, stage, 4);
    expect(b).toEqual({ w: 600, h: 200 });
    expect(panBy(z, 5000, -5000, natural, stage)).toEqual({ scale: 4, x: 600, y: -200 });
    expect(panBy(z, -5000, 5000, natural, stage)).toEqual({ scale: 4, x: -600, y: 200 });
    // An axis that still fits the stage stays centred.
    const z2 = zoomAt(FIT, 2, { x: 0, y: 0 }, natural, stage); // 800 × 500
    expect(panBy(z2, 0, 300, natural, stage).y).toBe(0);
  });

  it('zooming at a point keeps that point under the finger', () => {
    const p = { x: 100, y: 50 };
    const z = zoomAt(FIT, 2, p, natural, stage);
    // The image point under p before (offset p − x at scale 1) is under p after.
    const before = (p.x - FIT.x) / 1;
    const after = (p.x - z.x) / 2;
    expect(after).toBeCloseTo(before);
  });

  it('a pinch zooms around its midpoint and follows it', () => {
    const start = FIT;
    const mid = { x: 50, y: 20 };
    const v = pinchView(start, mid, 100, mid, 250, natural, stage);
    expect(v.scale).toBeCloseTo(2.5);
    expect((mid.x - v.x) / v.scale).toBeCloseTo((mid.x - start.x) / start.scale);
    // Spreading past the cap stops at 8×; pinching in stops at Fit.
    expect(pinchView(start, mid, 10, mid, 1000, natural, stage).scale).toBe(8);
    expect(pinchView(start, mid, 100, mid, 10, natural, stage)).toEqual(
      clampView(FIT, natural, stage),
    );
  });

  it('double-tap goes to 2.5× at the point, then back to Fit', () => {
    const z = doubleTapView(FIT, { x: 80, y: 0 }, natural, stage);
    expect(z.scale).toBe(2.5);
    expect(z.x).toBeLessThan(0);
    expect(doubleTapView(z, { x: 0, y: 0 }, natural, stage)).toEqual(FIT);
  });

  it('a remembered view survives a resize (rotation) in normalised form', () => {
    const z = panBy(zoomAt(FIT, 3, { x: 0, y: 0 }, natural, stage), -150, 40, natural, stage);
    const n = toNormal(z, natural, stage);
    const rotated = { w: 600, h: 400 };
    const back = fromNormal(n, natural, rotated);
    expect(back.scale).toBe(3);
    const d = displayedSize(natural, rotated, 3);
    expect(back.x / d.w).toBeCloseTo(n.fx);
    expect(fromNormal(n, natural, stage).x).toBeCloseTo(z.x);
  });
});
