/* offline-package.js — AquinTutor Offline Runtime client (Prompt 6). Dependency-free.
   Stores a compiled Offline Learning Package in IndexedDB (pre-rendered units), serves lessons
   with NO network, records progress locally while offline, and on reconnect enqueues the changed
   objects for the sync engine (Prompt 7). Lean for low-end Android. */
(function () {
  var DB = 'aquin-offline', V = 1;
  function open() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, V);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('units')) d.createObjectStore('units', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('prog')) d.createObjectStore('prog', { keyPath: 'koId' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(store, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  function all(store) { return tx(store, 'readonly', function (s) { return s.getAll(); }).then(function (r) { return r || []; }); }

  var API = {
    /** Compile + cache a package for the given kernel unit ids. */
    download: function (unitIds, tier) {
      return fetch('/api/aquintutor/offline/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unitIds: unitIds, tier: tier || 'lite' }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || 'compile failed');
          var m = j.manifest;
          return open().then(function (d) {
            return new Promise(function (res, rej) {
              var t = d.transaction(['units', 'prog', 'meta'], 'readwrite');
              var us = t.objectStore('units');
              m.units.forEach(function (u) { us.put(u); });
              (m.progress || []).forEach(function (p) { t.objectStore('prog').put({ koId: p.koId, completed: p.completed, dirty: false, at: m.createdAt }); });
              t.objectStore('meta').put({ k: 'last', tier: m.tier, unitCount: m.unitCount, bytes: m.totalBytes, dropped: m.droppedUnitIds, at: m.createdAt });
              t.oncomplete = function () { res(m); };
              t.onerror = function () { rej(t.error); };
            });
          });
        });
    },
    /** Cached units (offline). */
    listUnits: function () { return all('units'); },
    getUnit: function (id) { return tx('units', 'readonly', function (s) { return s.get(id); }); },
    /** Record completion locally — works with no network; marked dirty for sync. */
    recordProgress: function (koId, completed) {
      return tx('prog', 'readwrite', function (s) { s.put({ koId: koId, completed: completed !== false, dirty: true, at: new Date().toISOString() }); });
    },
    pendingChanges: function () { return all('prog').then(function (rows) { return rows.filter(function (p) { return p.dirty; }); }); },
    /** Reconnect: push changed objects to the sync queue (Prompt 7), then clear local dirty flags. */
    syncNow: function () {
      return API.pendingChanges().then(function (rows) {
        if (!rows.length) return { enqueued: 0 };
        var changes = rows.map(function (p) { return { objectId: p.koId, kind: 'progress', at: p.at }; });
        return fetch('/api/aquintutor/offline/sync-enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes: changes }) })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.ok) { return tx('prog', 'readwrite', function (s) { rows.forEach(function (p) { p.dirty = false; s.put(p); }); }).then(function () { return j; }); }
            return j;
          });
      });
    },
    meta: function () { return tx('meta', 'readonly', function (s) { return s.get('last'); }); },
    init: function () {
      if (navigator.onLine) API.syncNow().catch(function () {});
      window.addEventListener('online', function () { API.syncNow().catch(function () {}); });
      if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/aquin-offline-sw.js', { scope: '/aquintutor/offline' }).catch(function () {}); } catch (e) {} }
    },
  };
  window.AquinOffline = API;
  if (document.readyState !== 'loading') API.init(); else document.addEventListener('DOMContentLoaded', API.init);
})();
