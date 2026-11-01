/// <reference lib="webworker" />
import { isCacheable, safeTargetUrl, shapePush } from './sw-core.js';

declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE__: string[];
declare const __BUILD_ID__: string;

const PREFIX = 'decisions-shell-';
const CACHE = PREFIX + __BUILD_ID__;
const PRECACHE = new Set(__PRECACHE__);

self.addEventListener('install', (event) => {
  // No skipWaiting here: the page decides when to switch so an in-flight outbox flush is never cut off.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([...PRECACHE].map((u) => new Request(u, { cache: 'reload' })))),
  );
});

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys())
        if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (
    req.mode === 'navigate' &&
    url.origin === self.location.origin &&
    !url.pathname.startsWith('/api/')
  ) {
    // App shell: network first so a fresh deploy wins, cached shell when offline.
    event.respondWith(
      fetch(req).catch(
        async () => (await caches.match('/', { cacheName: CACHE })) ?? Response.error(),
      ),
    );
    return;
  }
  if (isCacheable(url, req.method, self.location.origin, PRECACHE)) {
    event.respondWith(caches.match(req, { cacheName: CACHE }).then((hit) => hit ?? fetch(req)));
  }
  // Everything else (all of /api, attachment bytes, sockets) is deliberately untouched.
});

self.addEventListener('push', (event) => {
  let payload: unknown = null;
  try {
    payload = event.data?.json();
  } catch {
    payload = null;
  }
  const n = shapePush(payload);
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeTargetUrl(event.notification.data);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          await w.focus();
          if ('navigate' in w) await (w as WindowClient).navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
