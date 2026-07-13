/*
 * aquin-understanding.js — AquinTutor Learner Intelligence Core.
 * Real, dependency-free implementation of the AES-000 pipeline for a learner:
 *   Ch 7 Evidence  → Ch 5 Understanding → Ch 6 Learning (CSTs)
 *   → Ch 11 Objective-gated  → Ch 12 Adaptation.
 *
 * The master invariant is enforced in code: NOTHING mutates the learner model
 * except validated Evidence flowing through observe(); every adaptation is tied
 * to an explicit Educational Objective, is evidence-referenced, reversible, and
 * explainable.
 *
 * Grounding (established work, not invented):
 *   - Bayesian Knowledge Tracing (Corbett & Anderson 1994) + Beta–Bernoulli
 *     conjugacy for per-dimension belief with confidence (pseudo-counts).
 *   - Ebbinghaus forgetting / spacing effect for temporal decay.
 *   - Evidence-Centered Design (Mislevy) for evidence→claim weighting.
 * Understanding is an ESTIMATE (probability + confidence), never a fact, never
 * binary, per-concept AND per-context, and distinguishes "no evidence" (low
 * confidence) from "evidence of a misconception" (a separate belief).
 */
(function () {
  var DIMENSIONS = ['conceptual', 'structural', 'procedural', 'transfer', 'diagnostic', 'reflective'];
  var DIM_SET = {}; DIMENSIONS.forEach(function (d) { DIM_SET[d] = 1; });
  // relative contribution of each dimension to an overall mastery summary
  var DIM_WEIGHT = { conceptual: 0.28, structural: 0.16, procedural: 0.18, transfer: 0.16, diagnostic: 0.10, reflective: 0.12 };

  function clamp01(x, d) { return typeof x === 'number' ? Math.max(0, Math.min(1, x)) : d; }
  function qualityScore(q) {
    // ECD-style: richer, more independent, more reproducible, more contextually
    // diverse evidence moves belief more. Default modest weight when unspecified.
    if (!q) return 0.6;
    var keys = ['conceptualRichness', 'proceduralComplexity', 'contextualDiversity', 'authenticity', 'independence', 'reproducibility', 'temporalStability'];
    var s = 0, n = 0; keys.forEach(function (k) { if (typeof q[k] === 'number') { s += clamp01(q[k]); n++; } });
    return n ? s / n : 0.6;
  }

  // ---- Evidence factory + shape check (used by the validation pipeline) --
  function makeEvidence(spec) {
    return {
      id: spec.id || ('ev_' + Math.random().toString(36).slice(2, 10)),
      conceptId: spec.conceptId,
      context: spec.context || 'default',
      // targets: { dim|misconceptionId : +1 supports | -1 contradicts }
      targets: spec.targets || {},
      misconceptionTargets: spec.misconceptionTargets || {},
      category: spec.category || 'direct',            // direct | indirect | synthetic | external
      quality: spec.quality || null,
      provenance: spec.provenance || null,            // { source, activity, timestamp, ... } — MANDATORY
      obsConfidence: typeof spec.obsConfidence === 'number' ? spec.obsConfidence : 0.8,
      time: spec.time || Date.now()
    };
  }

  function LearnerModel(learnerId, opts) {
    opts = opts || {};
    this.learnerId = learnerId;
    this.prior = opts.prior || 1;                     // Beta(1,1) uniform prior
    this.tau = opts.tauMs || (1000 * 60 * 60 * 24 * 21); // ~21-day forgetting constant
    this.mcThreshold = opts.mcThreshold || 0.55;
    this.state = {};                                  // key -> concept/context state
    this.log = [];                                    // append-only evidence log (auditable)
    this.csts = [];                                   // Concept State Transformations (Learning)
  }
  LearnerModel.prototype._key = function (conceptId, ctx) { return conceptId + '|' + (ctx || 'default'); };
  LearnerModel.prototype._cell = function (conceptId, ctx) {
    var k = this._key(conceptId, ctx), p = this.prior;
    if (!this.state[k]) { var dims = {}; DIMENSIONS.forEach(function (d) { dims[d] = { a: p, b: p, lastT: null, reinf: 0 }; }); this.state[k] = { dims: dims, mc: {} }; }
    return this.state[k];
  };

  // ---- Ch 7: Evidence Validation Pipeline (never mutate model directly) --
  LearnerModel.prototype.validate = function (ev) {
    var reasons = [];
    if (!ev || typeof ev.conceptId !== 'string' || !ev.conceptId) reasons.push('missing conceptId');
    if (!ev.provenance || !ev.provenance.source) reasons.push('missing provenance.source (provenance is mandatory)');
    if (!(ev.obsConfidence >= 0 && ev.obsConfidence <= 1)) reasons.push('obsConfidence must be in [0,1]');
    var tCount = Object.keys(ev.targets || {}).length + Object.keys(ev.misconceptionTargets || {}).length;
    if (!tCount) reasons.push('evidence must target at least one dimension or misconception');
    Object.keys(ev.targets || {}).forEach(function (d) { if (!DIM_SET[d]) reasons.push('unknown dimension "' + d + '"'); });
    return { ok: reasons.length === 0, reasons: reasons };
  };

  // ---- Ch 5+6: ingest evidence -> Bayesian update -> CSTs ----------------
  LearnerModel.prototype.observe = function (evidenceSpec) {
    var ev = (evidenceSpec && evidenceSpec.targets) ? evidenceSpec : makeEvidence(evidenceSpec);
    // read defaults locally — never mutate the (possibly frozen/immutable) evidence
    var targets = ev.targets || {};
    var mcTargets = ev.misconceptionTargets || {};
    var v = this.validate(ev);
    if (!v.ok) return { accepted: false, reasons: v.reasons, csts: [] };
    var cell = this._cell(ev.conceptId, ev.context);
    var w = 1.0 * clamp01(ev.obsConfidence, 0.8) * qualityScore(ev.quality); // ECD weight
    var made = [], self = this;

    Object.keys(targets).forEach(function (dim) {
      var dir = targets[dim] >= 0 ? 1 : -1, cd = cell.dims[dim];
      var beforeMean = cd.a / (cd.a + cd.b), beforeMass = cd.a + cd.b;
      if (dir > 0) { cd.a += w; cd.reinf++; } else { cd.b += w; }
      cd.lastT = ev.time;
      var afterMean = cd.a / (cd.a + cd.b);
      var kind;
      if (dir > 0 && beforeMass <= 2 * self.prior + 1e-9) kind = 'acquisition';
      else if (dir > 0 && beforeMean > 0.7) kind = 'reinforcement';
      else if (dir > 0 && dim === 'structural') kind = 'integration';
      else if (dir > 0 && dim === 'transfer') kind = 'transfer';
      else if (dir > 0) kind = 'refinement';
      else kind = 'regression';
      made.push({ conceptId: ev.conceptId, context: ev.context, dim: dim, kind: kind, deltaMean: +(afterMean - beforeMean).toFixed(4), direction: dir, confidenceAfter: +(1 - 1 / (cd.a + cd.b)).toFixed(3), evidenceId: ev.id, time: ev.time });
    });

    Object.keys(mcTargets).forEach(function (mcId) {
      var dir = mcTargets[mcId] >= 0 ? 1 : -1;
      if (!cell.mc[mcId]) cell.mc[mcId] = { a: self.prior, b: self.prior, lastT: null };
      var m = cell.mc[mcId], before = m.a / (m.a + m.b);
      if (dir > 0) m.a += w; else m.b += w;            // +1 = evidence learner HOLDS it
      m.lastT = ev.time;
      var after = m.a / (m.a + m.b);
      made.push({ conceptId: ev.conceptId, context: ev.context, misconceptionId: mcId, kind: dir < 0 ? 'misconception-resolution' : 'misconception-reinforced', deltaMean: +(after - before).toFixed(4), direction: dir, evidenceId: ev.id, time: ev.time });
    });

    this.log.push(ev);
    made.forEach(function (c) { self.csts.push(c); });
    return { accepted: true, reasons: [], csts: made, evidenceId: ev.id };
  };

  // ---- Ch 5: query with temporal decay (forgetting + spacing) ------------
  LearnerModel.prototype._decayed = function (cell, atTime) {
    var self = this, p = this.prior, out = {};
    DIMENSIONS.forEach(function (d) {
      var cd = cell.dims[d];
      var aEff = cd.a, bEff = cd.b;
      if (cd.lastT != null) {
        var dt = Math.max(0, atTime - cd.lastT);
        var tauEff = self.tau * (1 + 0.5 * cd.reinf);   // spacing: more reinforcement, slower forgetting
        var f = Math.exp(-dt / tauEff);
        aEff = p + (cd.a - p) * f; bEff = p + (cd.b - p) * f;   // relax toward prior
      }
      out[d] = { mean: +(aEff / (aEff + bEff)).toFixed(3), confidence: +(1 - 1 / (aEff + bEff)).toFixed(3) };
    });
    return out;
  };
  LearnerModel.prototype.understanding = function (conceptId, ctx, atTime) {
    atTime = atTime || Date.now();
    var cell = this._cell(conceptId, ctx);
    var dims = this._decayed(cell, atTime);
    var mastery = 0, conf = 0;
    DIMENSIONS.forEach(function (d) { mastery += DIM_WEIGHT[d] * dims[d].mean; conf += DIM_WEIGHT[d] * dims[d].confidence; });
    var mc = {};
    Object.keys(cell.mc).forEach(function (id) { var m = cell.mc[id]; mc[id] = { belief: +(m.a / (m.a + m.b)).toFixed(3), confidence: +(1 - 1 / (m.a + m.b)).toFixed(3) }; });
    return { conceptId: conceptId, context: ctx || 'default', dims: dims, misconceptions: mc, overall: { mastery: +mastery.toFixed(3), confidence: +conf.toFixed(3) } };
  };

  // ---- Ch 6: the learner's learning trajectory ---------------------------
  LearnerModel.prototype.learning = function (conceptId, ctx) {
    return this.csts.filter(function (c) { return (!conceptId || c.conceptId === conceptId) && (!ctx || c.context === ctx); });
  };

  // ---- Ch 5/7: explainability — the evidence trail behind an estimate ----
  LearnerModel.prototype.explain = function (conceptId, ctx) {
    var u = this.understanding(conceptId, ctx);
    var evs = this.log.filter(function (e) { return e.conceptId === conceptId && (e.context || 'default') === (ctx || 'default'); })
      .map(function (e) { return { id: e.id, category: e.category, source: e.provenance && e.provenance.source, activity: e.provenance && e.provenance.activity, obsConfidence: e.obsConfidence, time: e.time }; });
    return { estimate: u, evidence: evs, csts: this.learning(conceptId, ctx) };
  };

  // ---- Ch 11+12: objective-gated, evidence-driven, reversible adaptation --
  // objective: { conceptId, context?, targetMastery? (0..1), kind? }
  LearnerModel.prototype.adapt = function (objective) {
    if (!objective || !objective.conceptId) throw new Error('adapt requires an Educational Objective with a conceptId');
    var ctx = objective.context || 'default';
    var target = typeof objective.targetMastery === 'number' ? objective.targetMastery : 0.75;
    var u = this.understanding(objective.conceptId, ctx);
    var need = Math.max(0, +(target - u.overall.mastery).toFixed(3));       // Educational Need (Ch12)
    var visMean = (u.dims.conceptual.mean + u.dims.structural.mean) / 2;
    var visualization = visMean < 0.4 ? 'simplified' : visMean < 0.7 ? 'standard' : 'detailed';

    // strongest active misconception above threshold?
    var topMc = null; Object.keys(u.misconceptions).forEach(function (id) { var m = u.misconceptions[id]; if (m.belief >= 0 && (!topMc || m.belief > topMc.belief)) topMc = { id: id, belief: m.belief, confidence: m.confidence }; });

    var action, rationale;
    if (topMc && topMc.belief >= this.mcThreshold) {
      action = 'reconstruct';
      rationale = 'Evidence indicates the misconception "' + topMc.id + '" (belief ' + topMc.belief + '); repetition is ineffective — switch to an alternative analogy/visualization/experiment to restructure the model.';
    } else if (u.overall.confidence < 0.3) {
      action = 'assess';
      rationale = 'Understanding estimate is low-confidence; gather the most-informative evidence before intervening (avoid acting on absence of evidence).';
    } else if (u.overall.mastery < 0.4) {
      action = 'revise-prerequisite';
      rationale = 'Low mastery with adequate confidence — recover prerequisites before advancing (avoids cognitive overload).';
    } else if (need > 0) {
      action = 'reinforce';
      rationale = 'On track but below the objective by ' + need + '; provide targeted practice and applied contexts.';
    } else {
      action = 'advance';
      rationale = 'Objective met (mastery ' + u.overall.mastery + ' >= target ' + target + '); progress to the next concept.';
    }
    return {
      objective: { conceptId: objective.conceptId, context: ctx, targetMastery: target, kind: objective.kind || 'strengthen-understanding' },
      need: need, action: action, visualization: visualization,
      tutorDepth: u.overall.mastery > 0.7 ? 'concise' : u.overall.confidence < 0.3 ? 'diagnostic' : 'guided',
      rationale: rationale,
      evidenceRefs: this.log.filter(function (e) { return e.conceptId === objective.conceptId && (e.context || 'default') === ctx; }).map(function (e) { return e.id; }),
      expectedOutcome: action === 'advance' ? 'no change needed' : ('raise ' + objective.conceptId + ' mastery toward ' + target),
      reversible: true                                   // Ch12: adaptations are reversible + measurable
    };
  };

  window.AquinUnderstanding = {
    DIMENSIONS: DIMENSIONS, DIM_WEIGHT: DIM_WEIGHT,
    makeEvidence: makeEvidence, LearnerModel: LearnerModel
  };
})();
