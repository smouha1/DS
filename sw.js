/* ============================================================================
   sw.js — minimal app-shell service worker
   ------------------------------------------------------------------------
   Deliberately conservative: caches only the static app shell (HTML, CSS,
   JS, manifest), NEVER data/products.json or data/version.json. Those two
   files already have their own explicit, version-aware update logic in
   assets/js/updater.js — letting the service worker cache them too would
   create a second, conflicting layer of "is this stale?" logic. A
   network-first strategy for data files, cache-first for the shell.
   ============================================================================ */

const CACHE_NAME = 'smouha-pick-shell-v10-1760';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './assets/css/main.css',
  './assets/css/cards.css',
  './assets/css/buttons.css',
  './assets/css/search.css',
  './assets/css/settings.css',
  './assets/css/warehouse.css',
  './assets/js/app.js',
  './assets/js/utils.js',
  './assets/js/indexeddb.js',
  './assets/js/barcode.js',
  './assets/js/search.js',
  './assets/js/updater.js',
  './assets/js/image.js',
  './assets/js/dmart.js',
  './assets/js/warehouse.js',
  './assets/js/qrcode-generator.js',
  './data/warehouses.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => { /* best-effort — offline support, not a hard requirement */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept data files — updater.js owns their freshness logic.
  if (url.pathname.includes('/data/products.json') || url.pathname.includes('/data/version.json')) {
    return;
  }

  // App shell: cache-first, falling back to network (and re-caching).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
