/**
 * Zoom and pan maths for a file stage. Pure, in CSS px.
 *
 * A view is `scale` (a multiple of Fit, 1 to MAX_ZOOM) and the offset of the image's centre from the stage's
 * centre. Fit is "contain" without upscaling, so a screenshot is never stretched and never cropped. Points are
 * measured from the stage's centre.
 *
 * Views are remembered per file in a normalised form (offset as a fraction of the displayed image), so rotation
 * or a resized window keeps the same part of the image in view.
 */

export interface Size {
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface View {
  scale: number;
  x: number;
  y: number;
}
export interface NormalView {
  scale: number;
  /** Offset of the image centre as a fraction of the displayed image width/height. */
  fx: number;
  fy: number;
}

export const MAX_ZOOM = 8;
export const DOUBLE_TAP_ZOOM = 2.5;
export const ZOOM_STEP = 1.5;
export const FIT: View = { scale: 1, x: 0, y: 0 };
export const FIT_NORMAL: NormalView = { scale: 1, fx: 0, fy: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** CSS px per image px at Fit: contain, never upscaled. */
export function fitScale(natural: Size, stage: Size): number {
  if (natural.w <= 0 || natural.h <= 0 || stage.w <= 0 || stage.h <= 0) return 1;
  return Math.min(1, stage.w / natural.w, stage.h / natural.h);
}

export function displayedSize(natural: Size, stage: Size, scale: number): Size {
  const f = fitScale(natural, stage) * scale;
  return { w: natural.w * f, h: natural.h * f };
}

/** How far the image centre may move from the stage centre on each axis. */
export function panBounds(natural: Size, stage: Size, scale: number): Size {
  const d = displayedSize(natural, stage, scale);
  return { w: Math.max(0, (d.w - stage.w) / 2), h: Math.max(0, (d.h - stage.h) / 2) };
}

export function clampView(v: View, natural: Size, stage: Size): View {
  const scale = clamp(v.scale, 1, MAX_ZOOM);
  const b = panBounds(natural, stage, scale);
  return { scale, x: clamp(v.x, -b.w, b.w), y: clamp(v.y, -b.h, b.h) };
}

export const isZoomed = (v: View | NormalView): boolean => v.scale > 1.001;

/** Zoom to `scale`, keeping the image point under `p` (relative to the stage centre) where it is. */
export function zoomAt(v: View, scale: number, p: Point, natural: Size, stage: Size): View {
  const s = clamp(scale, 1, MAX_ZOOM);
  const k = s / v.scale;
  return clampView(
    { scale: s, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k },
    natural,
    stage,
  );
}

export function zoomBy(v: View, factor: number, p: Point, natural: Size, stage: Size): View {
  return zoomAt(v, v.scale * factor, p, natural, stage);
}

export function panBy(v: View, dx: number, dy: number, natural: Size, stage: Size): View {
  return clampView({ scale: v.scale, x: v.x + dx, y: v.y + dy }, natural, stage);
}

/**
 * A pinch relative to where it started: scale follows the finger spread, and the image point that was under the
 * starting midpoint follows the midpoint as it moves (zoom around the midpoint, plus a two-finger pan).
 */
export function pinchView(
  start: View,
  startMid: Point,
  startDist: number,
  nowMid: Point,
  nowDist: number,
  natural: Size,
  stage: Size,
): View {
  const s = clamp((start.scale * nowDist) / Math.max(1, startDist), 1, MAX_ZOOM);
  const k = s / start.scale;
  return clampView(
    {
      scale: s,
      x: nowMid.x - (startMid.x - start.x) * k,
      y: nowMid.y - (startMid.y - start.y) * k,
    },
    natural,
    stage,
  );
}

/** Double-tap: zoom 2.5× into the tapped point at Fit, back to Fit when zoomed. */
export function doubleTapView(v: View, p: Point, natural: Size, stage: Size): View {
  return isZoomed(v) ? FIT : zoomAt(FIT, DOUBLE_TAP_ZOOM, p, natural, stage);
}

export function toNormal(v: View, natural: Size, stage: Size): NormalView {
  const d = displayedSize(natural, stage, v.scale);
  return { scale: v.scale, fx: d.w ? v.x / d.w : 0, fy: d.h ? v.y / d.h : 0 };
}

export function fromNormal(n: NormalView, natural: Size, stage: Size): View {
  const d = displayedSize(natural, stage, n.scale);
  return clampView({ scale: n.scale, x: n.fx * d.w, y: n.fy * d.h }, natural, stage);
}
