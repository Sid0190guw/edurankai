// EduRankAI service worker
// Cache name bumped on each material change so devices pick up the new SW
// (browsers consider the SW updated if the file bytes differ).
// v4: forced invalidation to clear black-screen state caused by a stale
// pre-Astro-build worker that was still installed on some devices.
const CACHE = 'edurankai-v5';

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

// Push: render a RICH notification from the server payload — banner image,
// action buttons (deep-linked), vibration + requireInteraction by priority,
// category badge. Action urls are stashed in data so the click handler can
// route per-button. All client-side: zero server/DB cost.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) {
      try { data = event.data.json(); }
      catch (_) { data = { title: 'EduRankAI', body: event.data.text() }; }
    }
  } catch (_) {}

  const title = data.title || 'EduRankAI';

  // Map payload actions -> Notification actions (max 2 shown by most browsers),
  // and build a lookup so notificationclick knows where each button goes.
  var actions = [];
  var actionUrls = {};
  if (Array.isArray(data.actions)) {
    data.actions.slice(0, 2).forEach(function (a) {
      if (!a || !a.action) return;
      actions.push({ action: a.action, title: a.title || a.action });
      if (a.url) actionUrls[a.action] = a.url;
    });
  }

  var hasVibrate = Array.isArray(data.vibrate) && data.vibrate.length > 0;
  const options = {
    body: data.body || '',
    icon: data.icon || '/era/icon-192.png',
    badge: data.badge || '/era/badge-72.png',
    image: data.image || undefined,
    tag: data.tag || undefined,
    renotify: data.tag ? true : undefined,
    timestamp: Date.now(),
    actions: actions,
    vibrate: hasVibrate ? data.vibrate : undefined,
    requireInteraction: !!data.requireInteraction,
    data: {
      url: data.url || '/',
      type: data.type || '',
      category: data.category || '',
      priority: data.priority || '',
      actionUrls: actionUrls,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Click: route action buttons to their own url, else the notification url.
// Focus an already-open tab on that path when possible; otherwise open one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  var url = d.url || '/';
  if (event.action && d.actionUrls && d.actionUrls[event.action]) {
    url = d.actionUrls[event.action];
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        try {
          if ('focus' in client && client.url.includes(new URL(url, self.location.origin).pathname)) {
            client.focus();
            try { client.navigate(url); } catch (_) {}
            return;
          }
        } catch (_) {}
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
