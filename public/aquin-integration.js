/*
 * aquin-integration.js — AES-100 Vol III Ch 50: Kernel Unified Runtime Integration
 * & System Synthesis (KURISE). The capstone: independently-engineered kernel
 * subsystems must boot as ONE operating system. This engine synthesizes them — a
 * dependency DAG, a deterministic boot order (Kahn topological sort), lifecycle
 * contracts every subsystem honours (initialize → validate → activate → shutdown),
 * validation that HALTS the boot if a subsystem fails, and reverse-order shutdown.
 * No invented CS — this is dependency-ordered init (like systemd/init) + a service
 * lifecycle state machine.
 *
 * Proven in the tests:
 *  - DEPENDENCY DAG → a boot order where every subsystem starts AFTER its deps.
 *  - CYCLE DETECTION: a dependency cycle is refused (a kernel cannot boot a cycle).
 *  - LIFECYCLE: each subsystem passes initialize → validate → activate.
 *  - VALIDATION HALTS BOOT: if a subsystem fails validation, the boot stops and its
 *    dependents never start (no half-initialized kernel).
 *  - SHUTDOWN is the exact reverse of the boot order.
 *  - SERVICE REGISTRY + health rollup: one runtime directory of every subsystem.
 *
 * HONEST SCOPE: the orchestration (ordering, lifecycle, halting, registry) is real
 * and tested; the actual subsystem code, hardware abstraction, and firmware boot are
 * the declared substrates this conductor sequences. (~2.42M-LOC C++ → the core.)
 */
(function () {
  function createIntegration() {
    var services = {};   // id -> { id, deps, state, health, handlers }
    var bootedOrder = [];
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function register(id, spec) {
      spec = spec || {};
      services[id] = { id: id, deps: (spec.deps || []).slice(), state: 'created', health: 'unknown', handlers: spec.handlers || {} };
      return this;
    }

    // Kahn topological sort over the dependency DAG (deps must start first)
    function bootOrder() {
      var ids = Object.keys(services), indeg = {}, adj = {};
      ids.forEach(function (n) { indeg[n] = 0; adj[n] = []; });
      ids.forEach(function (n) { services[n].deps.forEach(function (d) { if (adj[d]) { adj[d].push(n); indeg[n]++; } else { /* dep on an unregistered service */ indeg[n] = indeg[n]; } }); });
      var q = ids.filter(function (n) { return indeg[n] === 0; }).sort(); var order = [];
      while (q.length) { var n = q.shift(); order.push(n); adj[n].sort().forEach(function (m) { if (--indeg[m] === 0) { q.push(m); q.sort(); } }); }
      if (order.length !== ids.length) return { ok: false, cycle: ids.filter(function (n) { return order.indexOf(n) < 0; }) };
      return { ok: true, order: order };
    }

    // lifecycle contract: initialize -> validate -> activate
    function bootService(s) {
      s.state = 'initializing';
      try { if (s.handlers.initialize) s.handlers.initialize(); } catch (e) { s.state = 'failed'; return { ok: false, stage: 'initialize', reason: String(e && e.message || e) }; }
      s.state = 'validating';
      var valid = s.handlers.validate ? s.handlers.validate() : true;
      if (!valid) { s.state = 'invalid'; return { ok: false, stage: 'validate', reason: 'validation failed' }; }
      s.state = 'active'; s.health = 'healthy';
      try { if (s.handlers.activate) s.handlers.activate(); } catch (e2) { s.state = 'failed'; return { ok: false, stage: 'activate', reason: String(e2 && e2.message || e2) }; }
      return { ok: true };
    }

    function boot() {
      var ord = bootOrder();
      if (!ord.ok) { rec('boot-halt', { reason: 'cycle', cycle: ord.cycle }); return { ok: false, reason: 'dependency cycle — cannot boot', cycle: ord.cycle }; }
      bootedOrder = [];
      for (var i = 0; i < ord.order.length; i++) {
        var s = services[ord.order[i]];
        var res = bootService(s);
        rec('boot-service', { id: s.id, ok: res.ok, stage: res.stage });
        if (!res.ok) {
          var notStarted = ord.order.slice(i + 1);
          rec('boot-halt', { at: s.id, stage: res.stage });
          return { ok: false, haltedAt: s.id, stage: res.stage, reason: res.reason, booted: bootedOrder.slice(), notStarted: notStarted };
        }
        bootedOrder.push(s.id);
      }
      rec('boot-complete', { count: bootedOrder.length });
      return { ok: true, order: bootedOrder.slice(), state: 'kernel-ready' };
    }

    // shutdown in EXACT reverse of boot order
    function shutdown() {
      var order = bootedOrder.slice().reverse();
      order.forEach(function (id) { var s = services[id]; try { if (s.handlers.shutdown) s.handlers.shutdown(); } catch (e) { } s.state = 'terminated'; s.health = 'down'; });
      rec('shutdown', { order: order });
      return { ok: true, shutdownOrder: order };
    }

    return {
      provenance: provenance, register: register, bootOrder: bootOrder, boot: boot, shutdown: shutdown,
      registry: function () { return Object.keys(services).map(function (id) { return { id: id, state: services[id].state, health: services[id].health, deps: services[id].deps }; }); },
      health: function () { var ids = Object.keys(services); var up = ids.filter(function (id) { return services[id].health === 'healthy'; }); return { services: ids.length, healthy: up.length, kernelReady: up.length === ids.length }; }
    };
  }
  window.AquinIntegration = { createIntegration: createIntegration };
})();
