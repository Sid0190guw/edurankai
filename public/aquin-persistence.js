/*
 * aquin-persistence.js — Educational Persistence (AES-001, Ch 6).
 * Persistence is not "a database" — it is the constitutional preservation of
 * Educational Reality: immutable, VERSIONED Runtime Objects (successor lineage,
 * never destructive updates), constitutional indexes that optimize educational
 * MEANING (not storage), temporal reconstruction of any past state, and
 * per-version integrity. Logical Educational Storage is separated from any
 * physical store.
 *
 * Proven in tests: a new version supersedes the old but the OLD version is still
 * retrievable (historical reality never lost); constitutional indexes discover
 * objects by identity/concept/mission/type; versionAt() reconstructs a past
 * state by Educational Chronology; returned objects are frozen (tamper-evident).
 *
 * HONEST SCOPE: an in-memory logical store — the real durable/federated/replicated
 * physical substrates (Postgres/IndexedDB/object storage) implement this same
 * contract later; nothing here is faked as durable.
 */
(function () {
  function fnv(str) { var h = 2166136261 >>> 0; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return 'fnv1a-' + h.toString(16); }
  function freeze(o) { if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { freeze(o[k]); }); Object.freeze(o); } return o; }

  function createStore() {
    var objects = {};          // id -> [ {version, data, tick, checksum, supersedes} ]
    var indexes = {};          // indexName -> { key -> Set(ids) }
    var tick = 0, seq = 0;

    function addIndex(name, key, id) { (indexes[name] = indexes[name] || {}); (indexes[name][key] = indexes[name][key] || {})[id] = true; }

    var S = {
      // Persistence Transaction: commit an immutable, versioned Runtime Object
      commit: function (obj, opts) {
        opts = opts || {};
        var oid = obj.id || ('rto_' + (++seq).toString(36));
        var prior = objects[oid];
        var version = prior ? prior[prior.length - 1].version + 1 : 1;
        var data = freeze(JSON.parse(JSON.stringify(Object.assign({ id: oid }, obj))));
        var t = ++tick;
        var entry = freeze({ version: version, data: data, tick: t, checksum: fnv(JSON.stringify(data)), supersedes: prior ? prior[prior.length - 1].version : null });
        (objects[oid] = objects[oid] || []).push(entry);
        addIndex('identity', oid, oid);
        // constitutional indexes optimize educational MEANING (declared by caller)
        var ix = opts.indexes || {};
        Object.keys(ix).forEach(function (name) { addIndex(name, ix[name], oid); });
        return { id: oid, version: version, tick: t, checksum: entry.checksum };
      },
      // latest constitutionally-valid version
      get: function (id) { var v = objects[id]; return v ? v[v.length - 1].data : null; },
      history: function (id) { return (objects[id] || []).map(function (e) { return { version: e.version, tick: e.tick, checksum: e.checksum }; }); },
      // temporal reconstruction: the version valid at a given Educational Chronology tick
      versionAt: function (id, atTick) { var v = objects[id]; if (!v) return null; var chosen = null; v.forEach(function (e) { if (e.tick <= atTick) chosen = e; }); return chosen ? chosen.data : null; },
      versionN: function (id, n) { var v = objects[id]; if (!v) return null; for (var i = 0; i < v.length; i++) if (v[i].version === n) return v[i].data; return null; },
      // constitutional-index discovery
      query: function (indexName, key) { var m = indexes[indexName] && indexes[indexName][key]; return m ? Object.keys(m) : []; },
      // integrity verification (recompute + compare)
      integrity: function (id) { var v = objects[id]; if (!v) return { ok: false, reason: 'not found' }; var e = v[v.length - 1]; var ok = fnv(JSON.stringify(e.data)) === e.checksum; return { ok: ok, checksum: e.checksum }; },
      snapshot: function () { return { objects: Object.keys(objects).length, versions: Object.keys(objects).reduce(function (a, k) { return a + objects[k].length; }, 0), tick: tick }; }
    };
    return S;
  }
  window.AquinPersistence = { createStore: createStore };
})();
