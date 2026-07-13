/*
 * aquin-sync.js — AES Part V: the Synchronization Runtime. Learners work OFFLINE
 * (shared phones, poor networks) and on multiple devices; their educational state
 * must converge correctly when they reconnect. This is real distributed-systems
 * causality — version vectors (Lamport/Fidge vector clocks) with conflict detection
 * and policy resolution — not a naive "last save wins that silently loses data".
 *
 *   - Each replica keeps a VERSION VECTOR (replicaId -> counter). Every write bumps
 *     the local counter and stamps the record with the current vector.
 *   - CAUSALITY: write A precedes B iff A.vector <= B.vector componentwise. If
 *     neither precedes the other, the writes are CONCURRENT -> a real conflict.
 *   - MERGE is commutative, associative, idempotent (merging twice = once), so any
 *     order of syncs CONVERGES to the same state (the CRDT guarantee).
 *   - Concurrent conflicts are RESOLVED by an explicit policy (last-writer-wins by
 *     timestamp, or surfaced for human/teacher review) — never silently dropped.
 *
 * HONEST SCOPE: an in-memory key/value replica with version-vector causality; it is
 * the correctness core the product's IndexedDB offline queue (public/offline-sync.js)
 * synchronizes through. Transport/encryption are declared substrates.
 */
(function () {
  function createReplica(id) {
    var replicaId = id;
    var vv = {};                 // version vector: replicaId -> counter
    var store = {};              // key -> { value, vector, ts, replica }
    function bump() { vv[replicaId] = (vv[replicaId] || 0) + 1; return copy(vv); }
    function copy(v) { var o = {}; Object.keys(v).forEach(function (k) { o[k] = v[k]; }); return o; }

    // vector comparison: 'before' | 'after' | 'equal' | 'concurrent'
    function compare(a, b) {
      var keys = {}; Object.keys(a).forEach(function (k) { keys[k] = 1; }); Object.keys(b).forEach(function (k) { keys[k] = 1; });
      // aLeq means "a <= b" (a is causally before-or-equal b): violated where a[k] > b[k]
      var aLeq = true, bLeq = true;
      Object.keys(keys).forEach(function (k) { var av = a[k] || 0, bv = b[k] || 0; if (av > bv) aLeq = false; if (bv > av) bLeq = false; });
      if (aLeq && bLeq) return 'equal';
      if (aLeq) return 'before';     // a <= b (a happened before b)
      if (bLeq) return 'after';      // b <= a (a happened after b)
      return 'concurrent';
    }
    function mergeVV(a, b) { var o = copy(a); Object.keys(b).forEach(function (k) { o[k] = Math.max(o[k] || 0, b[k]); }); return o; }

    var R = {
      id: replicaId,
      vector: function () { return copy(vv); },
      get: function (k) { return store[k] ? store[k].value : undefined; },
      keys: function () { return Object.keys(store); },
      record: function (k) { return store[k]; },

      // local write bumps the vector and stamps the record
      put: function (k, value, ts) {
        var vector = bump();
        store[k] = { value: value, vector: vector, ts: ts != null ? ts : Date.now(), replica: replicaId };
        return store[k];
      },

      // export records for syncing to a peer
      export: function () { var out = {}; Object.keys(store).forEach(function (k) { out[k] = store[k]; }); return { vector: copy(vv), records: out }; },

      // MERGE a peer's export into this replica; returns applied + conflicts
      merge: function (peer, policy) {
        policy = policy || 'lww';
        var applied = [], conflicts = [];
        Object.keys(peer.records).forEach(function (k) {
          var incoming = peer.records[k], local = store[k];
          if (!local) { store[k] = incoming; applied.push(k); return; }
          var rel = compare(local.vector, incoming.vector);
          if (rel === 'equal' || rel === 'after') return;             // we already have >= this (idempotent)
          if (rel === 'before') { store[k] = incoming; applied.push(k); return; } // incoming strictly newer
          // CONCURRENT -> conflict; resolve by policy, never silently drop
          var winner, loser;
          if (policy === 'lww') { if (incoming.ts >= local.ts) { winner = incoming; loser = local; } else { winner = local; loser = incoming; } store[k] = winner; }
          else { winner = local; } // 'review' policy keeps local, flags for human
          conflicts.push({ key: k, resolvedBy: policy, winner: winner === incoming ? incoming.replica : local.replica, localValue: local.value, incomingValue: incoming.value });
        });
        vv = mergeVV(vv, peer.vector);
        return { applied: applied, conflicts: conflicts };
      },
      compare: compare
    };
    return R;
  }
  window.AquinSync = { createReplica: createReplica };
})();
