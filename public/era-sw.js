/* EduRankAI service worker.
   Fixes the "stale design / unstyled page" bug and makes all pages work offline.
   Strategy:
     - /api/*                         -> network only (never cached; must be live)
     - navigations (HTML pages)       -> NETWORK-FIRST: always fresh online (so the
                                         HTML references current asset hashes and
                                         never renders unstyled after a deploy);
                                         falls back to the cached shell offline.
                                         Covers the whole site incl. /admin, /portal.
     - immutable hashed assets        -> cache-first (/_astro/, /era/, fonts, images)
     - other css/js                   -> stale-while-revalidate (fast + self-healing)
   VERSION is bumped on every meaningful change; activate purges ALL older era-
   caches so a bad/stale cache can never survive a deploy. */
const VERSION = 'era-v3-2026-07-06';
const STATIC_CACHE = 'era-static-' + VERSION;
const PAGE_CACHE = 'era-pages-' + VERSION;

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== STATIC_CACHE && k !== PAGE_CACHE) return caches.delete(k); // purge every old cache
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// let the page ask the SW to take over immediately after an update
self.addEventListener('message', function (e) { if (e.data === 'skipWaiting') self.skipWaiting(); });

function offlineHtml() {
  return new Response(
    '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">' +
    '<title>Offline</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 24px;background:#0b0d17;color:#e8ecf4;">' +
    '<h1 style="font-weight:600;">You are offline</h1><p style="color:#8ea0be;">This page will load when you reconnect.</p>' +
    '<button onclick="location.reload()" style="margin-top:16px;background:#c2410c;color:#fff;border:none;border-radius:10px;padding:11px 22px;font-size:15px;">Try again</button></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  var path = url.pathname;

  // APIs are always live — never intercept.
  if (path.indexOf('/api/') === 0) return;

  var accept = req.headers.get('accept') || '';
  var isNav = req.mode === 'navigate' || accept.indexOf('text/html') !== -1;

  if (isNav) {
    // NETWORK-FIRST: fresh HTML online (correct asset hashes), cached shell offline.
    e.respondWith(
      fetch(req).then(function (resp) {
        if (resp && resp.ok && resp.type === 'basic') {
          var copy = resp.clone();
          caches.open(PAGE_CACHE).then(function (c) { c.put(req, copy); });
        }
        return resp;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('/').then(function (h) { return h || offlineHtml(); }); });
      })
    );
    return;
  }

  var immutable = path.indexOf('/_astro/') === 0 || path.indexOf('/era/') === 0 ||
                  /\.(woff2?|ttf|otf|png|jpg|jpeg|gif|webp|ico|svg)$/i.test(path);

  if (immutable) {
    // Cache-first: hashed/versioned assets don't change under the same URL.
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (resp) {
          if (resp && resp.ok) { var copy = resp.clone(); caches.open(STATIC_CACHE).then(function (c) { c.put(req, copy); }); }
          return resp;
        });
      })
    );
    return;
  }

  // Everything else (loose css/js) — stale-while-revalidate: instant from cache,
  // refreshed in the background so it can never get permanently stuck stale.
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (resp) {
        if (resp && resp.ok && resp.type === 'basic') { var copy = resp.clone(); caches.open(STATIC_CACHE).then(function (c) { c.put(req, copy); }); }
        return resp;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
