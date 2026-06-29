// EduRankAI service worker
// Cache name bumped on each material change so devices pick up the new SW
// (browsers consider the SW updated if the file bytes differ).
// v4: forced invalidation to clear black-screen state caused by a stale
// pre-Astro-build worker that was still installed on some devices.
// v6: add offline support (installed PWA works without a connection).
const CACHE = 'edurankai-v6';
const STATIC_CACHE = 'edurankai-static-v6';
const PAGE_CACHE = 'edurankai-pages-v6';
// Pre-cache a couple of useful pages so the very first offline launch works.
const PRECACHE = ['/', '/resume'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(PAGE_CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  // Keep the current caches; evict everything older so stale SWs get cleaned up.
  const keep = [CACHE, STATIC_CACHE, PAGE_CACHE];
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => keep.indexOf(k) < 0).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Offline strategy (conservative — never serves stale private data):
//   - /api, /admin, /portal      -> network only (dynamic / per-user)
//   - cross-origin (CDN, fonts)  -> passthrough, no caching
//   - static (/era, /_astro, assets) -> cache-first
//   - other GET pages            -> network-first, fall back to cache, then a
//                                   simple offline page.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (path.startsWith('/api/') || path.startsWith('/admin') || path.startsWith('/portal')) return;

  const isStatic = path.startsWith('/era/') || path.startsWith('/_astro/') ||
    /\.(css|js|svg|woff2?|png|jpg|jpeg|gif|webp|ico|json|txt)$/i.test(path);

  if (isStatic) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
        if (resp && resp.ok) { const copy = resp.clone(); caches.open(STATIC_CACHE).then((c) => c.put(req, copy)); }
        return resp;
      }).catch(() => hit))
    );
    return;
  }

  event.respondWith(
    fetch(req).then((resp) => {
      if (resp && resp.ok && resp.type === 'basic') { const copy = resp.clone(); caches.open(PAGE_CACHE).then((c) => c.put(req, copy)); }
      return resp;
    }).catch(() => caches.match(req).then((hit) => hit || new Response(
      '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Offline — EduRankAI</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 24px;background:#faf8f3;color:#1a1a1a;"><h1 style="font-weight:700;">You are offline</h1><p style="color:#6b6b6b;">This page is not saved for offline use yet. Reconnect and try again.</p><a href="/" style="color:#FF4F00;font-weight:600;">Go to homepage</a></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )))
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
