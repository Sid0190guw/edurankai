/*
 * aquin-memory.js — Educational Memory Hierarchy (AES-001, Ch 11).
 * Memory is NOT storage — it is *activated* Educational Reality. This engine
 * models the constitutional distinction the whole chapter turns on:
 *
 *   Persistence preserves Educational Reality (indefinitely).
 *   Memory ACTIVATES a small, relevant, finite slice of it for cognition.
 *
 * Layers: sensory (transient) · working (finite, attention-governed) ·
 *         procedural / semantic / episodic / collective (consolidation targets).
 *
 * Key properties proven in the tests:
 *   - Working memory is FINITE regardless of hardware (attention eviction).
 *   - Activation is CONTEXTUAL (same object, different missions -> different attention).
 *   - ASSOCIATIVE activation surfaces graph-related objects (not statistical noise).
 *   - DECAY WITHOUT KNOWLEDGE LOSS: working memory clears at mission end, but the
 *     object remains in Persistence and can be reactivated.
 *   - Every activation is a governed Memory Activation Transaction (provenance).
 *
 * HONEST SCOPE: the embedded persistence store is a minimal immutable map so
 * Memory is testable now; the full Educational Persistence layer (Ch 6 —
 * versioned, indexed, federated, durable) is a separate future brick.
 */
(function () {
  function deepFreeze(o) { if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); } return o; }

  function createMemory(cfg) {
    cfg = cfg || {};
    var workingCapacity = cfg.workingCapacity || 5;        // finite regardless of hardware
    var associate = cfg.associate || function () { return []; }; // id -> related ids (e.g. concept graph)
    var seq = 0;

    var persistence = {};                                  // id -> frozen Runtime Object (Ch 6 stand-in)
    var working = {};                                      // id -> { obj, attention, activatedAt, associations }
    var sensory = [];                                      // transient buffer
    var semantic = {}, procedural = {}, episodic = {}, collective = {};
    var provenance = [];                                   // Memory Activation Transactions

    function id(k) { seq++; return (k || 'rto') + '_' + seq.toString(36); }
    function rec(op, detail) { provenance.push({ op: op, at: Date.now(), detail: detail || null }); }
    function evictIfNeeded() {
      var keys = Object.keys(working);
      while (keys.length > workingCapacity) {
        // decay: drop the LOWEST-attention object from working memory (it stays in persistence)
        var lowest = keys[0];
        keys.forEach(function (k) { if (working[k].attention < working[lowest].attention) lowest = k; });
        rec('decay-evict', { id: lowest, attention: working[lowest].attention });
        delete working[lowest];
        keys = Object.keys(working);
      }
    }

    var M = {
      layers: { get sensory() { return sensory.slice(); }, get working() { return Object.keys(working); }, get semantic() { return Object.keys(semantic); }, get procedural() { return Object.keys(procedural); }, get episodic() { return Object.keys(episodic); }, get collective() { return Object.keys(collective); } },
      provenance: provenance,

      // PERSISTENCE (Ch 6 stand-in): preserve an immutable Runtime Object
      persist: function (obj) { var oid = obj.id || id('rto'); var frozen = deepFreeze(Object.assign({ id: oid }, obj)); persistence[oid] = frozen; return oid; },
      persisted: function (oid) { return persistence[oid]; },

      // SENSORY: transient observation until significance is decided
      sense: function (observation) { sensory.push(deepFreeze(Object.assign({ t: Date.now() }, observation))); if (sensory.length > 32) sensory.shift(); return this; },

      // MEMORY ACTIVATION TRANSACTION: pull an object into Working Memory
      activate: function (oid, ctx) {
        ctx = ctx || {};
        if (!persistence[oid]) throw { code: 'NOT_PERSISTED', message: 'cannot activate "' + oid + '" — not in Educational Persistence' };
        var attention = typeof ctx.attention === 'number' ? ctx.attention : (ctx.priority || 1);
        // ASSOCIATIVE activation: surface graph-related objects that are persisted
        var assoc = (associate(oid, ctx) || []).filter(function (a) { return persistence[a]; });
        working[oid] = { obj: persistence[oid], attention: attention, activatedAt: Date.now(), mission: ctx.mission || null, associations: assoc };
        rec('activate', { id: oid, attention: attention, mission: ctx.mission || null, associations: assoc.length });
        // associations enter working memory at reduced attention (co-activation)
        assoc.forEach(function (a) { if (!working[a]) { working[a] = { obj: persistence[a], attention: attention * 0.5, activatedAt: Date.now(), mission: ctx.mission || null, associations: [] }; rec('co-activate', { id: a, via: oid }); } });
        evictIfNeeded();
        return working[oid] ? working[oid].obj : persistence[oid];
      },
      attend: function (oid, attention) { if (working[oid]) { working[oid].attention = attention; evictIfNeeded(); } return this; },
      inWorking: function (oid) { return !!working[oid]; },
      attentionOf: function (oid) { return working[oid] ? working[oid].attention : 0; },

      // CONSOLIDATION: promote a working result into a lasting layer
      consolidate: function (kind, obj) {
        var oid = this.persist(obj);                       // consolidated knowledge is persisted
        var target = kind === 'semantic' ? semantic : kind === 'procedural' ? procedural : kind === 'episodic' ? episodic : kind === 'collective' ? collective : null;
        if (!target) throw { code: 'BAD_LAYER', message: 'consolidation layer must be semantic|procedural|episodic|collective' };
        target[oid] = persistence[oid]; rec('consolidate', { id: oid, layer: kind }); return oid;
      },

      // DECAY WITHOUT KNOWLEDGE LOSS: clear working memory (mission end); persistence retained
      decay: function () { var n = Object.keys(working).length; working = {}; rec('decay-all', { cleared: n }); return n; },
      reactivate: function (oid, ctx) { return this.activate(oid, ctx); }
    };
    return M;
  }
  window.AquinMemory = { createMemory: createMemory };
})();
