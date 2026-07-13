/*
 * aquin-scheduler.js — Runtime Scheduler Engine (AES-100, Vol II, Ch 3).
 * The execution heartbeat. Unlike a CPU scheduler, it allocates EDUCATIONAL
 * opportunity: work is submitted as Runtime Work Units (RWUs) with a priority
 * VECTOR (educational importance + learner impact + deadline urgency + governance
 * + starvation compensation), sorted into specialized queues, dispatched only
 * when required resources are available, with preemption for urgent learner work
 * and starvation compensation so nothing is postponed indefinitely. Deterministic
 * (a logical clock is passed in), fully provenance-logged.
 *
 * RWU lifecycle: Created → Queued → Running → Completed
 *                (Running → Preempted → Queued;  Running → Failed → Retry → Queued)
 *
 * Proven in tests: priority ordering (immediate before background), deadline
 * urgency, starvation compensation (score rises with wait), resource-aware
 * deferral, preemption of a running low-priority RWU by an urgent one, and the
 * RWU state machine + provenance.
 */
(function () {
  // specialized queues with base educational importance + latency target (ms)
  var QUEUES = {
    immediate:     { base: 100, latency: 50 },
    interactive:   { base: 80,  latency: 150 },
    mission:       { base: 60,  latency: 500 },
    simulation:    { base: 50,  latency: 2000 },
    synchronization:{ base: 40, latency: 5000 },
    background:    { base: 20,  latency: 60000 },
    research:      { base: 10,  latency: 600000 }
  };

  function createScheduler(cfg) {
    cfg = cfg || {};
    var capacity = cfg.resources || { cpu: 4, gpu: 1, memory: 8, ai: 4 };
    var allocated = {}; Object.keys(capacity).forEach(function (k) { allocated[k] = 0; });
    var units = {};          // id -> RWU
    var provenance = [];
    var seq = 0;

    function fits(rwu) { var r = rwu.resources || {}; for (var k in r) { if ((allocated[k] || 0) + r[k] > (capacity[k] || 0)) return false; } return true; }
    function alloc(rwu, sign) { var r = rwu.resources || {}; for (var k in r) allocated[k] = (allocated[k] || 0) + sign * r[k]; }
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // priority VECTOR → scalar execution score (deterministic in `now`)
    function score(rwu, now) {
      var q = QUEUES[rwu.queue] || QUEUES.mission;
      var eduImportance = rwu.educationalImportance != null ? rwu.educationalImportance : q.base;
      var learnerImpact = rwu.learnerImpact || 0;
      var wait = Math.max(0, now - rwu.submittedAt);
      var deadlineUrgency = rwu.deadline != null ? Math.max(0, 120 - Math.max(0, (rwu.deadline - now)) / 20) : 0;
      var governance = rwu.governanceCriticality || 0;
      var starvation = Math.min(300, wait / 40);           // grows with wait — anti-starvation
      var depPressure = rwu.dependencyPressure || 0;
      return +(eduImportance + learnerImpact + 0.6 * deadlineUrgency + governance + starvation + depPressure).toFixed(2);
    }

    var S = {
      QUEUES: QUEUES, provenance: provenance,
      capacity: function () { return { capacity: capacity, allocated: Object.assign({}, allocated) }; },
      scoreOf: function (id, now) { return score(units[id], now); },

      submit: function (rwu) {
        var id = rwu.id || ('rwu_' + (++seq).toString(36));
        var u = Object.assign({ id: id, queue: rwu.queue || 'mission', state: 'Queued', submittedAt: rwu.submittedAt != null ? rwu.submittedAt : Date.now(), resources: rwu.resources || {}, retries: 0, retryPolicy: rwu.retryPolicy || { max: 2 } }, rwu);
        u.id = id; u.state = 'Queued'; units[id] = u; rec('submit', { id: id, queue: u.queue }); return id;
      },

      // dispatch the highest-score Ready RWU whose resources fit; preempt if needed
      next: function (now) {
        now = now != null ? now : Date.now();
        var queued = Object.keys(units).map(function (k) { return units[k]; }).filter(function (u) { return u.state === 'Queued'; });
        if (!queued.length) return null;
        queued.sort(function (a, b) { var s = score(b, now) - score(a, now); return s !== 0 ? s : (a.submittedAt - b.submittedAt); });
        for (var i = 0; i < queued.length; i++) {
          var cand = queued[i];
          if (fits(cand)) return this._run(cand, now);
          // preemption: free room by preempting lower-score Running RWUs
          if (this._preemptFor(cand, now)) return this._run(cand, now);
        }
        return null;   // all blocked on resources
      },
      _run: function (u, now) { u.state = 'Running'; u.startedAt = now; alloc(u, +1); rec('dispatch', { id: u.id, queue: u.queue, score: score(u, now) }); return u; },
      _preemptFor: function (cand, now) {
        var running = Object.keys(units).map(function (k) { return units[k]; }).filter(function (u) { return u.state === 'Running' && score(u, now) < score(cand, now); }).sort(function (a, b) { return score(a, now) - score(b, now); });
        for (var i = 0; i < running.length && !fits(cand); i++) { var v = running[i]; v.state = 'Queued'; v.preempted = (v.preempted || 0) + 1; alloc(v, -1); rec('preempt', { id: v.id, by: cand.id }); }
        return fits(cand);
      },

      complete: function (id) { var u = units[id]; if (u && u.state === 'Running') { u.state = 'Completed'; alloc(u, -1); rec('complete', { id: id }); } return this; },
      fail: function (id) {
        var u = units[id]; if (!u || u.state !== 'Running') return this; alloc(u, -1);
        if (u.retries < (u.retryPolicy.max || 0)) { u.retries++; u.state = 'Queued'; rec('retry', { id: id, attempt: u.retries }); }
        else { u.state = 'Failed'; rec('fail', { id: id }); }
        return this;
      },
      state: function (id) { return units[id] && units[id].state; },
      stats: function () { var s = { Queued: 0, Running: 0, Completed: 0, Failed: 0 }; Object.keys(units).forEach(function (k) { s[units[k].state] = (s[units[k].state] || 0) + 1; }); return s; }
    };
    return S;
  }
  window.AquinScheduler = { QUEUES: QUEUES, createScheduler: createScheduler };
})();
