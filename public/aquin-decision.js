/*
 * aquin-decision.js — AES-000 Ch 27: "What is Educational Decision Making?" as
 * CODE. A decision is a choice among options under uncertainty. This is real
 * decision theory (von Neumann-Morgenstern expected utility), specialised to
 * EDUCATIONAL value and gated by wisdom + ethics — no invented CS:
 *
 *   - EXPECTED EDUCATIONAL VALUE: EEV(option) = Σ P(outcome)·value(outcome).
 *     Each option is a lottery over educational outcomes with probabilities that
 *     must (approximately) sum to 1.
 *   - RISK SENSITIVITY: a risk-averse learner/decision penalises variance
 *     (mean-variance: score = EEV − λ·Var); a risk-neutral one maximises EEV.
 *   - PERMITTED-ONLY: an option the Constitution/Ethics forbids is never chosen,
 *     whatever its expected value.
 *   - WISDOM GATE: the top option is passed through Ch 31 Wisdom — if the choice is
 *     uncertain + high-stakes + irreversible, the engine WAITS or defers to a human
 *     rather than acting on a thin expected-value edge.
 *
 * This is the "Decision" node of the master invariant (Objective → DECISION →
 * Execution). HONEST SCOPE: decision theory over supplied outcome distributions;
 * where the probabilities come from is Prediction (Ch 26) / BKT / IRT, and what is
 * permissible is the Constitution (Ch 58) / Ethics (Ch 62) — this engine composes
 * them, it does not fabricate the inputs.
 */
(function () {
  function createDecider(cfg) {
    cfg = cfg || {};
    var lambda = cfg.riskAversion != null ? cfg.riskAversion : 0;   // 0 = risk-neutral
    var wisdom = cfg.wisdom || (typeof window !== 'undefined' && window.AquinWisdom && window.AquinWisdom.createWisdom && window.AquinWisdom.createWisdom()) || null;
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function evaluate(option) {
      var outs = option.outcomes || [];
      var psum = outs.reduce(function (s, o) { return s + (o.p || 0); }, 0);
      var normalized = Math.abs(psum - 1) < 1e-6;
      var eev = outs.reduce(function (s, o) { return s + (o.p || 0) * (o.value || 0); }, 0);
      var variance = outs.reduce(function (s, o) { return s + (o.p || 0) * Math.pow((o.value || 0) - eev, 2); }, 0);
      var score = eev - lambda * variance;                            // mean-variance
      return { id: option.id, eev: +eev.toFixed(4), variance: +variance.toFixed(4), score: +score.toFixed(4), psum: +psum.toFixed(4), normalized: normalized };
    }

    function decide(options, context) {
      context = context || {}; options = options || [];
      // PERMITTED-ONLY
      var permitted = options.filter(function (o) { return o.permitted !== false; });
      var excluded = options.filter(function (o) { return o.permitted === false; }).map(function (o) { return o.id; });
      if (!permitted.length) { rec('decide', { result: 'none-permitted' }); return { choice: null, reason: 'no permitted option', excluded: excluded }; }

      var scored = permitted.map(evaluate);
      var badProb = scored.filter(function (s) { return !s.normalized; });
      if (badProb.length) return { choice: null, reason: 'outcome probabilities must sum to 1 for: ' + badProb.map(function (b) { return b.id + '(' + b.psum + ')'; }).join(', ') };

      scored.sort(function (a, b) { return b.score - a.score; });
      var top = scored[0], runnerUp = scored[1] || null;
      var edge = runnerUp ? top.score - runnerUp.score : Infinity;

      // WISDOM GATE on the leading option
      var opt = permitted.filter(function (o) { return o.id === top.id; })[0];
      var certainty = edge === Infinity ? 0.9 : Math.min(0.95, 0.5 + edge);      // a thin edge = low certainty
      var wisdomVerdict = null;
      if (wisdom) {
        wisdomVerdict = wisdom.judge({
          certainty: certainty, stakes: opt.stakes != null ? opt.stakes : (context.stakes != null ? context.stakes : 0.4),
          reversibility: opt.reversibility != null ? opt.reversibility : 0.7,
          withinCompetence: context.withinCompetence !== false, alignsValues: opt.alignsValues !== false,
          hasReversibleAlternative: scored.some(function (s) { var o2 = permitted.filter(function (x) { return x.id === s.id; })[0]; return o2 && o2.reversibility >= 0.8 && s.id !== top.id; })
        });
      }
      var act = !wisdomVerdict || wisdomVerdict.recommendation === 'act' || wisdomVerdict.recommendation === 'proceed-with-caution';

      rec('decide', { choice: act ? top.id : null, edge: edge, wisdom: wisdomVerdict && wisdomVerdict.recommendation });
      return {
        choice: act ? top.id : null,
        deferred: !act,
        wisdom: wisdomVerdict,
        edge: edge === Infinity ? null : +edge.toFixed(4),
        ranked: scored,
        excluded: excluded,
        reasoning: act
          ? 'highest expected educational value (' + top.eev + (lambda ? ', risk-adjusted score ' + top.score : '') + ') among permitted options'
          : 'leading option has ' + (wisdomVerdict ? wisdomVerdict.recommendation : 'insufficient support') + ' — ' + (wisdomVerdict ? wisdomVerdict.reasoning : 'thin edge under uncertainty')
      };
    }

    return { provenance: provenance, decide: decide, evaluate: evaluate };
  }
  window.AquinDecision = { createDecider: createDecider };
})();
