/*
 * aquin-hypothesis.js — AES Part IV: the Educational Reasoner's Hypothesis Engine.
 * A tutor reasons like a scientist: form competing hypotheses for WHY a learner is
 * struggling, update belief in each as evidence arrives, and choose the next probe
 * that best DISCRIMINATES them. Grounded in Bayesian confirmation theory + the
 * hypothetico-deductive method + optimal experiment design — no invented CS.
 *
 *   - Hypotheses H_i with priors P(H_i) and likelihood models P(evidence | H_i).
 *   - BAYESIAN UPDATE on each observation:  P(H|E) ∝ P(E|H)·P(H).
 *   - NEXT-TEST selection by expected information gain over the hypothesis
 *     posterior: pick the probe whose outcome will most reduce uncertainty about
 *     which hypothesis is true (ties Part II information theory to diagnosis).
 *
 * Example hypotheses for "student missed a fraction question": missing-prerequisite,
 * specific-misconception, careless-slip, low-engagement. Each predicts different
 * future evidence; the engine picks the question that best tells them apart, then
 * updates. HONEST SCOPE: discrete hypotheses with Bernoulli/categorical likelihoods;
 * the likelihood models are authored/estimated (from BKT/IRT), the inference is real.
 */
(function () {
  function log2(x) { return Math.log(x) / Math.LN2; }
  function entropy(dist) { var h = 0; Object.keys(dist).forEach(function (k) { var p = dist[k]; if (p > 0) h -= p * log2(p); }); return h; }
  function normalize(d) { var s = 0; Object.keys(d).forEach(function (k) { s += d[k]; }); var o = {}; Object.keys(d).forEach(function (k) { o[k] = s > 0 ? d[k] / s : 0; }); return o; }

  function createReasoner() {
    var belief = {};          // hypothesisId -> probability
    var likelihoods = {};     // hypothesisId -> { testId: { outcome: P(outcome|H) } }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var R = {
      provenance: provenance,
      // register a hypothesis with a prior and its predictive likelihood models
      hypothesis: function (id, prior, likelihoodByTest) { belief[id] = prior; likelihoods[id] = likelihoodByTest || {}; return this; },
      normalizePriors: function () { belief = normalize(belief); return this; },
      posterior: function () { return normalize(belief); },
      ranked: function () { var p = this.posterior(); return Object.keys(p).map(function (k) { return { hypothesis: k, p: +p[k].toFixed(4) }; }).sort(function (a, b) { return b.p - a.p; }); },
      uncertainty: function () { return +entropy(this.posterior()).toFixed(4); },

      // BAYESIAN UPDATE given an observed (testId, outcome)
      observe: function (testId, outcome) {
        var post = {}, prior = normalize(belief);
        Object.keys(prior).forEach(function (h) {
          var lk = (likelihoods[h][testId] || {})[outcome];
          if (lk == null) lk = 0.5;                 // uninformative if unmodelled
          post[h] = prior[h] * lk;
        });
        belief = normalize(post);
        rec('observe', { test: testId, outcome: outcome, top: this.ranked()[0] });
        return this.posterior();
      },

      // expected information gain of running a test (over its possible outcomes)
      expectedInfoGain: function (testId, outcomes) {
        var prior = normalize(belief), hPrior = entropy(prior);
        // P(outcome) = Σ_h P(h)·P(outcome|h)
        var pOut = {};
        outcomes.forEach(function (o) { pOut[o] = Object.keys(prior).reduce(function (s, h) { return s + prior[h] * ((likelihoods[h][testId] || {})[o] != null ? likelihoods[h][testId][o] : 0.5); }, 0); });
        var expH = 0;
        outcomes.forEach(function (o) {
          if (pOut[o] <= 0) return;
          var post = {};
          Object.keys(prior).forEach(function (h) { var lk = (likelihoods[h][testId] || {})[o]; post[h] = prior[h] * (lk != null ? lk : 0.5); });
          expH += pOut[o] * entropy(normalize(post));
        });
        return { testId: testId, eig: +(hPrior - expH).toFixed(4) };
      },

      // choose the most DISCRIMINATING next probe
      nextTest: function (tests) {
        var ranked = tests.map(function (t) { return this.expectedInfoGain(t.id, t.outcomes); }, this).sort(function (a, b) { return b.eig - a.eig; });
        rec('next-test', { chosen: ranked[0] && ranked[0].testId });
        return { best: ranked[0] || null, ranked: ranked };
      }
    };
    return R;
  }
  window.AquinHypothesis = { createReasoner: createReasoner };
})();
