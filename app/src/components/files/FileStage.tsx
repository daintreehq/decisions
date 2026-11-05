import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from 'react';
import { DEFAULT_GESTURE, GestureRecognizer, type GestureEvent, type Point } from './gesture.js';
import {
  FIT,
  displayedSize,
  doubleTapView,
  isZoomed,
  panBy,
  pinchView,
  zoomBy,
  type Size,
  type View,
} from './zoom.js';

export interface StageSlide {
  /** The file's identity (attachment and digest). */
  key: string;
  id: string;
  /** Present once the file is verified. */
  src?: string;
  alt: string;
  natural?: Size;
  /** What the slide shows while it has no verified image: preparing, error, expired, unverified. */
  placeholder?: ReactNode;
}

export interface FileStageProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  slides: StageSlide[];
  active: number;
  /** The active slide's view (viewer and comparison). Absent: always at Fit (inline). */
  view?: View;
  onView?: (v: View) => void;
  /** Swipe commit: −1 previous, +1 next. Omit to disable swiping. */
  onStep?: (dir: -1 | 1) => void;
  canStep?: (dir: -1 | 1) => boolean;
  /** Click or tap on the stage (not after a drag). */
  onActivate?: () => void;
  /**
   * A single tap that is not the first half of a double-tap: it fires once the double-tap window has passed with no
   * further contact, so a double-tap (zoom) never also counts as a tap. Drags, swipes and pinches never fire it.
   */
  onTap?: () => void;
  onNatural: (id: string, size: Size) => void;
  onSize?: (size: Size) => void;
  /** `inline` lets the page scroll vertically and pinch-zoom; `zoom` owns every touch. */
  touch: 'inline' | 'zoom';
  children?: ReactNode;
}

export interface FileStageHandle {
  el: HTMLDivElement | null;
  /** The image area the zoom maths measure. */
  track: HTMLDivElement | null;
}

/**
 * The darkest plane, holding a track of slides (one per file). The active slide is centred; its neighbours sit a
 * stage-width away so a swipe at Fit can follow the finger and bring the next one in. Zoom and pan apply only to
 * the active slide, through the one gesture recogniser.
 */
export const FileStage = forwardRef<FileStageHandle, FileStageProps>(function FileStage(
  {
    slides,
    active,
    view,
    onView,
    onStep,
    canStep,
    onActivate,
    onTap,
    onNatural,
    onSize,
    touch,
    className = '',
    children,
    ...rest
  },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ el: el.current, track: track.current }), []);
  const rec = useRef(new GestureRecognizer());
  // A tap waits out the double-tap window before it counts: any new contact (the second tap, a drag, a pinch) or a
  // file change cancels it.
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  const cancelTap = () => {
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = null;
  };
  useEffect(() => cancelTap, []);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [dragDx, setDragDx] = useState(0);
  const [gesturing, setGesturing] = useState(false);
  const pinchStart = useRef<{ view: View; mid: Point; dist: number } | null>(null);

  // Latest values for native listeners and gesture callbacks.
  const live = useRef({ view, onView, size, natural: slides[active]?.natural, onStep, canStep });
  live.current = { view, onView, size, natural: slides[active]?.natural, onStep, canStep };

  // The track is the image area (the stage may pad it); zoom maths work in its box.
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const measure = () => {
      const r = node.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  useEffect(() => onSize?.(size), [size, onSize]);

  // A file change abandons any drag in progress on the old one.
  useEffect(() => {
    rec.current.reset();
    cancelTap();
    pinchStart.current = null;
    setDragDx(0);
    setGesturing(false);
  }, [active]);

  const rel = (p: Point): Point => {
    const r = (track.current ?? el.current!).getBoundingClientRect();
    return { x: p.x - (r.left + r.width / 2), y: p.y - (r.top + r.height / 2) };
  };

  const apply = (events: GestureEvent[]) => {
    const { view: v, onView: set, size: s, natural: n, onStep: step, canStep: can } = live.current;
    for (const ev of events) {
      switch (ev.type) {
        case 'swipe-move': {
          if (!step) break;
          const dir = ev.dx < 0 ? 1 : -1;
          // At the first or last file the track resists instead of revealing nothing (no wrap).
          setDragDx(can && !can(dir) ? ev.dx * 0.2 : ev.dx);
          break;
        }
        case 'swipe-end':
          setDragDx(0);
          if (ev.commit && step && (!can || can(ev.commit))) step(ev.commit);
          break;
        case 'pan':
          if (v && set && n) set(panBy(v, ev.dx, ev.dy, n, s));
          break;
        case 'pinch-start':
          if (v && set && n) pinchStart.current = { view: v, mid: rel(ev.mid), dist: ev.dist };
          break;
        case 'pinch-move': {
          const p = pinchStart.current;
          if (p && set && n) set(pinchView(p.view, p.mid, p.dist, rel(ev.mid), ev.dist, n, s));
          break;
        }
        case 'pinch-end':
          pinchStart.current = null;
          break;
        case 'double-tap':
          cancelTap();
          if (v && set && n) set(doubleTapView(v, rel(ev), n, s));
          break;
        case 'tap':
          cancelTap();
          if (!onTapRef.current) break;
          tapTimer.current = setTimeout(() => {
            tapTimer.current = null;
            onTapRef.current?.();
          }, DEFAULT_GESTURE.doubleTapMs);
          break;
      }
    }
  };

  const ctx = () => ({
    zoomed: !!live.current.view && isZoomed(live.current.view),
    width: live.current.size.w || 1,
  });

  /** Controls inside a slide (Retry) keep their own pointer events: no capture, no gesture. */
  const onControl = (e: RPointerEvent<HTMLDivElement>) =>
    e.target !== e.currentTarget &&
    !!(e.target as HTMLElement).closest?.('button, a, input, select, textarea');

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (onControl(e)) return;
    cancelTap();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    apply(rec.current.down(e.pointerId, e.clientX, e.clientY, e.timeStamp, ctx()));
    setGesturing(rec.current.activePointers > 0);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    apply(rec.current.move(e.pointerId, e.clientX, e.clientY, e.timeStamp, ctx()));
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    apply(rec.current.up(e.pointerId, e.clientX, e.clientY, e.timeStamp, ctx()));
    setGesturing(rec.current.activePointers > 0);
  };
  const cancel = (e: RPointerEvent<HTMLDivElement>) => {
    apply(rec.current.cancel(e.pointerId, e.timeStamp));
    setGesturing(rec.current.activePointers > 0);
  };

  // Wheel: a trackpad pinch (ctrlKey) or ⌘/Ctrl+wheel zooms; a plain wheel pans once zoomed. React's wheel
  // listener is passive, so this one is native.
  useEffect(() => {
    const node = el.current;
    if (!node || touch !== 'zoom') return;
    const wheel = (e: WheelEvent) => {
      const { view: v, onView: set, size: s, natural: n } = live.current;
      if (!v || !set || !n) return;
      cancelTap();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(Math.max(-0.5, Math.min(0.5, -e.deltaY / 120)));
        set(zoomBy(v, factor, rel({ x: e.clientX, y: e.clientY }), n, s));
      } else if (isZoomed(v)) {
        e.preventDefault();
        set(panBy(v, -e.deltaX, -e.deltaY, n, s));
      }
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [touch]);

  return (
    <div
      ref={el}
      className={`fs-stage touch-${touch}${gesturing ? ' is-gesturing' : ''} ${className}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onClickCapture={(e) => {
        if (rec.current.shouldSuppressClick(e.timeStamp)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={onActivate}
      onDragStart={(e) => e.preventDefault()}
      {...rest}
    >
      <div
        ref={track}
        className={`fs-track${dragDx ? ' is-dragging' : ''}`}
        style={{ transform: dragDx ? `translate3d(${dragDx}px, 0, 0)` : undefined }}
      >
        {slides.map((s, i) => {
          const offset = i - active;
          // Only the active slide and its neighbours are laid out; the rest stay out of the way.
          if (Math.abs(offset) > 1) return null;
          const isActive = offset === 0;
          const v = isActive && view ? view : FIT;
          let imgStyle: CSSProperties | undefined;
          if (s.natural && size.w > 0) {
            const d = displayedSize(s.natural, size, v.scale);
            imgStyle = {
              width: d.w,
              height: d.h,
              transform: `translate(calc(-50% + ${v.x}px), calc(-50% + ${v.y}px))`,
            };
          }
          return (
            <div
              key={s.key}
              className={`fs-slide${isActive ? ' is-active' : ''}`}
              style={{
                transform: offset
                  ? `translate3d(calc(${offset} * (100% + var(--fs-gap))), 0, 0)`
                  : undefined,
              }}
              aria-hidden={isActive ? undefined : true}
              // Neighbours are clipped off-stage: nothing in them may take focus.
              inert={!isActive}
            >
              {s.src ? (
                <img
                  src={s.src}
                  alt={isActive ? s.alt : ''}
                  draggable={false}
                  className={imgStyle ? 'is-sized' : undefined}
                  style={imgStyle}
                  onLoad={(e) =>
                    onNatural(s.id, {
                      w: e.currentTarget.naturalWidth,
                      h: e.currentTarget.naturalHeight,
                    })
                  }
                />
              ) : (
                s.placeholder
              )}
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
});
