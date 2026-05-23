const CACHE_NAME = 'memeperp-v40';
const CORE_ASSETS = [
  './',
  './testnet.html',
  './manifest.json',
  './INTEGRATION.md'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Always fetch navigations and scripts fresh to avoid stale trading logic.
  const isNavigation = req.mode === 'navigate' || req.destination === 'document';
  const isScript = req.destination === 'script';
  if (isNavigation || isScript) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./testnet.html')))
    );
    return;
  }

  // For same-origin app shell files: network first, fallback cache
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./testnet.html')))
    );
    return;
  }

  // For external APIs: network first, fallback to cached response when offline
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
