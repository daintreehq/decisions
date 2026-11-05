import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
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
import { useLayer } from '../../app/layers.js';
import { useTablet, useCoarsePointer } from '../../app/media.js';
import { FIT, MAX_ZOOM, ZOOM_STEP, isZoomed, panBy, zoomBy, type Size, type View } from './zoom.js';

export interface ZoomTarget {
  view: View;
  natural: Size | undefined;
  size: Size;
  set: (v: View) => void;
}

/** Look further in a direction: the image moves the other way by 15% of the stage. */
const panStep = (t: ZoomTarget & { natural: Size }, dx: number, dy: number): View =>
  panBy(t.view, -dx * t.size.w * 0.15, -dy * t.size.h * 0.15, t.natural, t.size);

/** Zoom and pan commands on one or more linked views (comparison zooms both panes together). */
export function zoomCommands(targets: ZoomTarget[]) {
  const usable = targets.filter((t) => t.natural && t.size.w > 0) as (ZoomTarget & {
    natural: Size;
  })[];
  const first = usable[0];
  const scale = first?.view.scale ?? 1;
  const each = (f: (t: ZoomTarget & { natural: Size }) => View) => {
    for (const t of usable) t.set(f(t));
  };
  return {
    usable: usable.length > 0,
    zoomed: usable.some((t) => isZoomed(t.view)),
    scale,
    zoomIn: () => each((t) => zoomBy(t.view, ZOOM_STEP, { x: 0, y: 0 }, t.natural, t.size)),
    zoomOut: () => each((t) => zoomBy(t.view, 1 / ZOOM_STEP, { x: 0, y: 0 }, t.natural, t.size)),
    fit: () => each(() => FIT),
    pan: (dx: number, dy: number) => each((t) => panStep(t, dx, dy)),
    /** Whether a step that way moves anything: the image already shows its edge on that side otherwise. */
    canPan: (dx: number, dy: number) =>
      usable.some((t) => {
        const v = panStep(t, dx, dy);
        return Math.abs(v.x - t.view.x) > 0.5 || Math.abs(v.y - t.view.y) > 0.5;
      }),
  };
}

export type ZoomCommands = ReturnType<typeof zoomCommands>;

/**
 * Where focus goes when a tool disables itself: the next usable control in its own group (Zoom in after Fit, Previous
 * after Next on the last file, another direction at an edge), else the zoom trigger from its popover, else `stage`.
 */
export function toolFallback(from: HTMLElement, stage: () => HTMLElement | null | undefined) {
  const pop = from.closest('.fx-zoom-menu');
  if (pop)
    return (
      pop.querySelector<HTMLElement>('.fx-zoom-popover button:not(:disabled)') ??
      pop.querySelector<HTMLElement>('.fx-zoom-trigger')
    );
  return (
    from.closest('.fx-tool-group')?.querySelector<HTMLElement>('button:not(:disabled)') ?? stage()
  );
}

/** A browser or system shortcut (page zoom, Back): never the viewer's to take. */
export const isModified = (e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }) =>
  e.metaKey || e.ctrlKey || e.altKey;

export const formatScale = (s: number): string =>
  `${s >= 9.95 ? Math.round(s) : Math.round(s * 10) / 10}×`;

/** A phone wide enough (375 px and up) for − Fit + and Move in the pill beside Previous, Next and Compare. */
const ROOMY_QUERY = '(min-width: 375px)';
function useRoomy(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia !== 'function') return () => undefined;
      const m = matchMedia(ROOMY_QUERY);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => (typeof matchMedia === 'function' ? matchMedia(ROOMY_QUERY).matches : true),
    () => true,
  );
}

/** The Fit button reads the current zoom ("2.5×") and returns to Fit. */
function FitButton({ cmd }: { cmd: ZoomCommands }) {
  return (
    <button
      type="button"
      className="btn ghost fx-tool fx-zoom-value tabular"
      aria-label={cmd.zoomed ? `Fit to screen, now ${formatScale(cmd.scale)}` : 'Fit to screen'}
      aria-keyshortcuts="0"
      title={cmd.zoomed ? 'Fit to screen (0)' : 'At Fit'}
      disabled={!cmd.zoomed}
      onClick={cmd.fit}
    >
      {cmd.zoomed ? formatScale(cmd.scale) : 'Fit'}
    </button>
  );
}

/**
 * − Fit + and Move. On the narrowest phones (under 375 px) − + and Move fold into a Zoom popover beside Fit, so the
 * pill stays on one line; everywhere else they sit inline.
 */
export function ZoomButtons({ cmd, onMove }: { cmd: ZoomCommands; onMove: () => void }) {
  const coarse = useCoarsePointer();
  const tablet = useTablet();
  const roomy = useRoomy();
  if (coarse && !tablet && !roomy) return <ZoomPopover cmd={cmd} onMove={onMove} />;
  return (
    <>
      <div className="fx-tool-group">
        <button
          type="button"
          className="btn ghost icon fx-tool"
          aria-label="Zoom out"
          aria-keyshortcuts="-"
          title="Zoom out (−)"
          disabled={!cmd.zoomed}
          onClick={cmd.zoomOut}
        >
          <ZoomOutIcon size={20} />
        </button>
        <FitButton cmd={cmd} />
        <button
          type="button"
          className="btn ghost icon fx-tool"
          aria-label="Zoom in"
          aria-keyshortcuts="+"
          title="Zoom in (+)"
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

/** Fit, then a Zoom button whose popover holds Zoom in, Zoom out and Move. A layer: Back and Escape close it. */
function ZoomPopover({ cmd, onMove }: { cmd: ZoomCommands; onMove: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  useLayer(open, () => {
    const inside = root.current?.contains(document.activeElement);
    setOpen(false);
    if (inside) trigger.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    root.current?.querySelector<HTMLElement>('.fx-zoom-popover button:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return (
    <>
      <FitButton cmd={cmd} />
      <div
        className="fx-zoom-menu"
        ref={root}
        onBlur={(e) => {
          // Tabbing out of the popover closes it, like a tap outside.
          if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node))
            setOpen(false);
        }}
      >
        <button
          ref={trigger}
          type="button"
          className="btn ghost fx-tool fx-zoom-trigger"
          aria-label="Zoom and move"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          <ZoomInIcon size={20} />
          <ChevronDown size={14} />
        </button>
        {open && (
          <div className="fx-zoom-popover" id={id} role="group" aria-label="Zoom and move">
            <button
              type="button"
              className="btn ghost"
              disabled={!cmd.usable || cmd.scale >= MAX_ZOOM - 0.001}
              onClick={cmd.zoomIn}
            >
              <ZoomInIcon size={18} />
              Zoom in
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={!cmd.zoomed}
              onClick={cmd.zoomOut}
            >
              <ZoomOutIcon size={18} />
              Zoom out
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={!cmd.zoomed}
              onClick={() => {
                setOpen(false);
                onMove();
              }}
            >
              <MoveIcon size={18} />
              Move
            </button>
          </div>
        )}
      </div>
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
      title={label}
      disabled={!cmd.canPan(dx, dy)}
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
      <button type="button" className="btn small fx-done" title="Done (Esc)" onClick={onDone}>
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
        title="Previous file"
        disabled={index <= 0}
        onClick={() => onStep(-1)}
      >
        <ArrowLeft size={20} />
      </button>
      <button
        type="button"
        className="btn ghost icon fx-tool"
        aria-label="Next file"
        title="Next file"
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
      moving
        ? '.fx-tool-group button:not(:disabled)'
        : '[aria-label="Zoom and move"], [aria-label="Move"]:not(:disabled)',
    );
    (next ?? stage())?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving]);
}
