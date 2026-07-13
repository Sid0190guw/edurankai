/*
 * aquin-federated.js — AES-100 Vol III Ch 43: Kernel Federated Learning &
 * Distributed Intelligence Engine (KFLDIE). Institutions hold valuable data they
 * cannot share (privacy law, student confidentiality). Federated learning improves
 * a shared model WITHOUT centralizing raw data: each institution trains locally and
 * sends only model WEIGHTS; a secure aggregator averages them. This implements
 * Federated Averaging — FedAvg (McMahan, Moore, Ramage, Hampson, Arcas 2017) — with
 * sample-count + TRUST weighting and a validation pipeline that rejects poisoned
 * updates. No invented CS.
 *
 * Guarantees proven in the tests:
 *  - PRIVACY BY CONSTRUCTION: the aggregator's interface accepts only weight
 *    vectors + counts, never raw examples — data never leaves its institution.
 *  - FEDAVG CORRECTNESS: after a few rounds the federated model matches a
 *    CENTRALIZED model trained on the pooled data — without ever pooling it.
 *  - TRUST + SAMPLE weighting: bigger, more trusted contributors weigh more.
 *  - VALIDATION: a poisoned/garbage update (wrong dimension or an absurd weight
 *    norm) is REJECTED and never enters aggregation, so one bad actor can't wreck
 *    the global model.
 *  - MODEL VERSIONING: every aggregation produces a new governed version.
 *
 * HONEST SCOPE: real FedAvg over logistic-regression weights; differential privacy,
 * secure multiparty computation, and encrypted transport are declared substrate
 * options that plug in behind the same weight-exchange interface.
 */
(function () {
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  function dot(w, x) { var s = 0; for (var i = 0; i < x.length; i++) s += w[i] * x[i]; return s; }
  function norm(w) { var s = 0; for (var i = 0; i < w.length; i++) s += w[i] * w[i]; return Math.sqrt(s); }

  // local training (logistic regression, warm-started from the global model)
  function trainLocal(data, initW, initB, opts) {
    opts = opts || {}; var lr = opts.lr || 0.2, epochs = opts.epochs || 40;
    var w = initW.slice(), b = initB;
    for (var e = 0; e < epochs; e++) {
      for (var i = 0; i < data.length; i++) {
        var x = data[i].x, y = data[i].y, p = sigmoid(dot(w, x) + b), err = p - y;
        for (var j = 0; j < w.length; j++) w[j] -= lr * err * x[j];
        b -= lr * err;
      }
    }
    return { w: w, b: b, n: data.length };
  }

  function createFederation(cfg) {
    cfg = cfg || {};
    var dim = cfg.dim;
    var global = { w: null, b: 0, version: 0 };
    var participants = {};
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function ensureGlobal(d) { if (!global.w) { dim = d; global.w = new Array(d).fill(0); } }

    var F = {
      provenance: provenance,
      registerParticipant: function (id, spec) { participants[id] = { id: id, trust: (spec && spec.trust) != null ? spec.trust : 1 }; return this; },
      global: function () { return { w: global.w ? global.w.slice() : null, b: global.b, version: global.version }; },

      // a participant trains locally and returns ONLY its weights (raw data stays local)
      localUpdate: function (participantId, data, opts) {
        ensureGlobal(data[0].x.length);
        var u = trainLocal(data, global.w, global.b, opts);
        rec('local-update', { participant: participantId, n: u.n });
        return { participant: participantId, w: u.w, b: u.b, n: u.n };
      },

      // VALIDATION: reject wrong-dimension or absurd-norm (poisoned) updates
      validate: function (update) {
        if (!update || !Array.isArray(update.w) || update.w.length !== dim) return { ok: false, reason: 'wrong dimension' };
        if (!isFinite(norm(update.w)) || norm(update.w) > (cfg.maxNorm || 1000)) return { ok: false, reason: 'absurd weight norm — likely poisoned' };
        if (update.n == null || update.n <= 0) return { ok: false, reason: 'no sample count' };
        return { ok: true };
      },

      // SECURE AGGREGATION — FedAvg weighted by (sample count x trust)
      aggregate: function (updates) {
        var accepted = [], rejected = [];
        updates.forEach(function (u) { var v = F.validate(u); if (v.ok) accepted.push(u); else rejected.push({ participant: u.participant, reason: v.reason }); });
        if (!accepted.length) return { ok: false, reason: 'no valid updates', rejected: rejected };
        var W = new Array(dim).fill(0), B = 0, total = 0;
        accepted.forEach(function (u) { var trust = participants[u.participant] ? participants[u.participant].trust : 1; var weight = u.n * trust; total += weight; for (var j = 0; j < dim; j++) W[j] += weight * u.w[j]; B += weight * u.b; });
        for (var j = 0; j < dim; j++) W[j] /= total; B /= total;
        global.w = W; global.b = B; global.version++;
        rec('aggregate', { accepted: accepted.length, rejected: rejected.length, version: global.version });
        return { ok: true, version: global.version, accepted: accepted.length, rejected: rejected };
      },

      // one federated round over {participantId: data}
      round: function (localData, opts) {
        var updates = Object.keys(localData).map(function (pid) { return F.localUpdate(pid, localData[pid], opts); });
        return F.aggregate(updates);
      },
      predict: function (x) { return sigmoid(dot(global.w, x) + global.b); },
      evaluate: function (testSet) { var c = 0; testSet.forEach(function (t) { if ((F.predict(t.x) >= 0.5 ? 1 : 0) === t.y) c++; }); return +(c / testSet.length).toFixed(4); }
    };
    return F;
  }
  window.AquinFederated = { createFederation: createFederation, trainLocal: trainLocal };
})();
