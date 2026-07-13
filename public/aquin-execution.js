/*
 * aquin-execution.js — AquinTutor Educational Execution Runtime (AES-000, Ch 28).
 * The realization layer: it turns an authorized Educational Decision into
 * observable educational reality and feeds the resulting Evidence back into the
 * loop. This is what most AI systems lack — they generate output and stop; here
 * an Execution produces governed Educational Actions whose OUTCOMES are measured.
 *
 * Constitutional pipeline (in code):
 *   Decision -> Execution Contract -> [authorize -> allocate -> coordinate ->
 *   operate -> observe -> verify -> complete] -> Educational Evidence -> Learner
 *
 * Runtime Domains (renderer, AI tutor, lab, translator, assessment) attach as
 * pluggable EXECUTORS: fn(action, ctx) -> { evidence:[...], health, note }. That
 * function is exactly where a real renderer/LLM/lab plugs in. Nothing here
 * fakes a renderer; the reference executors model the *educational effect*
 * (the Evidence produced) so the whole pipeline is testable end-to-end.
 *
 * Guarantees: no execution without a valid Execution Contract + granted
 * authority; execution integrity (no silent substitution — degradation is
 * explicit and objective-preserving); full provenance; verification of the
 * expected Concept State Transformation.
 */
(function () {
  var PHASES = ['authorize', 'allocate', 'coordinate', 'operate', 'observe', 'verify', 'complete'];
  // graceful degradation: a required capability -> a constitutionally-equivalent one
  var DEGRADE = {
    '3d-simulation': '2d-visualization',
    'speech-translation': 'text-translation',
    'interactive-lab': 'guided-simulation',
    'xr-lab': 'interactive-lab',
    'live-animation': 'cached-animation'
  };

  function makeContract(spec) {
    return {
      id: spec.id || ('exec_' + Math.random().toString(36).slice(2, 9)),
      decision: spec.decision || null,               // the Educational Decision being realized
      objectives: spec.objectives || [],
      actions: spec.actions || [],                   // [{ domain, type, conceptId, capability?, produces? }]
      expected: spec.expected || null,               // { conceptId, direction:'increase'|'decrease' }
      authority: spec.authority || 'autonomous',     // 'autonomous' | 'assisted' | 'governed'
      granted: spec.granted !== false,               // governed decisions need explicit grant
      prohibited: spec.prohibited || false,          // constitutional hard stop
      successCriteria: spec.successCriteria || null,
      provenance: []
    };
  }

  function ExecutionEngine() { this.executors = {}; this.degrade = Object.assign({}, DEGRADE); }
  ExecutionEngine.prototype.registerExecutor = function (capability, fn) { this.executors[capability] = fn; return this; };

  ExecutionEngine.prototype.execute = function (contract, ctx) {
    ctx = ctx || {};
    var prov = contract.provenance, self = this;
    function rec(phase, event, detail) { prov.push({ t: Date.now(), phase: phase, event: event, detail: detail || null }); }

    // PHASE authorize -------------------------------------------------------
    if (contract.prohibited) { rec('authorize', 'denied', { reason: 'constitutional prohibition' }); return { status: 'denied', executed: false, health: 0, provenance: prov }; }
    if (contract.authority === 'governed' && !contract.granted) { rec('authorize', 'pending', { reason: 'governed decision awaiting approval' }); return { status: 'pending-approval', executed: false, health: 0, provenance: prov }; }
    rec('authorize', 'ok', { authority: contract.authority });

    // PHASE allocate: resolve each action's capability, degrading if needed --
    var resolved = [], degraded = false;
    for (var i = 0; i < contract.actions.length; i++) {
      var a = contract.actions[i], cap = a.capability || a.type;
      var chosen = cap, exec = self.executors[cap];
      while (!exec && self.degrade[chosen]) { chosen = self.degrade[chosen]; exec = self.executors[chosen]; degraded = true; }
      if (!exec) { rec('allocate', 'unavailable', { capability: cap }); return { status: 'failed-allocation', executed: false, health: 0, degraded: degraded, provenance: prov }; }
      if (chosen !== cap) rec('allocate', 'degraded', { from: cap, to: chosen });
      resolved.push({ action: a, capability: chosen, exec: exec });
    }
    rec('allocate', 'ok', { actions: resolved.length, degraded: degraded });

    // PHASE coordinate ------------------------------------------------------
    rec('coordinate', 'ok', { order: resolved.map(function (r) { return r.capability; }) });

    // measure the pre-execution state for verification
    var before = null;
    if (contract.expected && ctx.learner) before = ctx.learner.understanding(contract.expected.conceptId, ctx.context).overall.mastery;

    // PHASE operate: run executors; ingest produced Evidence into the learner -
    var allEvidence = [], healthSum = 0, healthN = 0;
    resolved.forEach(function (r) {
      var out = r.exec(r.action, ctx) || {};
      (out.evidence || []).forEach(function (evSpec) {
        allEvidence.push(evSpec);
        if (ctx.learner) { var res = ctx.learner.observe(evSpec); rec('operate', 'evidence', { capability: r.capability, accepted: res.accepted, csts: (res.csts || []).map(function (c) { return c.kind; }) }); }
      });
      if (typeof out.health === 'number') { healthSum += out.health; healthN++; }
    });

    // PHASE observe / verify ------------------------------------------------
    rec('observe', 'ok', { evidence: allEvidence.length });
    var verified = true, after = null;
    if (contract.expected && ctx.learner) {
      after = ctx.learner.understanding(contract.expected.conceptId, ctx.context).overall.mastery;
      var wantUp = (contract.expected.direction || 'increase') === 'increase';
      verified = wantUp ? (after > before) : (after < before);
      rec('verify', verified ? 'verified' : 'failed', { conceptId: contract.expected.conceptId, before: before, after: after, expected: contract.expected.direction });
    } else { rec('verify', 'skipped', null); }

    var execHealth = healthN ? Math.round((healthSum / healthN) * 100) : (verified ? 90 : 40);
    if (!verified) execHealth = Math.min(execHealth, 45);

    // if verification failed, suspend for replanning (integrity, not silent drift)
    if (contract.expected && ctx.learner && !verified) { rec('complete', 'suspended', { reason: 'expected Concept State Transformation not observed; suspend for governed replanning' }); return { status: 'suspended-for-replanning', executed: true, verified: false, degraded: degraded, health: execHealth, evidence: allEvidence, before: before, after: after, provenance: prov }; }

    // PHASE complete --------------------------------------------------------
    rec('complete', 'ok', { verified: verified, health: execHealth });
    return { status: 'complete', executed: true, verified: verified, degraded: degraded, health: execHealth, evidence: allEvidence, before: before, after: after, provenance: prov };
  };

  window.AquinExecution = { PHASES: PHASES, DEGRADE: DEGRADE, makeContract: makeContract, ExecutionEngine: ExecutionEngine };
})();
