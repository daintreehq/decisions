import { flushSync } from 'react-dom';

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let active: ViewTransition | undefined;

/** Capture the outgoing React screen before committing the incoming one. Layers own their own motion. */
export function transitionPage(
  from: string,
  to: string,
  update: () => void,
  nativeTransition = false,
): void {
  active?.skipTransition();
  active = undefined;
  const root = document.documentElement;
  delete root.dataset.pageMotion;
  root.style.removeProperty('--motion-width');
  root.style.removeProperty('--motion-height');
  if (
    from === to ||
    nativeTransition ||
    prefersReducedMotion() ||
    document.querySelector('dialog[open]') ||
    !document.querySelector('.shell')
  ) {
    update();
    return;
  }
  const direction = to.startsWith('/q/') ? 'forward' : from.startsWith('/q/') ? 'back' : 'fade';
  if (!document.startViewTransition) {
    update();
    // Older browsers still get a gentle arrival, without keeping a second interactive screen mounted.
    document.getElementById('main')?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      easing: 'ease-out',
    });
    return;
  }
  root.dataset.pageMotion = direction;
  root.style.setProperty('--motion-width', `${window.innerWidth}px`);
  root.style.setProperty('--motion-height', `${window.innerHeight}px`);
  const transition = document.startViewTransition(() => flushSync(update));
  active = transition;
  // A rotation or keyboard resize invalidates these snapshots. Skip rather than stretching them to fit.
  const resized = () => transition.skipTransition();
  window.addEventListener('resize', resized);
  // A second navigation, backgrounding, or a browser declining a snapshot can skip the animation.
  void transition.ready.catch(() => undefined);
  void transition.finished
    .catch(() => undefined)
    .then(() => {
      window.removeEventListener('resize', resized);
      if (active !== transition) return;
      active = undefined;
      delete root.dataset.pageMotion;
      root.style.removeProperty('--motion-width');
      root.style.removeProperty('--motion-height');
    });
}
