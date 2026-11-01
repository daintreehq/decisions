import { useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent } from 'react';

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
      if (now - lastTap.current < 300)
        set(view.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: 0, y: 0 });
      lastTap.current = now;
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

  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && Math.abs(e.deltaY) < 1) return;
    set({ ...view, scale: view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15) });
  };

  return (
    <div className="zoom">
      <div
        className="zoom-stage"
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
          onClick={() => set({ ...view, scale: view.scale / 1.5 })}
          aria-label="Zoom out"
        >
          −
        </button>
        <button type="button" className="btn small" onClick={() => set({ scale: 1, x: 0, y: 0 })}>
          Reset
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
