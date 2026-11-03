import {
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { dropLayers, hasLayers } from './layers.js';

const EVT = 'decisions:navigate';

export function navigate(to: string, replace = false): void {
  // Leaving through an open layer (the navigator, say) replaces its history entry instead of stacking on it.
  if (hasLayers()) {
    dropLayers();
    replace = true;
  }
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  window.dispatchEvent(new Event(EVT));
  window.scrollTo(0, 0);
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  window.addEventListener(EVT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(EVT, cb);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export type Route =
  | { name: 'inbox' }
  | { name: 'question'; id: string }
  | { name: 'history' }
  | { name: 'devices' }
  | { name: 'settings'; section?: string }
  | { name: 'pair' }
  | { name: 'install' }
  | { name: 'privacy' }
  | { name: 'not-found' };

export function matchRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'inbox' };
  const q = /^\/q\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (q) return { name: 'question', id: q[1]! };
  const st = /^\/settings\/([a-z-]{1,32})$/.exec(p);
  if (st) return { name: 'settings', section: st[1]! };
  switch (p) {
    case '/history':
      return { name: 'history' };
    case '/devices':
      return { name: 'devices' };
    case '/settings':
      return { name: 'settings' };
    case '/pair':
      return { name: 'pair' };
    case '/install':
      return { name: 'install' };
    case '/privacy':
      return { name: 'privacy' };
    default:
      return { name: 'not-found' };
  }
}

export function useRoute(): Route {
  return matchRoute(usePath());
}

export function Link({
  to,
  children,
  onClick,
  ...rest
}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
