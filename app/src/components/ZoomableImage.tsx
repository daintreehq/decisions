import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as RPointerEvent,
  type WheelEvent,
} from 'react';

interface View {
  scale: number;
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pinch-to-zoom, drag-to-pan and double-tap image viewer with button controls for accessibility. */
export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number } | null>(null);
  const lastTap = useRef(0);
  const stage = useRef<HTMLDivElement>(null);
  // React's wheel handler is passive, so the browser would also zoom the page; stop that here.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const stop = (e: globalThis.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, []);

  const set = (v: View) =>
    setView({ scale: clamp(v.scale, 1, 6), x: v.scale <= 1 ? 0 : v.x, y: v.scale <= 1 ? 0 : v.y });

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
    } else if (pointers.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        if (view.scale > 1) set({ scale: 1, x: 0, y: 0 });
        else {
          // Zoom in on the point that was tapped, not the centre.
          const r = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - (r.left + r.width / 2);
          const py = e.clientY - (r.top + r.height / 2);
          const s = 2.5;
          set({ scale: s, x: px * (1 - s), y: py * (1 - s) });
        }
        lastTap.current = 0;
      } else lastTap.current = now;
    }
  };

  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      set({ ...view, scale: (gesture.current.scale * dist) / gesture.current.dist });
    } else if (pointers.current.size === 1 && view.scale > 1) {
      set({ ...view, x: view.x + (e.clientX - prev.x), y: view.y + (e.clientY - prev.y) });
    }
  };

  const up = (e: RPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  };

  // Keyboard: arrows pan once zoomed in, + and - zoom, 0 resets.
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = 40;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    if (moves[e.key] && view.scale > 1) {
      const [dx, dy] = moves[e.key]!;
      set({ ...view, x: view.x + dx, y: view.y + dy });
    } else if (e.key === '+' || e.key === '=') set({ ...view, scale: view.scale * 1.5 });
    else if (e.key === '-') set({ ...view, scale: view.scale / 1.5 });
    else if (e.key === '0') set({ scale: 1, x: 0, y: 0 });
    else return;
    e.preventDefault();
  };

  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    // Only a pinch (trackpad, which arrives with ctrlKey) or ⌘/Ctrl+wheel zooms; a plain wheel scrolls the page.
    if (!e.ctrlKey && !e.metaKey) return;
    set({ ...view, scale: view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15) });
  };

  return (
    <div className="zoom">
      <div
        ref={stage}
        className="zoom-stage"
        tabIndex={0}
        role="group"
        aria-label={`${alt}. Pinch or use the buttons to zoom; arrow keys move around when zoomed in.`}
        onKeyDown={key}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={wheel}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
      <div className="zoom-controls" role="group" aria-label="Zoom">
        <button
          type="button"
          className="btn small"
          disabled={view.scale <= 1}
          onClick={() => set({ ...view, scale: view.scale / 1.5 })}
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="btn small"
          disabled={view.scale <= 1}
          onClick={() => set({ scale: 1, x: 0, y: 0 })}
        >
          Fit
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => set({ ...view, scale: view.scale * 1.5 })}
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
    </div>
  );
}
