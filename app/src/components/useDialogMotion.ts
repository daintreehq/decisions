import { useLayoutEffect, useState, type RefObject } from 'react';
import { prefersReducedMotion } from '../app/motion.js';

/** The longest transition the closing state runs, in ms, read from the stylesheet that owns it. */
function exitMs(el: HTMLElement): number {
  const s = getComputedStyle(el);
  const times = (list: string) =>
    list
      .split(',')
      .map((t) => parseFloat(t) * (t.trim().endsWith('ms') ? 1 : 1000))
      .filter((n) => Number.isFinite(n));
  const durations = times(s.transitionDuration || '');
  const delays = times(s.transitionDelay || '');
  return Math.max(0, ...durations.map((d, i) => d + (delays[i % delays.length] ?? 0)));
}

/**
 * Keep a modal and its content alive through its exit, including when Back dismisses it. The exit lasts as long as
 * the modal's own closing transition (the sheet's 100 ms tier, the navigator's slide), so each stylesheet owns its
 * timing. It opens before the first paint, so a modal never flashes in its unopened state and the layout effects that
 * follow (focus, measuring the actions) see it on screen.
 */
export function useDialogMotion(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  animateExit = true,
): boolean {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      dialog.style.transform = '';
      dialog.removeAttribute('data-closing');
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (!dialog.open) return;
    const finish = () => {
      dialog.close();
      dialog.removeAttribute('data-closing');
      dialog.removeAttribute('data-swiped');
      setPresent(false);
    };
    if (!animateExit || prefersReducedMotion()) {
      finish();
      return;
    }
    // The closing state and the cleared swipe offset land in one style change, so the exit starts where the finger
    // left the sheet and carries on down rather than jumping back.
    dialog.setAttribute('data-closing', '');
    dialog.style.transform = '';
    const ms = exitMs(dialog);
    if (ms <= 0) {
      finish();
      return;
    }
    const timer = setTimeout(finish, ms + 20);
    return () => clearTimeout(timer);
  }, [open, ref, animateExit]);
  return open || present;
}
