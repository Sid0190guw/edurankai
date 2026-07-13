/*
 * aquin-simulation.js — Educational Simulation Engine (AES-001, Ch 13).
 * "What happens if I do this?" — evaluate alternative Educational Futures on
 * ISOLATED copies of Educational Reality before any real Educational Decision is
 * executed. The constitutional guarantee: active reality is never modified by a
 * simulation.
 *
 * Core capabilities proven in the tests:
 *   - Isolated simulation: a candidate action is applied to a SNAPSHOT clone of
 *     the learner; the real learner model is provably unchanged.
 *   - Parallel Educational Futures: many candidate decisions simulated in
 *     parallel, each in its own world, then ranked by predicted Concept State
 *     Transformation.
 *   - Simulation Verification: an outcome is accepted only if plausible
 *     (bounded, correct-signed), never merely because it "ran".
 *   - Deterministic + full provenance.
 *
 * Composes the Learner Intelligence Core (the world being simulated is a learner
 * model). HONEST SCOPE: physically-accurate scientific simulation (CFD/FEA),
 * institutional and infrastructure simulation, and recursive self-simulation are
 * named categories in the spec; this brick implements the LEARNER-simulation
 * category (Concept State Transformation) which the Cognitive Engine needs now.
 */
(function () {
  // effect model: what evidence a given educational action tends to produce.
  var EFFECTS = {
    reinforce:              { targets: { conceptual: 1, procedural: 1 }, obs: 0.85, steps: 2 },
    advance:                { targets: {},                               obs: 0,    steps: 1 }, // already mastered -> no learning effect
    assess:                 { targets: { diagnostic: 1 },               obs: 0.7,  steps: 1 },
    reconstruct:            { targets: { conceptual: 1, structural: 1 }, obs: 0.9,  steps: 2, resolvesMisconception: true },
    'revise-prerequisite':  { targets: { structural: 1 },               obs: 0.8,  steps: 2 }
  };

  function createSimulator(cfg) {
    cfg = cfg || {};
    var provenance = [];
    function rec(op, detail) { provenance.push({ op: op, at: Date.now(), detail: detail || null }); }

    // build an ISOLATED sandbox learner from a real learner (no shared state)
    function snapshot(realLearner) {
      var sim = new realLearner.constructor(realLearner.learnerId + '#sim');
      sim.state = JSON.parse(JSON.stringify(realLearner.state));   // deep, detached
      sim.prior = realLearner.prior; sim.tau = realLearner.tau; sim.mcThreshold = realLearner.mcThreshold;
      return sim;
    }

    var S = {
      provenance: provenance,

      // simulate ONE action on an isolated world; returns the predicted future
      simulate: function (realLearner, action, conceptId, ctx) {
        ctx = ctx || {};
        var eff = EFFECTS[action] || { targets: {}, obs: 0, steps: 1 };
        var sim = snapshot(realLearner);                            // isolation
        var before = sim.understanding(conceptId, ctx.context).overall.mastery;
        var mcBefore = topMc(sim.understanding(conceptId, ctx.context));
        for (var i = 0; i < eff.steps; i++) {
          if (Object.keys(eff.targets).length || eff.resolvesMisconception) {
            var ev = { conceptId: conceptId, context: ctx.context, provenance: { source: 'simulation' }, obsConfidence: eff.obs, quality: { conceptualRichness: 0.75, independence: 0.7, reproducibility: 0.7 }, targets: eff.targets };
            if (eff.resolvesMisconception && ctx.misconceptionId) ev.misconceptionTargets = (function () { var o = {}; o[ctx.misconceptionId] = -1; return o; })();
            sim.observe(ev);
          }
        }
        var after = sim.understanding(conceptId, ctx.context).overall.mastery;
        var delta = +(after - before).toFixed(4);
        var plausible = delta <= 0.6 && delta >= -0.05 && after <= 1 && after >= 0;   // simulation verification
        rec('simulate', { action: action, before: before, after: after, delta: delta, plausible: plausible });
        return { action: action, before: before, after: after, delta: delta, mcBefore: mcBefore, plausible: plausible };
      },

      // Parallel Educational Futures: simulate every candidate, rank, pick best.
      // Real learner is NEVER modified (each candidate uses its own snapshot).
      parallelFutures: function (realLearner, candidates, conceptId, ctx) {
        var futures = candidates.map(function (a) { return S.simulate(realLearner, a, conceptId, ctx); })
          .filter(function (f) { return f.plausible; })
          .sort(function (a, b) { return b.delta - a.delta; });
        var best = futures[0] || null;
        rec('parallel-futures', { candidates: candidates.length, plausible: futures.length, best: best && best.action });
        return { futures: futures, best: best };
      }
    };
    function topMc(u) { var b = 0; Object.keys(u.misconceptions || {}).forEach(function (k) { if (u.misconceptions[k].belief > b) b = u.misconceptions[k].belief; }); return b; }
    return S;
  }
  window.AquinSimulation = { EFFECTS: EFFECTS, createSimulator: createSimulator };
})();
