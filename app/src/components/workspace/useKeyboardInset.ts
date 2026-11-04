import { useEffect, type RefObject } from 'react';

/**
 * Keeps the workspace (and so the editor, Send and Stop) above an on-screen keyboard. The keyboard is inferred only
 * when a text field in the workspace has focus and the page is not zoomed, never from height alone (pinch zoom
 * shrinks the visual viewport too). It sets `--vv-h` and `--vv-top` and `data-kb` on the workspace root, and
 * `--vv-top` on the shell too, so the floating menu button stays in the raised header's leading slot.
 */
export function useKeyboardInset(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const el = root.current;
    if (!vv || !el) return;
    const shell = el.closest<HTMLElement>('.shell');
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const active = document.activeElement as HTMLElement | null;
        const typing =
          !!active &&
          el.contains(active) &&
          (active.tagName === 'TEXTAREA' ||
            (active.tagName === 'INPUT' &&
              /^(text|search|)$/.test((active as HTMLInputElement).type)));
        const inset = window.innerHeight - vv.height - vv.offsetTop;
        const zoomed = Math.abs(vv.scale - 1) > 0.01;
        if (typing && !zoomed && inset > 80) {
          el.dataset.kb = '';
          el.style.setProperty('--vv-h', `${vv.height}px`);
          el.style.setProperty('--vv-top', `${vv.offsetTop}px`);
          shell?.style.setProperty('--vv-top', `${vv.offsetTop}px`);
        } else if ('kb' in el.dataset) {
          delete el.dataset.kb;
          el.style.removeProperty('--vv-h');
          el.style.removeProperty('--vv-top');
          shell?.style.removeProperty('--vv-top');
        }
      });
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    el.addEventListener('focusin', update);
    el.addEventListener('focusout', update);
    return () => {
      cancelAnimationFrame(raf);
      shell?.style.removeProperty('--vv-top');
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      el.removeEventListener('focusin', update);
      el.removeEventListener('focusout', update);
    };
  }, [root]);
}
