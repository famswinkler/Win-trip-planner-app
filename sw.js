// Service worker: this is what makes the app survive a dead connection.
//
// Strategy:
//   - App shell (HTML, CSS, JS, icons): cache-first, refreshed in the
//     background. Instant launch, and it still launches with no signal.
//   - Trip seed JSON: network-first with a cache fallback, so a redeploy is
//     picked up when online but never blocks a cold start offline.
//   - Everything cross-origin (Google APIs, Gemini, the sign-in library):
//     never cached. Those responses carry tokens and personal data, and a
//     stale answer would be worse than an honest failure.

const VERSION = 'v3';
const SHELL_CACHE = `trip-shell-${VERSION}`;
const DATA_CACHE = `trip-data-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/styles.css',
  'assets/js/app.js',
  'assets/js/store.js',
  'assets/js/util.js',
  'assets/js/views.js',
  'assets/js/summary.js',
  'assets/js/gemini.js',
  'assets/js/google.js',
  'assets/js/ingest.js',
  'assets/js/drivesync.js',
  'assets/js/merge.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-180.png',
];

const DATA = ['data/trip-spain-2026.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // addAll fails the whole install if one file 404s; add individually so a
    // single missing icon cannot leave the app with no offline support at all.
    await Promise.all(SHELL.map((url) => shell.add(url).catch(() => {})));
    const data = await caches.open(DATA_CACHE);
    await Promise.all(DATA.map((url) => data.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function isDataRequest(url) {
  return url.pathname.endsWith('.json') && url.pathname.includes('/data/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // never touch third-party traffic

  // Navigations: serve the shell so deep links work offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('index.html', fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match('index.html', { ignoreSearch: true });
        return cached || new Response(
          '<h1>Offline</h1><p>Open the app once while online to install it.</p>',
          { headers: { 'Content-Type': 'text/html' }, status: 200 },
        );
      }
    })());
    return;
  }

  if (isDataRequest(url)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(DATA_CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        return new Response('{}', { headers: { 'Content-Type': 'application/json' }, status: 503 });
      }
    })());
    return;
  }

  // Static assets: cache-first, refresh in the background.
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    const network = fetch(request).then((res) => {
      if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(request, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
