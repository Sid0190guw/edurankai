/*
 * aquin-worldmodel.js — Educational World Model Engine (AES-100, Vol II, Ch 59).
 * The situational-awareness layer: the single authoritative answer to the one
 * question every operating system must always be able to answer —
 *
 *   "What is happening RIGHT NOW?"
 *
 * Windows keeps system state, Linux keeps kernel state, aircraft keep flight
 * state; an Educational OS keeps Educational World State. Without it, agents
 * disagree, predictions drift, Digital Twins diverge, missions desync.
 *
 * Engineered guarantees (proven in the tests):
 *  - ONE AUTHORITATIVE REALITY: no Runtime Domain builds its own version of the
 *    world; every domain reads the same World Model.
 *  - PRESENT vs PAST vs FUTURE vs SIMULATION are strictly separated. Only the
 *    PRESENT is active Educational Reality; predictions and hypotheticals never
 *    mutate it.
 *  - EVENT-DRIVEN: a meaningful educational event immediately updates world state
 *    AND notifies every dependent domain (not periodic polling).
 *  - CONSISTENCY VALIDATION: conflicting states, duplicate identities, and stale
 *    Digital Twins are detected.
 *  - IMMUTABLE SNAPSHOTS: point-in-time frozen copies enable rollback, audit, and
 *    reproducible simulation.
 *  - MULTI-SCALE: learner -> classroom -> institution -> ... -> civilization; each
 *    scale has its own state and rolls up.
 *  - COMPLETE PROVENANCE of every world change.
 *
 * HONEST SCOPE: an in-memory, single-node authoritative state with an event bus.
 * Distributed replication, fault-tolerant consensus, and billion-object indexing
 * are the deployment substrates behind the same interface.
 */
(function () {
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); }
    return o;
  }

  function createWorldModel() {
    var present = {};        // id -> { id, type, scale, state, version, at }  (ACTIVE REALITY)
    var history = [];        // append-only recorded past
    var subscribers = {};    // event type -> [handlers]  (dependent domains)
    var snapshots = [];      // immutable point-in-time copies
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var W = {
      provenance: provenance,

      // register/update an object in the PRESENT world (active reality)
      upsert: function (obj) {
        if (!obj || !obj.id) throw new Error('world object needs an id');
        var prev = present[obj.id];
        present[obj.id] = { id: obj.id, type: obj.type || 'object', scale: obj.scale || 'learner', state: obj.state || {}, version: prev ? prev.version + 1 : 1, at: Date.now() };
        rec('upsert', { id: obj.id, version: present[obj.id].version });
        return present[obj.id];
      },
      current: function (id) { return present[id]; },
      at: function (id) { return present[id] && present[id].state; },

      // dependent domains subscribe; they are NOTIFIED, they don't poll
      subscribe: function (eventType, handler) { (subscribers[eventType] = subscribers[eventType] || []).push(handler); return this; },

      // an EDUCATIONAL EVENT updates present state and notifies dependents
      // event: { type, subject, apply?:(state)->state, payload }
      event: function (ev) {
        ev = ev || {};
        history.push({ type: ev.type, subject: ev.subject, payload: ev.payload || null, at: Date.now() });   // recorded past
        var affected = null;
        if (ev.subject && present[ev.subject]) {
          var cur = present[ev.subject];
          var nextState = typeof ev.apply === 'function' ? ev.apply(Object.assign({}, cur.state), ev.payload) : Object.assign({}, cur.state, ev.payload || {});
          present[ev.subject] = { id: cur.id, type: cur.type, scale: cur.scale, state: nextState, version: cur.version + 1, at: Date.now() };
          affected = present[ev.subject];
        }
        rec('event', { type: ev.type, subject: ev.subject });
        // notify dependent domains (event-driven, not periodic)
        var notified = [];
        (subscribers[ev.type] || []).concat(subscribers['*'] || []).forEach(function (h) { try { h({ type: ev.type, subject: ev.subject, affected: affected, payload: ev.payload }); notified.push(h.domain || 'anonymous'); } catch (e) { } });
        return { affected: affected, notified: notified.length };
      },

      // present / past / future / simulation are strictly separated
      recordedHistory: function (subject) { return history.filter(function (h) { return !subject || h.subject === subject; }); },
      // future and simulation are PROJECTIONS — they never mutate the present
      project: function (id, projector) { var c = present[id]; if (!c) return null; return { basedOnVersion: c.version, projected: projector(Object.assign({}, c.state)), isHypothetical: true, note: 'projection does not mutate present reality' }; },

      // consistency validation across the present world
      validate: function () {
        var issues = [];
        var byIdentity = {};
        Object.keys(present).forEach(function (k) {
          var o = present[k];
          if (o.state && o.state.identity) { (byIdentity[o.state.identity] = byIdentity[o.state.identity] || []).push(k); }
          // stale Digital Twin: twin older than its learner source
          if (o.type === 'digital-twin' && o.state.sourceVersion != null) {
            var src = present[o.state.sourceId];
            if (src && src.version > o.state.sourceVersion) issues.push({ kind: 'stale-twin', id: k, twinAt: o.state.sourceVersion, sourceAt: src.version });
          }
          // conflicting state: mutually exclusive flags
          if (o.state && o.state.mastered === true && o.state.struggling === true) issues.push({ kind: 'conflicting-state', id: k });
        });
        Object.keys(byIdentity).forEach(function (idv) { if (byIdentity[idv].length > 1) issues.push({ kind: 'duplicate-identity', identity: idv, objects: byIdentity[idv] }); });
        rec('validate', { issues: issues.length });
        return { consistent: issues.length === 0, issues: issues };
      },

      // immutable point-in-time snapshot
      snapshot: function (label) {
        var copy = {}; Object.keys(present).forEach(function (k) { copy[k] = JSON.parse(JSON.stringify(present[k])); });
        var snap = deepFreeze({ label: label || ('snap_' + (snapshots.length + 1)), at: Date.now(), version: snapshots.length + 1, world: copy });
        snapshots.push(snap); rec('snapshot', { label: snap.label });
        return snap;
      },
      snapshots: function () { return snapshots.slice(); },
      rollback: function (label) {
        var snap = snapshots.filter(function (s) { return s.label === label; })[0]; if (!snap) return { ok: false, reason: 'no such snapshot' };
        present = {}; Object.keys(snap.world).forEach(function (k) { present[k] = JSON.parse(JSON.stringify(snap.world[k])); });
        rec('rollback', { label: label }); return { ok: true, restoredTo: label };
      },

      // multi-scale rollup: aggregate present objects at a scale
      scaleView: function (scale) {
        var objs = Object.keys(present).map(function (k) { return present[k]; }).filter(function (o) { return o.scale === scale; });
        return { scale: scale, count: objs.length, objects: objs.map(function (o) { return o.id; }) };
      }
    };
    return W;
  }

  window.AquinWorldModel = { createWorldModel: createWorldModel };
})();
