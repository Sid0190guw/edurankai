/*
 * aquin-object-runtime.js — AES Part V: the Object Runtime. Everything the kernel
 * produces is an immutable, versioned, provenance-bearing Runtime Object. This
 * runtime is their registry: it stores objects immutably, maintains VERSION CHAINS
 * (a new version supersedes the old, both kept), enforces REFERENCE INTEGRITY (an
 * object may not reference one that doesn't exist), and RETIRES superseded objects
 * without ever deleting them (audit/provenance is永 permanent). No invented CS —
 * this is a persistent immutable object store with version lineage.
 *
 *   register(obj)                -> freezes + stores; rejects dangling references
 *   supersede(oldId, newObj)     -> version chain; current() resolves to newest
 *   current(id) / history(id)    -> latest live version / full lineage (incl retired)
 *   refs / integrity             -> every `refs:[ids]` must resolve
 *
 * HONEST SCOPE: in-memory immutable registry with version lineage; durable/
 * distributed persistence is a substrate behind the same register/current interface.
 */
(function () {
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); } return o; }

  function createObjectRuntime() {
    var objects = {};     // id -> { obj, version, supersedes, retired, at }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function integrity(obj) {
      var refs = obj.refs || [];
      var dangling = refs.filter(function (r) { return !objects[r] || objects[r].retired; });
      return dangling;
    }

    var R = {
      provenance: provenance,
      register: function (obj) {
        if (!obj || obj.id == null) throw new Error('Object Runtime: object needs an id');
        if (objects[obj.id]) return { ok: false, reason: 'id already exists — use supersede() to version' };
        var dangling = integrity(obj);
        if (dangling.length) { rec('reject', { id: obj.id, dangling: dangling }); return { ok: false, reason: 'reference integrity: unknown/retired refs ' + JSON.stringify(dangling) }; }
        objects[obj.id] = { obj: deepFreeze(Object.assign({}, obj)), version: 1, supersedes: null, retired: false, at: Date.now() };
        rec('register', { id: obj.id });
        return { ok: true, id: obj.id, version: 1 };
      },
      // create a NEW version that supersedes an existing object (old one retired, kept)
      supersede: function (oldId, newObj) {
        var old = objects[oldId]; if (!old) return { ok: false, reason: 'no such object to supersede' };
        var dangling = integrity(newObj); if (dangling.length) return { ok: false, reason: 'reference integrity: ' + JSON.stringify(dangling) };
        var nid = newObj.id || (oldId + '_v' + (old.version + 1));
        old.retired = true;                                        // retired, NOT deleted (audit permanent)
        objects[nid] = { obj: deepFreeze(Object.assign({}, newObj, { id: nid })), version: old.version + 1, supersedes: oldId, retired: false, at: Date.now() };
        rec('supersede', { from: oldId, to: nid, version: old.version + 1 });
        return { ok: true, id: nid, version: old.version + 1 };
      },
      get: function (id) { return objects[id] ? objects[id].obj : null; },
      current: function (id) {
        // follow the supersede chain forward from id to the newest live version
        var cur = id, guard = 0;
        while (guard++ < 1000) { var next = Object.keys(objects).filter(function (k) { return objects[k].supersedes === cur; })[0]; if (!next) break; cur = next; }
        return objects[cur] && !objects[cur].retired ? objects[cur].obj : (objects[cur] ? objects[cur].obj : null);
      },
      history: function (id) {
        // walk back the supersedes chain from the newest reachable version
        var newest = id; var g = 0; while (g++ < 1000) { var n = Object.keys(objects).filter(function (k) { return objects[k].supersedes === newest; })[0]; if (!n) break; newest = n; }
        var chain = [], cur = newest, h = 0;
        while (cur && h++ < 1000) { var e = objects[cur]; if (!e) break; chain.unshift({ id: cur, version: e.version, retired: e.retired }); cur = e.supersedes; }
        return chain;
      },
      retiredCount: function () { return Object.keys(objects).filter(function (k) { return objects[k].retired; }).length; },
      count: function () { return Object.keys(objects).length; }
    };
    return R;
  }
  window.AquinObjectRuntime = { createObjectRuntime: createObjectRuntime };
})();
