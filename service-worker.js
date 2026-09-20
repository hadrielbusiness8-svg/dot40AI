// Dot.40 service worker — intentionally minimal.
// No caching: this exists purely so browsers treat the site as installable.
// (Caching Dot.40's chat data would risk showing stale/incorrect content,
// so every request just passes straight through to the network.)

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => new Response('Offline — Dot.40 needs an internet connection.', { status: 503 }))
  );
});
