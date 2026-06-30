/* EduRankAI offline work store + sync.
   Work is saved to IndexedDB instantly (works with no connection), kept locally
   so the user always sees it, and pushed to /api/offline/sync when back online so
   it shows up in the admin panel. Idempotent by clientId — re-syncing is safe. */
(function () {
  var DB = 'era_offline', QUEUE = 'queue', LOCAL = 'records';

  function open() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'clientId' });
        if (!db.objectStoreNames.contains(LOCAL)) db.createObjectStore(LOCAL, { keyPath: 'clientId' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function op(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var s = db.transaction(store, mode).objectStore(store);
        var rq = fn(s);
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  var put = function (store, v) { return op(store, 'readwrite', function (s) { return s.put(v); }); };
  var all = function (store) { return op(store, 'readonly', function (s) { return s.getAll(); }); };
  var del = function (store, k) { return op(store, 'readwrite', function (s) { return s.delete(k); }).catch(function () {}); };
  function uuid() { try { return crypto.randomUUID(); } catch (_) { return Date.now() + '-' + Math.random().toString(16).slice(2); } }

  var api = {};

  // Save a unit of work. Returns the local clientId immediately.
  api.save = async function (kind, data) {
    var rec = { clientId: uuid(), kind: kind || 'work', data: data || {}, createdAt: new Date().toISOString(), synced: false };
    await put(LOCAL, rec);
    await put(QUEUE, rec);
    api.flush();
    return rec.clientId;
  };

  api.records = function () { return all(LOCAL).then(function (r) { return (r || []).sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); }); }); };
  api.pendingCount = function () { return all(QUEUE).then(function (r) { return (r || []).length; }); };

  var flushing = false;
  api.flush = async function () {
    if (flushing || !navigator.onLine) return;
    flushing = true;
    try {
      var q = await all(QUEUE);
      if (q && q.length) {
        var r = await fetch('/api/offline/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ records: q }) });
        if (r.ok) {
          var d = {}; try { d = await r.json(); } catch (_) {}
          if (d.ok) {
            for (var i = 0; i < q.length; i++) {
              await del(QUEUE, q[i].clientId);
              var lr = q[i]; lr.synced = true; await put(LOCAL, lr);
            }
            document.dispatchEvent(new CustomEvent('era-offline-synced', { detail: { count: q.length } }));
          }
        }
      }
    } catch (_) {}
    flushing = false;
  };

  window.addEventListener('online', function () { api.flush(); });
  window.addEventListener('load', function () { setTimeout(api.flush, 1200); });

  // Any <form data-offline="kind"> is captured here: saved offline + queued,
  // instead of doing a normal network submit. Great for fields out of signal.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.matches || !f.matches('form[data-offline]')) return;
    e.preventDefault();
    var obj = {}; new FormData(f).forEach(function (v, k) { obj[k] = v; });
    api.save(f.getAttribute('data-offline') || 'form', obj).then(function () {
      try { f.reset(); } catch (_) {}
      document.dispatchEvent(new CustomEvent('era-offline-saved', { detail: { kind: f.getAttribute('data-offline') } }));
    });
  });

  window.eraOffline = api;
})();
