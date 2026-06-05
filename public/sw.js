// EduRankAI service worker
// Cache name bumped on each material change so devices pick up the new SW
// (browsers consider the SW updated if the file bytes differ).
// v4: forced invalidation to clear black-screen state caused by a stale
// pre-Astro-build worker that was still installed on some devices.
const CACHE = 'edurankai-v4';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Drop every old cache so stale SWs on existing devices get evicted.
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Push: read the JSON payload from the server (title/body/url/tag) and show
// THAT notification. Without this the OS falls back to a generic message.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) {
      try { data = event.data.json(); }
      catch (_) { data = { title: 'EduRankAI', body: event.data.text() }; }
    }
  } catch (_) {}

  const title = data.title || 'EduRankAI';
  const options = {
    body: data.body || '',
    icon: data.icon || '/era/icon-192.png',
    badge: data.badge || '/era/badge-72.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/', type: data.type || '' },
    requireInteraction: !!data.requireInteraction,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Click: focus an existing tab on the same URL, or open a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        try {
          if ('focus' in client && client.url.includes(new URL(url, self.location.origin).pathname)) {
            return client.focus();
          }
        } catch (_) {}
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
