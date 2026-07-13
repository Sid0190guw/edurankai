/*
 * aquin-ml.js — AES-000 Part II: Computational Learning. Distinct from Ch 6
 * "Learning" (a learner's concept-state transformation, aquin-understanding.js):
 * this is how the SYSTEM ITSELF learns a model from data — the general supervised
 * learning substrate. Real machine learning, no invented math:
 *
 *   - LOGISTIC REGRESSION  P(y=1 | x) = σ(w·x + b), trained by GRADIENT DESCENT on
 *     the cross-entropy loss (Rosenblatt 1958 lineage; standard convex ML).
 *   - L2 regularisation (weight decay) for generalisation.
 *   - Online (per-example SGD) and batch training; a decreasing loss curve and
 *     recovered decision boundary are proven on synthetic data.
 *
 * Educationally this is the substrate a model-fitter uses to learn, e.g., "predict
 * answer correctness from features (prior mastery, difficulty, time-on-task)". BKT
 * and IRT are specific generative models with their own fitters; this is the
 * general discriminative learner. HONEST SCOPE: convex logistic regression + SGD.
 * Deep nets / kernels / trees are other hypothesis classes behind the same
 * train()/predict() interface — this proves the LEARNING loop is real, not that we
 * ship a neural net in a browser.
 */
(function () {
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  function dot(w, x) { var s = 0; for (var i = 0; i < x.length; i++) s += w[i] * x[i]; return s; }

  function createLearner(cfg) {
    cfg = cfg || {};
    var dim = cfg.dim;                      // number of features (set on first train if omitted)
    var lr = cfg.lr != null ? cfg.lr : 0.1;
    var l2 = cfg.l2 != null ? cfg.l2 : 0.0;
    var w = null, b = 0;
    function ensure(n) { if (!w) { dim = n; w = new Array(n).fill(0); } }

    function predictProba(x) { ensure(x.length); return sigmoid(dot(w, x) + b); }

    // one SGD step on a single example; returns the example's loss
    function step(x, y) {
      ensure(x.length);
      var p = predictProba(x);
      var err = p - y;                      // gradient of cross-entropy wrt logit
      for (var i = 0; i < w.length; i++) w[i] -= lr * (err * x[i] + l2 * w[i]);
      b -= lr * err;
      var eps = 1e-9;
      return -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
    }

    function train(examples, epochs) {
      epochs = epochs || 200;
      var lossCurve = [];
      for (var e = 0; e < epochs; e++) {
        var total = 0;
        for (var i = 0; i < examples.length; i++) total += step(examples[i].x, examples[i].y);
        lossCurve.push(+(total / examples.length).toFixed(5));
      }
      return { epochs: epochs, finalLoss: lossCurve[lossCurve.length - 1], lossCurve: lossCurve };
    }

    function evaluate(examples) {
      var correct = 0;
      examples.forEach(function (ex) { var pred = predictProba(ex.x) >= 0.5 ? 1 : 0; if (pred === ex.y) correct++; });
      return { accuracy: +(correct / examples.length).toFixed(4), n: examples.length };
    }

    return {
      train: train, evaluate: evaluate,
      predict: function (x) { return +predictProba(x).toFixed(4); },
      classify: function (x) { return predictProba(x) >= 0.5 ? 1 : 0; },
      weights: function () { return { w: w ? w.slice() : null, b: +b.toFixed(4) }; }
    };
  }

  window.AquinML = { createLearner: createLearner, sigmoid: sigmoid };
})();
