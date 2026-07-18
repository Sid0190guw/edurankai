/* aquin-offline-sw.js — narrow-scope service worker for the AquinTutor offline viewer (Prompt 6).
   Scoped to /aquintutor/offline ONLY, so it never disturbs the existing site service workers.
   Caches the viewer shell + client so the offline lesson viewer loads with no network; lesson
   CONTENT lives in IndexedDB (offline-package.js). */
var CACHE = 'aquin-offline-v1';
var SHELL = ['/aquintutor/offline', '/offline-package.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // never intercept API calls
  if (url.pathname.indexOf('/api/') === 0) return;
  if (e.request.mode === 'navigate' || url.pathname === '/aquintutor/offline' || url.pathname === '/offline-package.js') {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        var net = fetch(e.request).then(function (res) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); return res; }).catch(function () { return hit; });
        return hit || net;   // cache-first offline, refresh when online
      })
    );
  }
});
