/*
 * Offline-first service worker. The whole point of this app is a camp with no signal, so the
 * cache is authoritative once populated: serve from cache immediately, and refresh in the
 * background when there happens to be a connection.
 *
 * Bump CACHE when any precached file changes, or phones will keep the old copy forever.
 *
 * "Precached" undersells it. The fetch handler below is cache-first for EVERY same-origin GET and
 * writes every successful response back, so index.html is cached at runtime even though it is not
 * in ASSETS — and app.html registers this worker at directory scope, so the install page is
 * governed by it for anyone who has ever tapped "Open the schedule". Changing index.html without
 * bumping this constant therefore ships nothing to the people who already have the page. Treat any
 * change under this directory as a reason to bump, not just changes to the ASSETS list.
 */
const CACHE = 'cbssa-v1.1.0';
const ASSETS = [
  './app.html',
  './engine.js',
  './school.json',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      // Cache first. A stale schedule that opens instantly beats a spinner on one bar.
      return cached || network;
    })
  );
});
