/* EduRankAI offline work store + sync.
   Work is saved to IndexedDB instantly (works with no connection), kept locally
   so the user always sees it, and pushed to /api/offline/sync when back online so
   it shows up in the admin panel. Idempotent by clientId — re-syncing is safe.

   THE RULE THIS FILE IS BUILT AROUND, and it used to be broken:

       A QUEUED RECORD IS DELETED ONLY IF THE SERVER NAMED IT AS PERSISTED.

   The old flush() checked `d.ok` — a property describing the REQUEST — and then deleted the entire
   batch. The server, meanwhile, swallowed individual insert failures and returned ok:true anyway.
   Ten records sent with three failing meant seven stored and ten deleted, and the three were gone
   from the only two places they had ever existed.

   Now the server answers per record, by id, and this file deletes exactly the ids it was told about.
   Anything else stays in the queue:

       synced / duplicate   -> delete from the queue, mark the local copy synced
       retryable            -> stay queued, count an attempt, back off before the next try
       permanent_failure    -> stay queued, marked blocked, never auto-retried, visible in the UI
       no results at all    -> delete NOTHING (old server, truncated response, proxy error page)

   A blocked record is not a discarded one. It sits in the queue with a reason attached so somebody
   can look at it, which is the entire difference between a bug report and silent data loss. */
(function () {
  var DB = 'era_offline', QUEUE = 'queue', LOCAL = 'records';
  var MAX_ATTEMPTS = 10;   // mirrors MAX_ATTEMPTS in src/lib/offline/sync-protocol.ts

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

  // Same curve as nextAttemptDelayMs() on the server: 5s doubling to a 15 minute ceiling.
  function backoffMs(attempts) {
    var n = Math.max(0, attempts | 0);
    return Math.min(15 * 60000, 5000 * Math.pow(2, Math.min(n, 8)));
  }
  function dueNow(rec, now) {
    if (rec.blocked) return false;
    if (!rec.nextAttemptAt) return true;
    return new Date(rec.nextAttemptAt).getTime() <= now;
  }

  var api = {};

  // Save a unit of work. Returns the local clientId immediately.
  api.save = async function (kind, data) {
    var rec = { clientId: uuid(), kind: kind || 'work', data: data || {}, createdAt: new Date().toISOString(), synced: false };
    await put(LOCAL, rec);
    await put(QUEUE, Object.assign({}, rec, { attempts: 0, nextAttemptAt: null, blocked: false, lastError: null }));
    api.flush();
    return rec.clientId;
  };

  api.records = function () { return all(LOCAL).then(function (r) { return (r || []).sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); }); }); };
  api.pendingCount = function () { return all(QUEUE).then(function (r) { return (r || []).filter(function (x) { return !x.blocked; }).length; }); };

  /** Records the server could not store. Kept, never deleted, so they can be diagnosed. */
  api.failures = function () {
    return all(QUEUE).then(function (r) {
      return (r || []).filter(function (x) { return x.blocked; }).map(function (x) {
        return { clientId: x.clientId, kind: x.kind, createdAt: x.createdAt, attempts: x.attempts || 0, reason: x.lastError || 'unknown', data: x.data };
      });
    });
  };
  api.failureCount = function () { return api.failures().then(function (f) { return f.length; }); };

  /** Clear the blocked flag so a record is attempted again — e.g. after a server-side fix. */
  api.retryFailed = async function () {
    var q = await all(QUEUE);
    var n = 0;
    for (var i = 0; i < (q || []).length; i++) {
      if (!q[i].blocked) continue;
      q[i].blocked = false; q[i].attempts = 0; q[i].nextAttemptAt = null;
      await put(QUEUE, q[i]); n++;
    }
    if (n) api.flush();
    return n;
  };

  var flushing = false;
  api.flush = async function () {
    if (flushing || !navigator.onLine) return { sent: 0, synced: 0, kept: 0 };
    flushing = true;
    var summary = { sent: 0, synced: 0, kept: 0, blocked: 0 };
    try {
      var now = Date.now();
      var queued = (await all(QUEUE)) || [];
      var batch = queued.filter(function (r) { return dueNow(r, now); }).slice(0, 200);
      if (!batch.length) { flushing = false; return summary; }
      summary.sent = batch.length;

      var res = null;
      var transportError = null;
      try {
        res = await fetch('/api/offline/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ records: batch.map(function (r) { return { clientId: r.clientId, kind: r.kind, data: r.data, createdAt: r.createdAt }; }) })
        });
      } catch (e) {
        transportError = (e && e.message) || 'network error';
      }

      var body = null;
      if (res) { try { body = await res.json(); } catch (e) { body = null; } }

      // NO USABLE PER-RECORD ANSWER => DELETE NOTHING. This covers a network failure, a proxy HTML
      // error page, a 401 after the session expired, and an older server that still returns
      // { ok, synced }. In every one of those cases the correct action is to keep the work and try
      // again, and the old code's instinct — trust `ok` — is exactly what must not happen.
      var results = body && Array.isArray(body.results) ? body.results : null;
      if (!results) {
        var why = transportError ? transportError
          : (res && !res.ok) ? ('server returned ' + res.status)
          : 'server did not report per-record results';
        for (var k = 0; k < batch.length; k++) {
          var keep = batch[k];
          keep.attempts = (keep.attempts || 0) + 1;
          keep.lastError = why;
          keep.nextAttemptAt = new Date(Date.now() + backoffMs(keep.attempts)).toISOString();
          if (keep.attempts >= MAX_ATTEMPTS) { keep.blocked = true; summary.blocked++; }
          await put(QUEUE, keep);
        }
        summary.kept = batch.length;
        document.dispatchEvent(new CustomEvent('era-offline-sync-problem', { detail: { kept: batch.length, reason: why } }));
        flushing = false;
        return summary;
      }

      var byId = {};
      for (var j = 0; j < results.length; j++) {
        var rr = results[j];
        if (rr && typeof rr.clientId === 'string' && rr.clientId) byId[rr.clientId] = rr;
      }

      for (var i = 0; i < batch.length; i++) {
        var rec = batch[i];
        var out = byId[rec.clientId];

        // A record the server did not mention is a record we know nothing about. Keep it.
        if (!out) {
          rec.attempts = (rec.attempts || 0) + 1;
          rec.lastError = 'server did not report on this record';
          rec.nextAttemptAt = new Date(Date.now() + backoffMs(rec.attempts)).toISOString();
          if (rec.attempts >= MAX_ATTEMPTS) { rec.blocked = true; summary.blocked++; }
          await put(QUEUE, rec);
          summary.kept++;
          continue;
        }

        if (out.status === 'synced' || out.status === 'duplicate') {
          await del(QUEUE, rec.clientId);
          var lr = { clientId: rec.clientId, kind: rec.kind, data: rec.data, createdAt: rec.createdAt, synced: true };
          await put(LOCAL, lr);
          summary.synced++;
          continue;
        }

        rec.attempts = (rec.attempts || 0) + 1;
        rec.lastError = out.detail || out.status;
        if (out.status === 'permanent_failure') {
          // Never going to succeed as submitted. Stop retrying, keep it, make it visible.
          rec.blocked = true;
          rec.nextAttemptAt = null;
          summary.blocked++;
        } else {
          rec.nextAttemptAt = new Date(Date.now() + backoffMs(rec.attempts)).toISOString();
          if (rec.attempts >= MAX_ATTEMPTS) { rec.blocked = true; summary.blocked++; }
        }
        await put(QUEUE, rec);
        summary.kept++;
      }

      if (summary.synced) document.dispatchEvent(new CustomEvent('era-offline-synced', { detail: { count: summary.synced } }));
      if (summary.kept) document.dispatchEvent(new CustomEvent('era-offline-sync-problem', { detail: { kept: summary.kept, blocked: summary.blocked } }));
    } catch (e) {
      // Anything unexpected in the loop above leaves the queue untouched, which is the safe end of
      // the trade: a record that is retried twice costs a duplicate INSERT the server ignores; a
      // record deleted in error costs the work itself.
      try { console.error('[offline-sync] flush failed, queue left intact:', (e && e.message) || e); } catch (_) {}
    }
    flushing = false;
    return summary;
  };

  window.addEventListener('online', function () { api.flush(); });
  window.addEventListener('load', function () { setTimeout(api.flush, 1200); });
  // Retryable records carry a backoff, so a periodic tick is what actually re-sends them. Without
  // it a transient failure would sit in the queue until the next page load.
  setInterval(function () { api.flush(); }, 60000);

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
