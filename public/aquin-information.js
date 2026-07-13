/*
 * aquin-information.js — AES-000 Part II (Computational Theory): Educational
 * Information Theory. What does it MEAN, quantitatively, for an assessment to be
 * "informative"? Shannon information theory, applied to educational belief states —
 * no invented math:
 *
 *   - ENTROPY  H(X) = -Σ p·log2 p   — our uncertainty about a learner's skill.
 *   - KL DIVERGENCE  D(p‖q) = Σ p·log2(p/q) — how much a belief moved.
 *   - EXPECTED INFORMATION GAIN of a question (Lindley 1956, Bayesian optimal
 *     design): EIG = H(prior) − Σ_response P(response)·H(posterior | response).
 *     The most informative next question MAXIMISES EIG — this is the information-
 *     theoretic foundation of adaptive testing (and the twin of IRT's Fisher
 *     information in aquin-irt.js).
 *
 * A question everyone passes, or everyone fails, has ~0 information gain no matter
 * how "hard" it looks; a question that DISCRIMINATES across skill levels is
 * informative. This engine computes that, and picks the question that will teach
 * the system the most about the learner. HONEST SCOPE: discrete belief states +
 * Bernoulli item likelihoods; continuous-ability information is IRT (Ch/Part III).
 */
(function () {
  function log2(x) { return Math.log(x) / Math.LN2; }

  // Shannon entropy of a probability vector (bits)
  function entropy(probs) {
    var vals = Array.isArray(probs) ? probs : Object.keys(probs).map(function (k) { return probs[k]; });
    var h = 0;
    vals.forEach(function (p) { if (p > 0) h -= p * log2(p); });
    return +h.toFixed(6);
  }
  // KL divergence D(p||q) in bits
  function klDivergence(p, q) {
    var keys = Object.keys(p), d = 0;
    keys.forEach(function (k) { var pi = p[k], qi = q[k]; if (pi > 0) { if (!qi) return NaN; d += pi * log2(pi / qi); } });
    return +d.toFixed(6);
  }
  function normalize(belief) {
    var keys = Object.keys(belief), s = keys.reduce(function (a, k) { return a + belief[k]; }, 0);
    var out = {}; keys.forEach(function (k) { out[k] = s > 0 ? belief[k] / s : 0; }); return out;
  }

  // Bayesian posterior over discrete skill levels given a Bernoulli response.
  // question.likelihood = { level: P(correct | level) }
  function posterior(belief, question, correct) {
    var lk = question.likelihood, out = {};
    Object.keys(belief).forEach(function (lvl) {
      var pc = lk[lvl] != null ? lk[lvl] : 0.5;
      out[lvl] = belief[lvl] * (correct ? pc : (1 - pc));
    });
    return normalize(out);
  }

  // probability of a correct response under the current belief (marginal)
  function pCorrect(belief, question) {
    var lk = question.likelihood;
    return Object.keys(belief).reduce(function (s, lvl) { return s + belief[lvl] * (lk[lvl] != null ? lk[lvl] : 0.5); }, 0);
  }

  // EXPECTED INFORMATION GAIN of asking `question` given `belief`
  function expectedInfoGain(belief, question) {
    var prior = entropy(belief);
    var pc = pCorrect(belief, question);
    var hIfCorrect = entropy(posterior(belief, question, true));
    var hIfWrong = entropy(posterior(belief, question, false));
    var expectedPosterior = pc * hIfCorrect + (1 - pc) * hIfWrong;
    return { eig: +(prior - expectedPosterior).toFixed(6), priorEntropy: prior, pCorrect: +pc.toFixed(4), expectedPosteriorEntropy: +expectedPosterior.toFixed(6) };
  }

  // pick the question that reduces uncertainty the most (adaptive assessment)
  function selectMostInformative(belief, questions) {
    var ranked = questions.map(function (q) { return { id: q.id, eig: expectedInfoGain(belief, q).eig }; }).sort(function (a, b) { return b.eig - a.eig; });
    return { best: ranked[0] || null, ranked: ranked };
  }

  // actual information gained from a realised observation (prior->posterior)
  function realizedInfoGain(belief, question, correct) {
    var post = posterior(belief, question, correct);
    return { informationGained: +(entropy(belief) - entropy(post)).toFixed(6), kl: klDivergence(post, belief), posterior: post };
  }

  window.AquinInformation = {
    entropy: entropy, klDivergence: klDivergence, posterior: posterior, pCorrect: pCorrect,
    expectedInfoGain: expectedInfoGain, selectMostInformative: selectMostInformative, realizedInfoGain: realizedInfoGain
  };
})();
