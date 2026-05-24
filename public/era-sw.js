/* EduRankAI service worker - minimal, conservative.
   Registered as /era-sw.js to avoid clobbering legacy /sw.js.
   Strategy:
     - /api/*, /admin/*, /portal/*  -> network only (private/dynamic)
     - static (/era/, /_astro/, *.css/js/svg/woff2) -> cache-first
     - other GET pages -> network-first with cache fallback
*/
const VERSION = 'era-v1';
const STATIC_CACHE = 'era-static-' + VERSION;
const PAGE_CACHE = 'era-pages-' + VERSION;

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) {
        if (k !== STATIC_CACHE && k !== PAGE_CACHE && k.startsWith('era-')) return caches.delete(k);
      }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var path = url.pathname;

  if (path.startsWith('/api/') || path.startsWith('/admin') || path.startsWith('/portal')) {
    return;
  }

  var isStatic = path.startsWith('/era/') ||
                 path.startsWith('/_astro/') ||
                 /\.(css|js|svg|woff2?|png|jpg|jpeg|gif|webp|ico)$/i.test(path);

  if (isStatic) {
    e.respondWith(
      caches.match(req).then(function(hit) {
        if (hit) return hit;
        return fetch(req).then(function(resp) {
          if (resp && resp.ok) {
            var copy = resp.clone();
            caches.open(STATIC_CACHE).then(function(c) { c.put(req, copy); });
          }
          return resp;
        });
      })
    );
    return;
  }

  e.respondWith(
    fetch(req).then(function(resp) {
      if (resp && resp.ok && resp.type === 'basic') {
        var copy = resp.clone();
        caches.open(PAGE_CACHE).then(function(c) { c.put(req, copy); });
      }
      return resp;
    }).catch(function() {
      return caches.match(req).then(function(hit) {
        return hit || new Response(
          '<!doctype html><meta charset=utf-8><title>Offline - EduRankAI</title><body style="font-family:system-ui;text-align:center;padding:40px;background:#08080a;color:#fff;"><h1>You are offline</h1><p style="color:#a8a8b3;">Reconnect to load this page.</p><a href="/" style="color:#FF7040;">Try again</a></body>',
          { status: 503, headers: { 'Content-Type': 'text/html' } }
        );
      });
    })
  );
});
