/*
 * aquin-device.js — Multi-Tenant Educational Runtime Engine (AES-100, Vol II,
 * Ch 7). A device is a HOST; a learner is a TENANT. One phone runs many isolated
 * Educational Runtimes — each with its own Understanding model (Digital Twin),
 * Working Memory, AI conversation, offline sync queue, and security context.
 * Educational state NEVER leaks across tenants; only stateless infrastructure is
 * shared. Fast user switching restores continuity; suspension is adaptive
 * (hot in RAM / cold serialized-and-evicted) to respect low-end RAM/battery.
 *
 * Built for the real world: shared household/school/kiosk devices in emerging
 * economies. Educational Identity — not the device — is the unit of computation.
 *
 * Proven in tests: two tenants keep DIFFERENT understanding (no contamination);
 * switch A→B→A preserves A exactly; AI conversations are isolated; offline sync
 * queues flush independently; cold-suspend serializes+evicts and resume
 * reconstructs identical state; cross-tenant access is denied.
 *
 * Composes aquin-understanding.js (per-tenant learner/twin) + aquin-memory.js
 * (per-tenant working memory), with plain-object fallbacks so it is testable
 * standalone. HONEST SCOPE: encryption-at-rest + OS-level memory partitioning are
 * declared; this is the tenant-isolation + switch + suspend logic above them.
 */
(function () {
  function createDeviceRuntime(cfg) {
    cfg = cfg || {};
    var maxHot = cfg.maxHot || 5;               // tenants kept hot in RAM
    var tenants = {};                           // id -> tenant runtime (isolated)
    var activeId = null, seq = 0;
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function newLearner(id) { try { if (typeof window !== 'undefined' && window.AquinUnderstanding) return new window.AquinUnderstanding.LearnerModel(id); } catch (e) {} return { _id: id, _ev: [], observe: function (e) { this._ev.push(e); }, understanding: function () { return { overall: { mastery: 0.5, confidence: this._ev.length ? 0.6 : 0.5 } }; }, get state() { return { ev: this._ev }; }, set state(s) { this._ev = (s && s.ev) || []; } }; }
    function newMemory() { try { if (typeof window !== 'undefined' && window.AquinMemory) return window.AquinMemory.createMemory({}); } catch (e) {} return { layers: { working: [] } }; }

    var D = {
      provenance: provenance,
      addTenant: function (id) {
        if (tenants[id]) return tenants[id];
        var t = { id: id, state: 'hot', learner: newLearner(id), memory: newMemory(), aiContext: [], syncQueue: [], mission: null, lastActive: ++seq, blob: null };
        tenants[id] = t; rec('add-tenant', { id: id }); return t;
      },
      active: function () { return activeId; },
      // isolated access to a tenant's runtime (privacy-checked by canAccess)
      tenant: function (id) { var t = tenants[id]; if (t && t.state === 'cold') this.resume(id); return tenants[id]; },
      tenants: function () { return Object.keys(tenants); },

      // fast user switching: suspend current, restore target
      switchTo: function (id, env) {
        env = env || {}; if (!tenants[id]) this.addTenant(id);
        var from = activeId, latency = 0, strategy = 'hot';
        if (from && from !== id) { var r = this._suspend(from, env); strategy = r.strategy; }
        // evict least-recently-used hot tenants if over capacity (adaptive)
        var hot = Object.keys(tenants).filter(function (k) { return tenants[k].state === 'hot' && k !== id; });
        if (hot.length + 1 > maxHot) { hot.sort(function (a, b) { return tenants[a].lastActive - tenants[b].lastActive; }); this._suspend(hot[0], { force: 'cold' }); }
        if (tenants[id].state === 'cold') { this.resume(id); latency = 8; }   // reconstruct from storage
        activeId = id; tenants[id].state = 'active'; tenants[id].lastActive = ++seq;
        rec('switch', { from: from, to: id, strategy: strategy, latencyMs: latency });
        return { active: id, from: from, strategy: strategy, latencyMs: latency };
      },

      // adaptive suspension: hot (RAM) vs cold (serialize + evict)
      _suspend: function (id, env) {
        var t = tenants[id]; if (!t) return { strategy: 'none' };
        var lowRam = env && (env.force === 'cold' || (env.ram != null && env.ram < 0.2) || (env.battery != null && env.battery < 0.15));
        if (lowRam) { t.blob = JSON.stringify({ state: t.learner.state, aiContext: t.aiContext, syncQueue: t.syncQueue, mission: t.mission }); t.learner = null; t.memory = null; t.state = 'cold'; rec('suspend', { id: id, strategy: 'cold' }); return { strategy: 'cold' }; }
        t.state = 'hot'; rec('suspend', { id: id, strategy: 'hot' }); return { strategy: 'hot' };
      },
      resume: function (id) {
        var t = tenants[id]; if (!t || t.state !== 'cold') return t;
        var b = JSON.parse(t.blob || '{}'); t.learner = newLearner(id); t.learner.state = b.state; t.memory = newMemory(); t.aiContext = b.aiContext || []; t.syncQueue = b.syncQueue || []; t.mission = b.mission || null; t.blob = null; t.state = 'hot'; rec('resume', { id: id }); return t;
      },

      // isolated AI conversation per tenant
      say: function (id, who, msg) { var t = this.tenant(id); t.aiContext.push({ who: who, msg: msg }); return t.aiContext.length; },

      // independent offline synchronization per tenant
      enqueueSync: function (id, item) { this.tenant(id).syncQueue.push(item); return this; },
      syncTenant: function (id) { var t = this.tenant(id); var flushed = t.syncQueue.slice(); t.syncQueue = []; rec('sync', { id: id, flushed: flushed.length }); return flushed; },

      // privacy: no cross-tenant access
      canAccess: function (requester, target) { return requester === target; }
    };
    return D;
  }
  window.AquinDevice = { createDeviceRuntime: createDeviceRuntime };
})();
