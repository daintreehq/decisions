import { useEffect, useRef, type RefObject } from 'react';

/** Canvas navigation on touch, leaving controls, image gestures, horizontal strips and vertical scrolling alone. */
export function useSwipeOpen(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  right: () => void,
  left?: () => void,
) {
  const latest = useRef({ right, left });
  latest.current = { right, left };
  useEffect(() => {
    const el = root.current;
    if (!el || !enabled) return;
    let drag: { x: number; y: number; dx: number; start: number; claimed: boolean } | null = null;
    const start = (event: TouchEvent) => {
      drag = null;
      if (
        event.touches.length !== 1 ||
        document.querySelector('dialog[open], .ws-overlay:not(:empty), .ws.editor-full')
      )
        return;
      const target = event.target as HTMLElement;
      if (
        target.closest(
          'input, textarea, select, button, a, summary, label, [role="button"], [role="radio"], [contenteditable], [data-no-swipe], .chips, .fs-stage, .fx-overlay, pre, code',
        )
      )
        return;
      if (window.getSelection()?.isCollapsed === false) return;
      for (let node: HTMLElement | null = target; node && node !== el; node = node.parentElement) {
        if (
          node.scrollWidth > node.clientWidth + 2 &&
          /auto|scroll/.test(getComputedStyle(node).overflowX)
        )
          return;
      }
      const touch = event.touches[0]!;
      drag = { x: touch.clientX, y: touch.clientY, dx: 0, start: event.timeStamp, claimed: false };
    };
    const move = (event: TouchEvent) => {
      if (!drag || event.touches.length !== 1) {
        drag = null;
        return;
      }
      const touch = event.touches[0]!;
      const dx = touch.clientX - drag.x;
      const dy = touch.clientY - drag.y;
      if (!drag.claimed) {
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) {
          drag = null;
          return;
        }
        if (Math.abs(dx) <= 24 || Math.abs(dx) <= Math.abs(dy) * 1.4) return;
        if (dx < 0 && !latest.current.left) {
          drag = null;
          return;
        }
        drag.claimed = true;
      }
      drag.dx = dx;
      event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const gesture = drag;
      drag = null;
      if (!gesture?.claimed) return;
      const distance = Math.abs(gesture.dx);
      if (distance < 64 && distance / Math.max(1, event.timeStamp - gesture.start) < 0.5) return;
      if (gesture.dx > 0) latest.current.right();
      else latest.current.left?.();
    };
    const cancel = () => {
      drag = null;
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', cancel);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', cancel);
    };
  }, [root, enabled]);
}
