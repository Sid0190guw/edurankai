/*
 * aquin-lifecycle.js — Runtime Lifecycle Engine (AES-100, Vol II, Ch 2).
 * Engineering spec turned into code: no Runtime Domain exists outside the
 * Runtime Lifecycle. Every domain moves through ONE canonical 16-state lifecycle
 * via constitutionally-defined events; illegal transitions are rejected by a
 * Transition Validator; a domain cannot reach Running until its dependencies are
 * Ready/Running; every transition emits an immutable provenance record.
 *
 * Canonical states:
 *   Registered -> Allocated -> Constructed -> Configured -> Initialized ->
 *   Verified -> Ready -> Running  (+ Paused/Suspended/Restored, Recovering,
 *   Stopping -> Stopped -> Archived -> Destroyed)
 *
 * Proven in tests: full boot to Running; illegal transition rejected;
 * dependency coordination (B blocked until A Running); failure path
 * (Running->Recovering->Running); shutdown path to Destroyed; provenance.
 */
(function () {
  var STATES = ['Registered', 'Allocated', 'Constructed', 'Configured', 'Initialized', 'Verified', 'Ready', 'Running', 'Paused', 'Suspended', 'Restored', 'Recovering', 'Stopping', 'Stopped', 'Archived', 'Destroyed'];
  // transition table (spec §8): state -> { event -> nextState }
  var T = {
    Registered:  { Allocate: 'Allocated' },
    Allocated:   { Construct: 'Constructed' },
    Constructed: { Configure: 'Configured' },
    Configured:  { Initialize: 'Initialized' },
    Initialized: { Verify: 'Verified' },
    Verified:    { Activate: 'Ready' },
    Ready:       { Run: 'Running' },
    Running:     { Pause: 'Paused', Suspend: 'Suspended', Fail: 'Recovering', Stop: 'Stopping' },
    Paused:      { Resume: 'Running' },
    Suspended:   { Restore: 'Restored' },
    Restored:    { Activate: 'Running' },
    Recovering:  { Verify: 'Running', Fail: 'Stopping' },     // recovery may succeed or terminate
    Stopping:    { Complete: 'Stopped' },
    Stopped:     { Archive: 'Archived', Run: 'Running' },     // restart possible from Stopped
    Archived:    { Destroy: 'Destroyed' }
  };
  // the canonical boot event sequence Registered -> Running
  var BOOT_SEQ = [['Registered', 'Allocate'], ['Allocated', 'Construct'], ['Constructed', 'Configure'], ['Configured', 'Initialize'], ['Initialized', 'Verify'], ['Verified', 'Activate'], ['Ready', 'Run']];
  var READY_SET = { Running: 1, Ready: 1 };

  function createLifecycleEngine() {
    var domains = {};      // id -> { id, state, deps, history }
    var tick = 0;

    function rec(d, prev, event, next, authority, note) {
      var r = Object.freeze({ domain: d.id, prev: prev, event: event, next: next, tick: ++tick, at: Date.now(), authority: authority || 'kernel', note: note || null, deps: d.deps.slice() });
      d.history.push(r); return r;
    }

    var E = {
      STATES: STATES,
      register: function (id, opts) {
        opts = opts || {};
        if (domains[id]) throw { code: 'DUPLICATE', message: 'domain "' + id + '" already registered' };
        domains[id] = { id: id, state: 'Registered', deps: opts.deps || [], history: [] };
        rec(domains[id], null, 'REGISTER', 'Registered', opts.authority);
        return this;
      },
      state: function (id) { return domains[id] && domains[id].state; },
      history: function (id) { return domains[id] ? domains[id].history.slice() : []; },

      // the only way to move a domain: a validated, dependency-checked transition
      transition: function (id, event, opts) {
        opts = opts || {}; var d = domains[id];
        if (!d) return { ok: false, reason: 'unknown domain "' + id + '"' };
        var next = T[d.state] && T[d.state][event];
        if (!next) return { ok: false, reason: 'illegal transition: ' + d.state + ' --' + event + '--> (rejected)' };
        // dependency coordination: cannot ENTER Running unless every dep is Ready/Running
        if (next === 'Running') {
          for (var i = 0; i < d.deps.length; i++) { var ds = this.state(d.deps[i]); if (!READY_SET[ds]) return { ok: false, reason: 'dependency "' + d.deps[i] + '" is ' + (ds || 'unknown') + ' (must be Ready/Running)' }; }
        }
        var prev = d.state; d.state = next; var r = rec(d, prev, event, next, opts.authority, opts.note);
        return { ok: true, from: prev, to: next, provenance: r };
      },

      // convenience: run the canonical boot sequence to Running
      boot: function (id, opts) {
        for (var i = 0; i < BOOT_SEQ.length; i++) { var r = this.transition(id, BOOT_SEQ[i][1], opts); if (!r.ok) return r; }
        return { ok: true, to: this.state(id) };
      },

      // if a dependency fails, dependents pause (policy hook)
      pauseDependentsOf: function (failedId) {
        var self = this, paused = [];
        Object.keys(domains).forEach(function (k) { if (domains[k].deps.indexOf(failedId) >= 0 && domains[k].state === 'Running') { self.transition(k, 'Pause', { note: 'dependency ' + failedId + ' failed' }); paused.push(k); } });
        return paused;
      },
      domains: function () { return Object.keys(domains); }
    };
    return E;
  }
  window.AquinLifecycle = { STATES: STATES, TRANSITIONS: T, createLifecycleEngine: createLifecycleEngine };
})();
