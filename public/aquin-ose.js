/*
 * aquin-ose.js — AES-100 Vol III Part II Ch 5: Object Storage Engine (OSE). An
 * S3-style object store for large-scale immutable data (media, datasets, AI model
 * artifacts). Built to complement — not duplicate — the Ch 2 UFS engine, so this
 * implements the cores UFS does NOT: object LIFECYCLE POLICIES, WORM immutability,
 * and multipart assembly. Real, tested cores:
 *
 *  - CONTENT-ADDRESSABLE, VERSIONED objects (each PUT is a new version).
 *  - LIFECYCLE POLICIES: transition an object to a colder tier after N days, and
 *    EXPIRE (delete) it after M days — evaluated by applyLifecycle().
 *  - WORM IMMUTABILITY (write-once-read-many): an object under a retention lock
 *    cannot be overwritten or deleted until its retention period elapses
 *    (compliance / tamper-evidence).
 *  - MULTIPART upload: parts assembled in order into one object.
 *
 * HONEST SCOPE: object semantics (versioning, lifecycle, WORM, multipart) are real
 * and tested in-memory over a clock; erasure-coded durability, multi-cloud
 * federation, and on-disk storage are declared substrates (erasure math itself is
 * in aquin-vsm.js). (spec's exabyte-scale C++ → the object core.)
 */
(function () {
  var DAY = 86400000;
  function hash(s) { s = String(s); var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }

  function createObjectStore(cfg) {
    cfg = cfg || {};
    var now = cfg.now || function () { return Date.now(); };
    var objects = {};   // key -> [ {versionId, hash, content, tier, at, retentionUntil} ]
    var lifecycle = []; // [{ prefix, transitionAfterDays, expireAfterDays }]
    var multipart = {}; // uploadId -> { key, parts:{} }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: now(), detail: d || null }); }
    function latest(key) { var v = objects[key]; return v && v.length ? v[v.length - 1] : null; }

    var O = {
      provenance: provenance,
      put: function (key, content, opts) {
        opts = opts || {};
        var cur = latest(key);
        // WORM: an object still under retention cannot be overwritten
        if (cur && cur.retentionUntil && now() < cur.retentionUntil) { rec('put-denied', { key: key, reason: 'worm' }); return { ok: false, reason: 'object "' + key + '" is under WORM retention until ' + new Date(cur.retentionUntil).toISOString() + ' — cannot overwrite' }; }
        var v = { versionId: 'v' + ((objects[key] || []).length + 1), hash: hash(content), content: content, tier: 'hot', at: now(), retentionUntil: opts.retentionDays ? now() + opts.retentionDays * DAY : null, tags: opts.tags || [] };
        (objects[key] = objects[key] || []).push(v);
        rec('put', { key: key, version: v.versionId, worm: !!v.retentionUntil });
        return { ok: true, key: key, versionId: v.versionId, hash: v.hash, immutable: !!v.retentionUntil };
      },
      get: function (key, versionId) { var arr = objects[key]; if (!arr) return null; var v = versionId ? arr.filter(function (x) { return x.versionId === versionId; })[0] : arr[arr.length - 1]; return v ? v.content : null; },
      versions: function (key) { return (objects[key] || []).map(function (v) { return { versionId: v.versionId, tier: v.tier, at: v.at }; }); },

      // WORM-aware delete
      delete: function (key) { var cur = latest(key); if (cur && cur.retentionUntil && now() < cur.retentionUntil) return { ok: false, reason: 'under WORM retention — cannot delete' }; delete objects[key]; rec('delete', { key: key }); return { ok: true }; },

      // lifecycle policies
      setLifecycle: function (prefix, policy) { lifecycle.push({ prefix: prefix, transitionAfterDays: policy.transitionAfterDays, expireAfterDays: policy.expireAfterDays }); return this; },
      applyLifecycle: function () {
        var transitioned = [], expired = [];
        Object.keys(objects).forEach(function (key) {
          var pol = lifecycle.filter(function (l) { return key.indexOf(l.prefix) === 0; })[0]; if (!pol) return;
          var v = latest(key); var ageDays = (now() - v.at) / DAY;
          if (pol.expireAfterDays != null && ageDays >= pol.expireAfterDays) {
            if (v.retentionUntil && now() < v.retentionUntil) return;   // WORM protects from lifecycle expiry too
            delete objects[key]; expired.push(key); return;
          }
          if (pol.transitionAfterDays != null && ageDays >= pol.transitionAfterDays && v.tier !== 'cold') { v.tier = 'cold'; transitioned.push(key); }
        });
        rec('lifecycle', { transitioned: transitioned.length, expired: expired.length });
        return { transitioned: transitioned, expired: expired };
      },

      // multipart upload
      initiateMultipart: function (key) { var id = 'up_' + Object.keys(multipart).length; multipart[id] = { key: key, parts: {} }; return id; },
      uploadPart: function (uploadId, partNum, data) { if (multipart[uploadId]) multipart[uploadId].parts[partNum] = data; return this; },
      completeMultipart: function (uploadId, opts) { var u = multipart[uploadId]; if (!u) return { ok: false }; var assembled = Object.keys(u.parts).map(Number).sort(function (a, b) { return a - b; }).map(function (n) { return u.parts[n]; }).join(''); delete multipart[uploadId]; return this.put(u.key, assembled, opts); },
      tierOf: function (key) { var v = latest(key); return v ? v.tier : null; }
    };
    return O;
  }
  window.AquinOSE = { createObjectStore: createObjectStore };
})();
