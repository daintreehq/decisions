import { useSyncExternalStore } from 'react';

/**
 * The layout breakpoints (guide 3.2), in em so a larger default text size falls back to the simpler layout.
 * 45em = 720px (one centred surface), 68.75em = 1100px (the sidebar becomes a persistent column).
 * styles/shell.css uses the same values.
 */
export const TABLET_QUERY = '(min-width: 45em)';
export const WIDE_QUERY = '(min-width: 68.75em)';

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia !== 'function') return () => undefined;
      const m = matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false),
    () => false,
  );
}

/** 1100px and up: the sidebar is a persistent column rather than an overlay. */
export const useWide = (): boolean => useMedia(WIDE_QUERY);
/** 720px and up. */
export const useTablet = (): boolean => useMedia(TABLET_QUERY);
export const useCoarsePointer = (): boolean => useMedia('(pointer: coarse)');

export const isWide = (): boolean =>
  typeof matchMedia === 'function' && matchMedia(WIDE_QUERY).matches;
