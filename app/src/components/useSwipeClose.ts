import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/**
 * Swipe to close for a panel that slides in from a screen edge (the sidebar from the left, the terminal drawer from
 * the right): a horizontal drag toward that edge follows the finger and closes the panel past a third of its width
 * or on a flick; anything else springs back. Touch and pen only (a mouse selects text), and only once the drag is
 * plainly horizontal, so vertical scrolling and text selection inside the panel stay native. The panel's element
 * gets `data-dragging` while a finger holds it, so its CSS can drop the transition. A second finger (a pinch to zoom)
 * or a cancelled pointer springs the panel back and never closes it. The panel's Close button, Escape, Back and a tap
 * on the dimmed page are the alternatives to the gesture.
 */
export function useSwipeClose(
  panel: RefObject<HTMLElement | null>,
  edge: 'left' | 'right',
  close: () => void,
) {
  const sign = edge === 'left' ? -1 : 1;
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    t: number;
    dx: number;
    on: boolean;
  } | null>(null);

  /** Touch and pen pointers currently down on the panel. */
  const down = useRef(new Set<number>());
  const springBack = () => {
    const d = panel.current;
    if (drag.current?.on && d) {
      d.removeAttribute('data-dragging');
      d.style.transform = '';
    }
    drag.current = null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse') return;
    down.current.add(e.pointerId);
    // More than one finger is a pinch, never a swipe.
    if (down.current.size > 1) {
      springBack();
      return;
    }
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
      dx: 0,
      on: false,
    };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = drag.current;
    const d = panel.current;
    if (!s || !d || s.id !== e.pointerId) return;
    // Distance toward the panel's edge (positive) and across it.
    const dx = (e.clientX - s.x) * sign;
    const dy = e.clientY - s.y;
    if (!s.on) {
      if (dx > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        s.on = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // A pointer the browser no longer tracks: the drag still follows its moves.
        }
        d.setAttribute('data-dragging', '');
      } else if (Math.abs(dy) > 10 || dx < -10) {
        drag.current = null;
        return;
      } else return;
    }
    s.dx = Math.max(0, dx);
    d.style.transform = `translateX(${s.dx * sign}px)`;
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLElement>) => {
    down.current.delete(e.pointerId);
    const s = drag.current;
    const d = panel.current;
    if (!s || s.id !== e.pointerId) return;
    if (e.type === 'pointercancel' || !d || !s.on) {
      springBack();
      return;
    }
    drag.current = null;
    d.removeAttribute('data-dragging');
    const velocity = s.dx / Math.max(1, e.timeStamp - s.t);
    if (s.dx > d.offsetWidth / 3 || velocity > 0.6) close();
    else d.style.transform = '';
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
  };
}
