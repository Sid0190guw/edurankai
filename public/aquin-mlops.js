/*
 * aquin-mlops.js — AES-100 Vol IV P2 Ch86: Enterprise Machine Learning Platform, MLOps
 * & Model Lifecycle (EMLPMMLEF). Turns isolated models into governed enterprise assets.
 * Real, tested cores:
 *
 *  - DATASET VERSIONING: content-addressable (FNV-1a hash of the rows). Registering the
 *    same content is a no-op (same version); different content = a new version; a
 *    version is IMMUTABLE. Guarantees reproducibility.
 *  - EXPERIMENT TRACKING + reproducibility: an experiment is keyed by (code, dataset,
 *    hyperparameters); the same inputs reproduce the same run id.
 *  - MODEL REGISTRY + LIFECYCLE state machine (design->trained->evaluated->certified->
 *    deployed->retired); illegal transitions rejected.
 *  - EVALUATION: confusion matrix, precision, recall, F1, accuracy, and ROC-AUC computed
 *    for real (Mann-Whitney rank statistic) from labels + scores.
 *  - HYPERPARAMETER OPTIMIZATION: grid / random search over a space against a real
 *    objective, returns the best configuration.
 *  - CI/CD PROMOTION GATE: a candidate is promoted only if it beats the deployed baseline
 *    AND is certified — else refused.
 *  - DRIFT-TRIGGERED RETRAINING: a measurable trigger (drift/degradation/schedule), not a
 *    guess.
 *
 * HONEST SCOPE: versioning, metrics, search and gating are real; GPU training kernels,
 * the feature store (aquin-feature-store.js) and object storage are declared substrates.
 */
(function () {
  function fnv1a(str) { var h = 0x811c9dc5; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('00000000' + h.toString(16)).slice(-8); }

  // ROC-AUC via the rank (Mann-Whitney U) identity — exact, no threshold sweep needed
  function rocAuc(rows) {
    var pos = rows.filter(function (r) { return r.label === 1; }), neg = rows.filter(function (r) { return r.label === 0; });
    if (!pos.length || !neg.length) return null;
    var sorted = rows.map(function (r) { return r.score; }).slice().sort(function (a, b) { return a - b; });
    // average ranks (1-based), handling ties
    var ranks = {}, i = 0;
    while (i < sorted.length) { var j = i; while (j + 1 < sorted.length && sorted[j + 1] === sorted[i]) j++; var avg = (i + j + 2) / 2; for (var k = i; k <= j; k++) ranks[sorted[k]] = avg; i = j + 1; }
    var sumPosRanks = pos.reduce(function (a, r) { return a + ranks[r.score]; }, 0);
    var nP = pos.length, nN = neg.length;
    return +(((sumPosRanks - nP * (nP + 1) / 2) / (nP * nN))).toFixed(4);
  }

  function evaluate(rows, threshold) {
    threshold = threshold != null ? threshold : 0.5;
    var tp = 0, fp = 0, tn = 0, fn = 0;
    rows.forEach(function (r) { var pred = r.score >= threshold ? 1 : 0; if (pred === 1 && r.label === 1) tp++; else if (pred === 1 && r.label === 0) fp++; else if (pred === 0 && r.label === 0) tn++; else fn++; });
    var precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0;
    var f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    return { confusion: { tp: tp, fp: fp, tn: tn, fn: fn }, accuracy: +((tp + tn) / rows.length).toFixed(4), precision: +precision.toFixed(4), recall: +recall.toFixed(4), f1: +f1.toFixed(4), rocAuc: rocAuc(rows) };
  }

  function createRegistry() {
    var datasets = {}, experiments = {}, models = {}, deployed = {}, seq = 0, prov = [];
    function rec(op, d) { prov.push({ op: op, at: Date.now(), detail: d || null }); }
    var LIFE = ['design', 'trained', 'evaluated', 'certified', 'deployed', 'retired'];

    var R = {
      provenance: prov, evaluate: evaluate, rocAuc: rocAuc,

      registerDataset: function (id, rows) {
        var hash = fnv1a(JSON.stringify(rows)); var d = datasets[id] = datasets[id] || { id: id, versions: [] };
        var existing = d.versions.filter(function (v) { return v.hash === hash; })[0];
        if (existing) return { id: id, version: existing.version, hash: hash, reused: true };
        var version = d.versions.length + 1; d.versions.push({ version: version, hash: hash, rows: rows.length, frozen: true }); rec('dataset', { id: id, version: version });
        return { id: id, version: version, hash: hash, reused: false };
      },

      logExperiment: function (spec) {
        var key = fnv1a(JSON.stringify([spec.code, spec.dataset, spec.hyperparams]));
        if (experiments[key]) return { runId: key, reproduced: true };   // same inputs -> same run
        experiments[key] = { runId: key, spec: spec }; rec('experiment', { runId: key }); return { runId: key, reproduced: false };
      },

      registerModel: function (spec) { var id = spec.id || ('model_' + (++seq)); models[id] = { id: id, domain: spec.domain || 'general', algorithm: spec.algorithm || null, dataset: spec.dataset || null, state: 'design', metrics: null, certified: false }; rec('model', { id: id }); return models[id]; },
      transition: function (id, to) { var m = models[id]; if (!m) return { ok: false, reason: 'no model' }; if (LIFE.indexOf(to) !== LIFE.indexOf(m.state) + 1 && to !== 'retired') return { ok: false, reason: 'illegal transition ' + m.state + ' -> ' + to }; m.state = to; if (to === 'certified') m.certified = true; rec('transition', { id: id, to: to }); return { ok: true, state: to }; },
      attachEvaluation: function (id, rows, threshold) { var m = models[id]; if (!m) return null; m.metrics = evaluate(rows, threshold); rec('evaluate', { id: id, auc: m.metrics.rocAuc }); return m.metrics; },

      // grid / random search over a space of arrays against an objective (higher is better)
      hpo: function (space, objective, opts) {
        opts = opts || {}; var keys = Object.keys(space), combos = [{}];
        keys.forEach(function (k) { var next = []; combos.forEach(function (c) { space[k].forEach(function (v) { var n = Object.assign({}, c); n[k] = v; next.push(n); }); }); combos = next; });
        if (opts.strategy === 'random') { for (var i = combos.length - 1; i > 0; i--) { var j = Math.floor((opts.rng ? opts.rng() : Math.random()) * (i + 1)); var t = combos[i]; combos[i] = combos[j]; combos[j] = t; } combos = combos.slice(0, opts.budget || combos.length); }
        var best = null; combos.forEach(function (c) { var s = objective(c); if (!best || s > best.score) best = { config: c, score: +s.toFixed(4) }; }); rec('hpo', { evaluated: combos.length, best: best && best.score });
        return { evaluated: combos.length, best: best };
      },

      // CI/CD gate: promote a candidate only if it beats the deployed baseline AND is certified
      promote: function (id, metric) {
        var m = models[id]; if (!m) return { ok: false, reason: 'no model' };
        if (!m.certified) return { ok: false, reason: 'model not certified — blocked by governance gate' };
        var cur = deployed[m.domain]; var candScore = metric != null ? metric : (m.metrics ? m.metrics.f1 : 0);
        if (cur && candScore < cur.score) return { ok: false, reason: 'candidate ' + candScore + ' does not beat deployed baseline ' + cur.score };
        deployed[m.domain] = { id: id, score: candScore }; m.state = 'deployed'; rec('promote', { id: id, score: candScore });
        return { ok: true, deployed: id, domain: m.domain, score: candScore, replaced: cur ? cur.id : null };
      },

      shouldRetrain: function (signals) {
        signals = signals || {}; var reasons = [];
        if (signals.drift && signals.drift >= (signals.driftThreshold || 0.2)) reasons.push('drift ' + signals.drift + ' >= threshold');
        if (signals.performance != null && signals.baseline != null && signals.performance < signals.baseline - (signals.tolerance || 0.05)) reasons.push('performance degraded');
        if (signals.scheduledDue) reasons.push('scheduled retraining due');
        if (signals.newData && signals.newData >= (signals.newDataThreshold || 1000)) reasons.push('sufficient new data (' + signals.newData + ')');
        return { retrain: reasons.length > 0, reasons: reasons };
      },
      model: function (id) { return models[id]; }
    };
    return R;
  }
  window.AquinMLOps = { createRegistry: createRegistry, evaluate: evaluate, rocAuc: rocAuc };
})();
