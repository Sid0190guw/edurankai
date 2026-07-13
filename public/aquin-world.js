/*
 * aquin-world.js — Educational World Runtime (AES-001, Ch 20).
 * Applications terminate; Educational Worlds persist. A World is persistent
 * Educational Reality that exists independently of any session, evolving only
 * through governed Educational Transactions that produce successive, immutable
 * World State Snapshots (so any historical World is reconstructable — replay,
 * audit, reproducibility). Worlds NEST (experiment < lab < course < institution
 * < ...) inheriting constitutional semantics while keeping local governance.
 *
 * Proven in tests: a World has a stable identity across evolution; each evolve()
 * appends a new immutable snapshot and the OLD snapshot stays reconstructable
 * (no destructive state); nested worlds inherit the Educational Genome; a past
 * World State is recoverable by Educational Chronology.
 *
 * Composes the Persistence layer (versioned snapshots). HONEST SCOPE: in-memory
 * persistent runtime; true always-on server persistence + federation implement
 * the same World Runtime contract later.
 */
(function () {
  function createWorldRuntime(cfg) {
    cfg = cfg || {};
    var persist = cfg.persistence;          // an AquinPersistence store (for versioned snapshots)
    var worlds = {};                        // worldId -> { id, genome, parent, children, governance }
    var seq = 0;
    function wid() { seq++; return 'world_' + seq.toString(36); }

    function commitState(worldId, state, meta) {
      // a World State Snapshot is an immutable, versioned Runtime Object
      if (persist) return persist.commit({ id: 'wstate_' + worldId, world: worldId, state: state, meta: meta || null }, { indexes: { type: 'world-state', world: worldId } });
      // fallback if no persistence store provided
      var w = worlds[worldId]; w._states = w._states || []; var v = w._states.length + 1; w._states.push({ version: v, tick: v, data: { state: state } }); return { id: 'wstate_' + worldId, version: v, tick: v };
    }

    var R = {
      // create a persistent Educational World
      createWorld: function (spec) {
        spec = spec || {};
        var id = spec.id || wid();
        var w = { id: id, genome: spec.genome || 'genome-v1', parent: spec.parent || null, children: [], governance: spec.governance || 'institutional', createdAt: Date.now() };
        worlds[id] = w;
        var c = commitState(id, spec.initialState || {}, { event: 'created' });
        w.version = c.version; w.tick = c.tick;
        return { id: id, genome: w.genome, parent: w.parent, version: c.version };
      },

      // Nested Educational Worlds inherit constitution/genome, keep local governance
      nest: function (parentId, childSpec) {
        if (!worlds[parentId]) throw { code: 'NO_PARENT', message: 'unknown parent world "' + parentId + '"' };
        childSpec = childSpec || {};
        var child = this.createWorld({ genome: childSpec.genome || worlds[parentId].genome, parent: parentId, governance: childSpec.governance || 'inherited', initialState: childSpec.initialState });
        worlds[parentId].children.push(child.id);
        return child;
      },

      // World State evolves ONLY through governed transactions -> new snapshot
      evolve: function (worldId, transaction) {
        var w = worlds[worldId]; if (!w) throw { code: 'NO_WORLD', message: 'unknown world "' + worldId + '"' };
        if (!transaction || !transaction.type) throw { code: 'BAD_TXN', message: 'evolution requires an Educational Transaction' };
        var prev = this.currentState(worldId) || {};
        var next = Object.assign({}, prev, transaction.apply || {});     // successor state
        var c = commitState(worldId, next, { event: 'evolve', txn: transaction.type });
        w.version = c.version; w.tick = c.tick;
        return { world: worldId, version: c.version, tick: c.tick };
      },

      currentState: function (worldId) {
        if (persist) { var o = persist.get('wstate_' + worldId); return o ? o.state : null; }
        var w = worlds[worldId]; if (!w || !w._states || !w._states.length) return null; return w._states[w._states.length - 1].data.state;
      },
      // historical reconstruction by Educational Chronology
      stateAt: function (worldId, tick) {
        if (persist) { var o = persist.versionAt('wstate_' + worldId, tick); return o ? o.state : null; }
        var w = worlds[worldId]; if (!w || !w._states) return null; var chosen = null; w._states.forEach(function (e) { if (e.tick <= tick) chosen = e; }); return chosen ? chosen.data.state : null;
      },
      history: function (worldId) { if (persist) return persist.history('wstate_' + worldId); var w = worlds[worldId]; return (w && w._states || []).map(function (e) { return { version: e.version, tick: e.tick }; }); },

      get: function (worldId) { return worlds[worldId]; },
      worlds: function () { return Object.keys(worlds); },
      health: function (worldId) { var w = worlds[worldId]; if (!w) return null; return { world: worldId, exists: true, version: w.version, children: w.children.length, genome: w.genome }; }
    };
    return R;
  }
  window.AquinWorld = { createWorldRuntime: createWorldRuntime };
})();
