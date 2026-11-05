import { useEffect, useState, type RefObject } from 'react';
import { prefersReducedMotion } from '../app/motion.js';

/** Keep a modal and its content alive through its exit, including when Back dismisses it. */
export function useDialogMotion(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  animateExit = true,
): boolean {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      dialog.removeAttribute('data-closing');
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (!dialog.open) return;
    const finish = () => {
      dialog.close();
      dialog.removeAttribute('data-closing');
      setPresent(false);
    };
    if (!animateExit || prefersReducedMotion()) {
      finish();
      return;
    }
    dialog.setAttribute('data-closing', '');
    const timer = setTimeout(finish, 220);
    return () => clearTimeout(timer);
  }, [open, ref, animateExit]);
  return open || present;
}
