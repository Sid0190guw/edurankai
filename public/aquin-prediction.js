/*
 * aquin-prediction.js — Educational Future Prediction & Preventive Intelligence
 * Engine (AES-100, Vol II, Ch 45). A good teacher anticipates. This engine
 * continuously estimates PLAUSIBLE future educational trajectories from the
 * learner's current state — to enable EARLY, preventive support.
 *
 * It never claims certainty. It produces MULTIPLE future scenarios (each with a
 * probability + explicit assumptions), identifies opportunities as actively as
 * risks, and yields preventive recommendations. It never modifies Educational
 * Reality: every projection runs on an ISOLATED clone of the learner model (the
 * real learner is provably untouched), and predictions are hypotheses that other
 * Runtime Domains (Intervention, Mentor) decide whether to act on.
 *
 * Composes the Learner Intelligence Core (current state + isolated projection).
 * HONEST SCOPE: scenario probabilities are heuristic (from current mastery/
 * confidence/trend); a real probabilistic/ML predictor plugs in behind the same
 * interface. Predictions are estimates, contestable, and explainable.
 */
(function () {
  function createPredictor(cfg) {
    cfg = cfg || {};
    function clone(learner) { var s = new learner.constructor(learner.learnerId + '#pred'); s.state = JSON.parse(JSON.stringify(learner.state)); s.prior = learner.prior; s.tau = learner.tau; s.mcThreshold = learner.mcThreshold; return s; }
    function project(learner, conceptId, ctx, pos, neg) {
      var s = clone(learner);                                   // isolation — real learner untouched
      for (var i = 0; i < pos; i++) s.observe({ conceptId: conceptId, context: ctx, provenance: { source: 'projection' }, obsConfidence: 0.85, quality: { conceptualRichness: 0.7, independence: 0.7, reproducibility: 0.7 }, targets: { conceptual: 1, procedural: 1, structural: 1 } });
      for (var j = 0; j < neg; j++) s.observe({ conceptId: conceptId, context: ctx, provenance: { source: 'projection' }, obsConfidence: 0.85, targets: { conceptual: -1 } });
      return +s.understanding(conceptId, ctx).overall.mastery.toFixed(3);
    }

    return {
      predict: function (learner, conceptId, ctx) {
        ctx = ctx || 'default';
        var u = learner.understanding(conceptId, ctx);
        var cur = u.overall.mastery;
        // three plausible trajectories on isolated clones
        var pA = project(learner, conceptId, ctx, 5, 0);   // high consistency
        var pB = project(learner, conceptId, ctx, 2, 0);   // moderate
        var pC = project(learner, conceptId, ctx, 0, 2);   // disengagement

        // heuristic probabilities skewed by current mastery + confidence (sum to 1)
        var wA = 0.34 + (cur - 0.5) * 0.4 + (u.overall.confidence - 0.5) * 0.2;
        var wC = 0.33 - (cur - 0.5) * 0.4;
        var wB = 1 - wA - wC; if (wB < 0.05) wB = 0.05;
        var tot = wA + wB + wC; wA /= tot; wB /= tot; wC /= tot;

        var scenarios = [
          { id: 'A', label: 'high study consistency', assumption: 'regular study + spaced practice + lab work', projectedMastery: pA, probability: +wA.toFixed(2), outcome: 'strong improvement' },
          { id: 'B', label: 'moderate consistency', assumption: 'occasional practice, current pace', projectedMastery: pB, probability: +wB.toFixed(2), outcome: 'stable progress' },
          { id: 'C', label: 'continued disengagement', assumption: 'little practice, gaps unaddressed', projectedMastery: pC, probability: +wC.toFixed(2), outcome: 'increasing concept gaps' }
        ];

        // opportunities (strengths) as actively as risks
        var opportunities = [], risks = [];
        if (u.dims.transfer.mean > 0.65 && u.dims.transfer.confidence > 0.4) opportunities.push('strong transfer ability — ready for applied/competition problems');
        if (u.dims.conceptual.mean > 0.7) opportunities.push('solid conceptual grasp — candidate for peer mentoring / advanced projects');
        if (cur < 0.4 && u.overall.confidence >= 0.3) risks.push('increasing conceptual gaps if prerequisites are not revisited');
        var topMc = Object.keys(u.misconceptions).some(function (k) { return u.misconceptions[k].belief >= 0.5; });
        if (topMc) risks.push('an active misconception is likely to recur without targeted reconstruction');

        var recommendations = [];
        if (wC >= wA) recommendations.push('begin revision earlier', 'review prerequisite concepts', 'reduce cognitive load');
        else recommendations.push('maintain the current routine', 'add applied/lab practice');
        if (topMc) recommendations.push('schedule a reconstruction of the misconception');

        return {
          conceptId: conceptId, current: { mastery: cur, confidence: u.overall.confidence },
          scenarios: scenarios, opportunities: opportunities, risks: risks, recommendations: recommendations,
          certainty: 'estimate',   // never certain
          explain: {
            what: 'plausible future mastery of ' + conceptId,
            why: 'projected from current understanding + isolated trajectory simulation',
            evidence: 'current mastery ' + cur + ', confidence ' + u.overall.confidence,
            assumptions: 'each scenario states its own effort/consistency assumption',
            whatWouldChange: 'more practice raises scenario A; unaddressed gaps raise scenario C'
          }
        };
      }
    };
  }
  window.AquinPrediction = { createPredictor: createPredictor };
})();
