/*
 * aquin-dfs.js — AES-100 Vol III Part II Ch 4: Distributed Filesystem Runtime
 * (DFR). Turns thousands of storage nodes across regions into ONE global namespace
 * where the user never knows (or needs to know) where data physically lives. Real,
 * tested cores:
 *
 *  - LOCATION TRANSPARENCY: an application uses a global path; the runtime resolves
 *    it to replica locations — the app never addresses a physical server.
 *  - GEO-REPLICATION by policy: an object is placed on N replicas spread across
 *    distinct regions (disaster tolerance, regional performance).
 *  - TUNABLE CONSISTENCY: a STRONG read requires a quorum of the object's replicas
 *    reachable (so you read a majority-acknowledged value); an EVENTUAL read returns
 *    from the nearest healthy replica (low latency, possibly stale).
 *  - FAILOVER: a replica outage transparently redirects reads to another healthy
 *    replica; strong reads are refused (not faked) if a quorum can't be reached.
 *
 * Composes the consensus quorum idea (Ch 42) for the strong-read rule. HONEST SCOPE:
 * the namespace resolution, placement, consistency, and failover logic is real and
 * tested over an in-memory node model; real network transport, on-disk storage, and
 * cryptographic replication are declared substrates. (~7.1M-LOC C++ → the core.)
 */
(function () {
  function hash(s) { s = String(s); var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }

  function createGlobalFS(cfg) {
    cfg = cfg || {};
    var nodes = {};   // id -> { region, up, store:{ path -> {version, checksum, content} } }
    (cfg.nodes || []).forEach(function (n) { nodes[n.id] = { id: n.id, region: n.region || 'default', up: true, store: {} }; });
    var objects = {}; // path -> { globalId, replicas:[nodeIds], version }
    var seq = 0, provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }
    function upNodeIds() { return Object.keys(nodes).filter(function (id) { return nodes[id].up; }); }

    var G = {
      provenance: provenance,
      setNodeUp: function (id, up) { if (nodes[id]) nodes[id].up = up; rec('node-status', { id: id, up: up }); return this; },
      regions: function () { var r = {}; Object.keys(nodes).forEach(function (id) { r[nodes[id].region] = 1; }); return Object.keys(r); },

      // WRITE: place N replicas across DISTINCT regions where possible
      put: function (path, content, opts) {
        opts = opts || {}; var R = opts.replicas || 3;
        var up = upNodeIds();
        // prefer spreading across regions: pick one per region first, then fill
        var byRegion = {}; up.forEach(function (id) { (byRegion[nodes[id].region] = byRegion[nodes[id].region] || []).push(id); });
        var chosen = [], regionsUsed = {};
        Object.keys(byRegion).forEach(function (rg) { if (chosen.length < R) { chosen.push(byRegion[rg][0]); regionsUsed[rg] = 1; } });
        up.forEach(function (id) { if (chosen.length < R && chosen.indexOf(id) < 0) chosen.push(id); });
        if (!chosen.length) return { ok: false, reason: 'no available nodes' };
        var o = objects[path] || (objects[path] = { globalId: 'g_' + (++seq).toString(36), replicas: [], version: 0 });
        o.version++; o.replicas = chosen; var ck = hash(content);
        chosen.forEach(function (id) { nodes[id].store[path] = { version: o.version, checksum: ck, content: content }; });
        rec('put', { path: path, replicas: chosen, regions: Object.keys(regionsUsed) });
        return { ok: true, globalId: o.globalId, version: o.version, replicas: chosen, regions: Object.keys(regionsUsed) };
      },

      // RESOLVE: global path -> replica locations (location transparent)
      resolve: function (path) { var o = objects[path]; if (!o) return null; return { globalId: o.globalId, replicas: o.replicas.slice(), primary: o.replicas[0], version: o.version }; },

      // READ with tunable consistency + transparent failover
      read: function (path, opts) {
        opts = opts || {}; var o = objects[path]; if (!o) return { ok: false, reason: 'not found' };
        var consistency = opts.consistency || 'eventual';
        var liveReplicas = o.replicas.filter(function (id) { return nodes[id].up; });
        var quorum = Math.floor(o.replicas.length / 2) + 1;
        if (consistency === 'strong') {
          if (liveReplicas.length < quorum) { rec('read-refused', { path: path, reason: 'no quorum' }); return { ok: false, reason: 'strong read needs a quorum of replicas (' + liveReplicas.length + '/' + quorum + ' live) — refusing rather than returning a possibly-stale value' }; }
          var rec1 = nodes[liveReplicas[0]].store[path];
          rec('read', { path: path, consistency: 'strong', from: liveReplicas[0] });
          return { ok: true, content: rec1.content, version: rec1.version, servedBy: liveReplicas[0], consistency: 'strong' };
        }
        // eventual: prefer a replica in the caller's region (lowest latency), else any live
        if (!liveReplicas.length) return { ok: false, reason: 'all replicas unavailable' };
        var pref = opts.region ? liveReplicas.filter(function (id) { return nodes[id].region === opts.region; }) : [];
        var from = (pref[0] || liveReplicas[0]);
        var r = nodes[from].store[path];
        rec('read', { path: path, consistency: 'eventual', from: from });
        return { ok: true, content: r.content, version: r.version, servedBy: from, region: nodes[from].region, consistency: 'eventual', failoverUsed: !nodes[o.replicas[0]].up };
      },

      // integrity check across replicas
      verify: function (path) { var o = objects[path]; if (!o) return { ok: false }; var bad = o.replicas.filter(function (id) { var r = nodes[id].store[path]; return nodes[id].up && r && hash(r.content) !== r.checksum; }); return { ok: bad.length === 0, corruptedReplicas: bad }; }
    };
    return G;
  }
  window.AquinDFS = { createGlobalFS: createGlobalFS, hash: hash };
})();
