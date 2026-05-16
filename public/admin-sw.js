// Minimal service worker for PWA installability
// Does NOT cache pages aggressively (admin must always show fresh data)
const CACHE_NAME = 'edurankai-admin-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-first strategy: always try network, fall back to cache only if offline
self.addEventListener('fetch', (event) => {
  // Only handle GET requests for same-origin
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // Offline fallback for HTML requests
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return new Response('Offline. Please reconnect.', {
            status: 503,
            headers: { 'Content-Type': 'text/html' }
          });
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});