/*
 * aquin-vsm.js — AES-100 Vol III Part II Ch 3: Virtual Storage Manager (VSM).
 * Virtualizes physical media into pools and tiers beneath the filesystems. Real,
 * tested, named-algorithm cores:
 *
 *  - MULTI-TIER STORAGE with automatic TIERING: hot (SSD) / warm / cold (archival);
 *    frequently-accessed volumes are promoted to hot, rarely-accessed ones demoted
 *    to cold — data placement follows access, not manual config.
 *  - THIN PROVISIONING: a volume advertises a large LOGICAL size but only consumes
 *    PHYSICAL capacity as it's written; the pool refuses a write that would exceed
 *    real physical capacity (no silent overcommit failure).
 *  - ERASURE CODING (RAID-5 XOR parity): k data shards + 1 parity; any ONE lost
 *    shard is reconstructed EXACTLY as parity ⊕ (the surviving shards). Real
 *    durability math you can verify.
 *
 * HONEST SCOPE: the tiering, thin-provisioning accounting, and XOR erasure math are
 * real and tested; NVMe/SSD/HDD drivers, Reed-Solomon(k,m) codes, and hardware
 * offload are declared substrates. (~M-LOC C++ → the storage core.)
 */
(function () {
  function createStorageManager() {
    var pools = {};      // id -> { capacity, tier, usedPhysical }
    var vols = {};       // id -> { pool, logical, physical, accesses, tier }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var V = {
      provenance: provenance,
      addPool: function (id, spec) { pools[id] = { id: id, capacity: spec.capacity, tier: spec.tier || 'warm', usedPhysical: 0 }; return this; },

      // thin-provisioned volume: big logical, zero physical until written
      createVolume: function (id, spec) { if (!pools[spec.pool]) return { ok: false, reason: 'no such pool' }; vols[id] = { id: id, pool: spec.pool, logical: spec.logical, physical: 0, accesses: 0, tier: pools[spec.pool].tier }; return { ok: true, volume: id }; },

      // write consumes physical; refused if it would exceed the pool's real capacity
      write: function (id, bytes) {
        var v = vols[id]; if (!v) return { ok: false, reason: 'no such volume' };
        if (v.physical + bytes > v.logical) return { ok: false, reason: 'exceeds volume logical size' };
        var p = pools[v.pool];
        if (p.usedPhysical + bytes > p.capacity) { rec('write-denied', { vol: id, reason: 'pool-full' }); return { ok: false, reason: 'pool "' + p.id + '" out of PHYSICAL capacity (' + (p.usedPhysical + bytes) + ' > ' + p.capacity + ')' }; }
        v.physical += bytes; p.usedPhysical += bytes; rec('write', { vol: id, bytes: bytes });
        return { ok: true, physical: v.physical, poolUsed: p.usedPhysical + '/' + p.capacity };
      },
      access: function (id) { if (vols[id]) vols[id].accesses++; return this; },

      // TIERING: promote hot / demote cold by access frequency
      retier: function (opts) {
        opts = opts || {}; var hotAbove = opts.hotAbove != null ? opts.hotAbove : 5, coldBelow = opts.coldBelow != null ? opts.coldBelow : 1;
        var moves = [];
        Object.keys(vols).forEach(function (id) { var v = vols[id]; var from = v.tier; if (v.accesses >= hotAbove) v.tier = 'hot'; else if (v.accesses <= coldBelow) v.tier = 'cold'; else v.tier = 'warm'; if (v.tier !== from) moves.push({ vol: id, from: from, to: v.tier, accesses: v.accesses }); });
        rec('retier', { moves: moves.length });
        return moves;
      },

      // ERASURE CODING (RAID-5 XOR): k data shards -> 1 parity shard
      erasureEncode: function (shards) {
        var len = shards[0].length, parity = new Array(len).fill(0);
        shards.forEach(function (s) { for (var i = 0; i < len; i++) parity[i] ^= s[i]; });
        return parity;
      },
      // reconstruct a single lost shard: missing = parity XOR (surviving shards)
      erasureReconstruct: function (shards, parity, missingIndex) {
        var len = parity.length, out = parity.slice();
        shards.forEach(function (s, idx) { if (idx !== missingIndex && s) for (var i = 0; i < len; i++) out[i] ^= s[i]; });
        return out;
      },

      poolUsage: function (id) { var p = pools[id]; return p ? { tier: p.tier, used: p.usedPhysical + '/' + p.capacity } : null; },
      volume: function (id) { return vols[id]; }
    };
    return V;
  }
  window.AquinVSM = { createStorageManager: createStorageManager };
})();
