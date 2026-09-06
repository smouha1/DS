/* ============================================================================
   sw.js — optimized app-shell service worker (v31)
   ------------------------------------------------------------------------
   Goals:
     • Fast loads from cache for static assets (CSS/JS)
     • Faster uptake of HTML updates (network-first for navigations)
     • Never cache products.json / version.json (updater.js owns those)
     • Never cache third-party CDN responses
     • Resilient install (one missing file must not fail the whole shell)
     • Drop old caches on activate
   ------------------------------------------------------------------------ */

const CACHE_NAME = 'smouha-pick-shell-v35-1785';

/** Core shell — same-origin only. Lazy modules included so first offline
 *  open of Settings/Maintenance/DMart live still works after one online visit. */
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
  './assets/js/dmartLive.js',
  './assets/js/warehouse.js',
  './assets/js/settings.js',
  './assets/js/maintenance.js',
  './assets/js/qrcode-generator.js',
  './data/warehouses.json',
];

function isDataPath(pathname) {
  return (
    pathname.includes('/data/products.json') ||
    pathname.includes('/data/version.json')
  );
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isStaticAsset(pathname) {
  return (
    pathname.endsWith('.css') ||
    pathname.endsWith('.js') ||
    pathname.endsWith('.json') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.jpg') ||
    pathname.endsWith('.jpeg') ||
    pathname.endsWith('.webp') ||
    pathname.endsWith('.woff2') ||
    pathname.endsWith('.woff')
  );
}

/** Precache shell files one-by-one so a single 404 does not abort install. */
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    SHELL_FILES.map(async (path) => {
      try {
        const req = new Request(path, { cache: 'reload' });
        const res = await fetch(req);
        if (res && res.ok) await cache.put(path, res);
      } catch (e) {
        /* best-effort */
      }
    })
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

/**
 * Stale-while-revalidate: return cache immediately, refresh in background.
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok && request.method === 'GET') {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }
  const fresh = await networkPromise;
  if (fresh) return fresh;
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

/**
 * Network-first for HTML navigations — pick up deploys quickly, fall back to cache.
 */
async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone()).catch(() => {});
      // Also refresh canonical index entry
      cache.put('./index.html', fresh.clone()).catch(() => {});
      return fresh;
    }
  } catch (e) {
    /* offline */
  }
  const cached =
    (await cache.match(request)) ||
    (await cache.match('./index.html')) ||
    (await cache.match('./'));
  if (cached) return cached;
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // Never intercept product catalog / version — updater.js owns freshness.
  if (isDataPath(url.pathname)) return;

  // Third-party (CDN JsBarcode, ZXing, Tesseract, product images hosts): network only.
  if (!isSameOrigin(url)) return;

  // HTML navigations → network-first
  const accept = request.headers.get('accept') || '';
  const isNavigate =
    request.mode === 'navigate' ||
    accept.includes('text/html');

  if (isNavigate) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // Same-origin static assets → stale-while-revalidate
  if (isStaticAsset(url.pathname) || url.pathname.includes('/assets/')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Default same-origin GET: try SWR
  event.respondWith(staleWhileRevalidate(request));
});

/** Optional messages from the page (future: force refresh shell). */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data.type === 'CLEAR_SHELL_CACHE') {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
        await precacheShell();
      })()
    );
  }
});
