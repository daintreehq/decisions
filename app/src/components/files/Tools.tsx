import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MoveIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '../Icons.js';
import { FIT, MAX_ZOOM, ZOOM_STEP, isZoomed, panBy, zoomBy, type Size, type View } from './zoom.js';

export interface ZoomTarget {
  view: View;
  natural: Size | undefined;
  size: Size;
  set: (v: View) => void;
}

/** Zoom and pan commands on one or more linked views (comparison zooms both panes together). */
export function zoomCommands(targets: ZoomTarget[]) {
  const usable = targets.filter((t) => t.natural && t.size.w > 0);
  const first = usable[0];
  const scale = first?.view.scale ?? 1;
  const each = (f: (t: ZoomTarget & { natural: Size }) => View) => {
    for (const t of usable) t.set(f(t as ZoomTarget & { natural: Size }));
  };
  return {
    usable: usable.length > 0,
    zoomed: usable.some((t) => isZoomed(t.view)),
    scale,
    zoomIn: () => each((t) => zoomBy(t.view, ZOOM_STEP, { x: 0, y: 0 }, t.natural, t.size)),
    zoomOut: () => each((t) => zoomBy(t.view, 1 / ZOOM_STEP, { x: 0, y: 0 }, t.natural, t.size)),
    fit: () => each(() => FIT),
    /** Look further in a direction: the image moves the other way by 15% of the stage. */
    pan: (dx: number, dy: number) =>
      each((t) => panBy(t.view, -dx * t.size.w * 0.15, -dy * t.size.h * 0.15, t.natural, t.size)),
  };
}

export type ZoomCommands = ReturnType<typeof zoomCommands>;

export const formatScale = (s: number): string =>
  `${s >= 9.95 ? Math.round(s) : Math.round(s * 10) / 10}×`;

/** − Fit + and Move. The Fit button reads the current zoom ("2.5×") and returns to Fit. */
export function ZoomButtons({ cmd, onMove }: { cmd: ZoomCommands; onMove: () => void }) {
  return (
    <>
      <div className="fx-tool-group">
        <button
          type="button"
          className="btn ghost icon fx-tool"
          aria-label="Zoom out"
          aria-keyshortcuts="-"
          disabled={!cmd.zoomed}
          onClick={cmd.zoomOut}
        >
          <ZoomOutIcon size={20} />
        </button>
        <button
          type="button"
          className="btn ghost fx-tool fx-zoom-value tabular"
          aria-label={cmd.zoomed ? `Fit to screen, now ${formatScale(cmd.scale)}` : 'Fit to screen'}
          aria-keyshortcuts="0"
          disabled={!cmd.zoomed}
          onClick={cmd.fit}
        >
          {cmd.zoomed ? formatScale(cmd.scale) : 'Fit'}
        </button>
        <button
          type="button"
          className="btn ghost icon fx-tool"
          aria-label="Zoom in"
          aria-keyshortcuts="+"
          disabled={!cmd.usable || cmd.scale >= MAX_ZOOM - 0.001}
          onClick={cmd.zoomIn}
        >
          <ZoomInIcon size={20} />
        </button>
      </div>
      <button
        type="button"
        className="btn ghost icon fx-tool"
        aria-label="Move"
        title={cmd.zoomed ? 'Move around the image' : 'Zoom in to move around the image'}
        disabled={!cmd.zoomed}
        onClick={onMove}
      >
        <MoveIcon size={20} />
      </button>
    </>
  );
}

/** Replaces the toolbar while moving: four directions and Done, so panning never needs a drag. */
export function PanPad({ cmd, onDone }: { cmd: ZoomCommands; onDone: () => void }) {
  const b = (label: string, dx: number, dy: number, icon: ReactNode) => (
    <button
      type="button"
      className="btn ghost icon fx-tool"
      aria-label={label}
      onClick={() => cmd.pan(dx, dy)}
    >
      {icon}
    </button>
  );
  return (
    <>
      <div className="fx-tool-group" role="group" aria-label="Move around the image">
        {b('Move left', -1, 0, <ChevronLeft size={20} />)}
        {b(
          'Move up',
          0,
          -1,
          <span className="fx-rot180">
            <ChevronDown size={20} />
          </span>,
        )}
        {b('Move down', 0, 1, <ChevronDown size={20} />)}
        {b('Move right', 1, 0, <ChevronRight size={20} />)}
      </div>
      <button type="button" className="btn small fx-done" onClick={onDone}>
        Done
      </button>
    </>
  );
}

export function StepButtons({
  index,
  total,
  onStep,
}: {
  index: number;
  total: number;
  onStep: (dir: -1 | 1) => void;
}) {
  return (
    <div className="fx-tool-group">
      <button
        type="button"
        className="btn ghost icon fx-tool"
        aria-label="Previous file"
        disabled={index <= 0}
        onClick={() => onStep(-1)}
      >
        <ArrowLeft size={20} />
      </button>
      <button
        type="button"
        className="btn ghost icon fx-tool"
        aria-label="Next file"
        disabled={index >= total - 1}
        onClick={() => onStep(1)}
      >
        <ArrowRight size={20} />
      </button>
    </div>
  );
}

/**
 * Entering or leaving Move swaps the toolbar's buttons, which would drop focus on the floor: put it on the first
 * direction when moving starts, and back on Move (or the stage, when Move is no longer available) when it ends.
 */
export function useMoveFocus(
  moving: boolean,
  tools: RefObject<HTMLElement | null>,
  stage: () => HTMLElement | null | undefined,
) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const root = tools.current;
    if (!root) return;
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected && !root.contains(now)) return;
    const next = root.querySelector<HTMLElement>(
      moving ? '[aria-label="Move left"]' : '[aria-label="Move"]:not(:disabled)',
    );
    (next ?? stage())?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving]);
}
