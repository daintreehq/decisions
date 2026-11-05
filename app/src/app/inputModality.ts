/** Programmatic focus still serves assistive technology; only keyboard interactions need a visible ring. */
export function trackInputModality(): void {
  const root = document.documentElement;
  root.dataset.input = 'pointer';
  document.addEventListener('pointerdown', () => (root.dataset.input = 'pointer'), true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) root.dataset.input = 'keyboard';
    },
    true,
  );
}
