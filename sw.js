/*
 * Offline-first service worker. The whole point of this app is a camp with no signal, so the
 * cache is authoritative once populated: serve from cache immediately, and refresh in the
 * background when there happens to be a connection.
 *
 * Bump CACHE when any precached file changes, or phones will keep the old copy forever.
 */
const CACHE = 'cbssa-v1.0.0';
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
