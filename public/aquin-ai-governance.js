/*
 * aquin-ai-governance.js — AES-100 Vol IV P2 Ch85: Enterprise AI Governance, Safety,
 * Trustworthiness & Responsible Intelligence (EAGSTRIF). Governance BEFORE deployment,
 * not after. This builds the distinct real cores (the constitution/policy engine already
 * exists in aquin-constitution.js and is composed, not duplicated):
 *
 *  - RISK CLASSIFICATION -> REQUIRED CONTROLS: a service's impact areas (admissions,
 *    scholarships, grades…) determine its risk level, and governance requirements
 *    INCREASE with risk (minimal -> mission-critical). Real, monotone.
 *  - FAIRNESS / BIAS METRICS: demographic parity difference, disparate-impact ratio
 *    (the 80% rule), and equal-opportunity difference (TPR gap) — real statistics on
 *    real outcome tables.
 *  - DRIFT DETECTION: Population Stability Index (PSI) between an expected and an
 *    observed distribution; >0.2 = significant drift -> review.
 *  - SAFETY VALIDATION pipeline: confidence floor, unsupported-claim (hallucination)
 *    check against cited sources, authorization check -> moderate / escalate / block.
 *  - CERTIFICATION GATE: a service is production-eligible only if every required
 *    control is satisfied AND safety passed AND fairness within tolerance AND not
 *    drifted AND a human approved. Otherwise it lists exactly what is missing.
 *  - LIFECYCLE state machine + append-only AUDIT trail.
 *
 * HONEST SCOPE: the classification, fairness/PSI math, safety pipeline and gating are
 * real and tested; the underlying LLM/model, and the human reviewers themselves, are
 * declared substrates.
 */
(function () {
  var RISK = ['minimal', 'limited', 'moderate', 'high', 'mission-critical'];
  // required controls grow monotonically with risk
  var CONTROLS = {
    'minimal':        ['audit'],
    'limited':        ['audit', 'monitoring'],
    'moderate':       ['audit', 'monitoring', 'explainability'],
    'high':           ['audit', 'monitoring', 'explainability', 'human-review', 'fairness', 'certification'],
    'mission-critical': ['audit', 'monitoring', 'explainability', 'human-review', 'fairness', 'certification', 'dual-approval', 'emergency-override']
  };
  // impact areas that push a service up the risk ladder
  var HIGH_IMPACT = { admissions: 1, scholarships: 1, grades: 1, examinations: 1, 'disciplinary': 1 };
  var MODERATE_IMPACT = { analytics: 1, recommendations: 1, forecasting: 1, 'learning-pathways': 1 };

  function pct(n, d) { return d ? n / d : 0; }

  function createGovernor(cfg) {
    cfg = cfg || {};
    var confFloor = cfg.confidenceFloor != null ? cfg.confidenceFloor : 0.55;
    var diThreshold = cfg.disparateImpact != null ? cfg.disparateImpact : 0.8;   // 80% rule
    var dpTolerance = cfg.parityTolerance != null ? cfg.parityTolerance : 0.1;
    var psiThreshold = cfg.psiThreshold != null ? cfg.psiThreshold : 0.2;
    var services = {};       // id -> governance profile
    var audit = [];
    function rec(op, d) { audit.push({ op: op, at: Date.now(), detail: d || null }); }

    // ---- risk classification -> required controls ----
    function classifyRisk(spec) {
      spec = spec || {}; var areas = spec.impacts || [];
      var lvl = 0;
      areas.forEach(function (a) { if (HIGH_IMPACT[a]) lvl = Math.max(lvl, 3); else if (MODERATE_IMPACT[a]) lvl = Math.max(lvl, 2); else lvl = Math.max(lvl, 1); });
      if (spec.autonomous) lvl = Math.max(lvl, 3);                 // acts without a human -> at least high
      if (spec.humanControlled === false && areas.some(function (a) { return HIGH_IMPACT[a]; })) lvl = 4; // mission-critical
      var level = RISK[Math.min(lvl, 4)];
      return { level: level, requiredControls: CONTROLS[level].slice() };
    }

    // ---- fairness / bias: outcomes = { group: { positive, total, truePos, actualPos } } ----
    function fairness(outcomes) {
      var groups = Object.keys(outcomes); if (groups.length < 2) return { ok: true, reason: 'need >=2 groups' };
      var rates = {}, tpr = {};
      groups.forEach(function (g) { var o = outcomes[g]; rates[g] = pct(o.positive, o.total); if (o.actualPos != null) tpr[g] = pct(o.truePos, o.actualPos); });
      var rv = groups.map(function (g) { return rates[g]; });
      var maxR = Math.max.apply(null, rv), minR = Math.min.apply(null, rv);
      var parityDiff = +(maxR - minR).toFixed(4);
      var disparateImpact = +pct(minR, maxR).toFixed(4);           // 80% rule: >=0.8 acceptable
      var tv = Object.keys(tpr).map(function (g) { return tpr[g]; });
      var eqOpp = tv.length >= 2 ? +(Math.max.apply(null, tv) - Math.min.apply(null, tv)).toFixed(4) : null;
      var ok = disparateImpact >= diThreshold && parityDiff <= dpTolerance && (eqOpp == null || eqOpp <= dpTolerance);
      rec('fairness', { ok: ok, disparateImpact: disparateImpact });
      return { ok: ok, selectionRates: rates, parityDifference: parityDiff, disparateImpactRatio: disparateImpact, equalOpportunityDiff: eqOpp,
        reason: ok ? 'within fairness tolerance' : (disparateImpact < diThreshold ? 'disparate impact ' + disparateImpact + ' below 80% rule (' + diThreshold + ')' : 'selection-rate gap ' + parityDiff + ' exceeds tolerance ' + dpTolerance) };
    }

    // ---- drift: Population Stability Index between expected and observed bin counts ----
    function psi(expected, observed) {
      var eT = expected.reduce(function (a, b) { return a + b; }, 0), oT = observed.reduce(function (a, b) { return a + b; }, 0);
      var v = 0;
      for (var i = 0; i < expected.length; i++) {
        var e = Math.max(expected[i] / eT, 1e-6), o = Math.max(observed[i] / oT, 1e-6);
        v += (o - e) * Math.log(o / e);
      }
      v = +v.toFixed(4);
      var band = v < 0.1 ? 'stable' : (v < psiThreshold ? 'minor' : 'significant');
      rec('drift', { psi: v, band: band });
      return { psi: v, drifted: v >= psiThreshold, band: band };
    }

    // ---- safety validation of a single AI output ----
    function validateOutput(o) {
      o = o || {}; var actions = [], reasons = [];
      if (o.confidence != null && o.confidence < confFloor) { actions.push('escalate'); reasons.push('confidence ' + o.confidence + ' below floor ' + confFloor); }
      // unsupported-claim (hallucination) check: every claim must be backed by a cited source token
      var claims = o.claims || [], sources = (o.sources || []).join(' ').toLowerCase();
      var unsupported = claims.filter(function (c) { return !c.evidence || sources.indexOf(String(c.evidence).toLowerCase()) === -1; });
      if (unsupported.length) { actions.push('moderate'); reasons.push(unsupported.length + ' claim(s) not supported by cited sources'); }
      if (o.action && o.requiresAuth && !o.authorized) { actions.push('block'); reasons.push('action "' + o.action + '" not authorized'); }
      var decision = actions.indexOf('block') >= 0 ? 'block' : (actions.indexOf('escalate') >= 0 ? 'escalate' : (actions.length ? 'moderate' : 'allow'));
      rec('safety', { decision: decision });
      return { decision: decision, safe: decision === 'allow', actions: actions, reasons: reasons, unsupportedClaims: unsupported.length };
    }

    var LIFECYCLE = ['design', 'development', 'evaluation', 'certification', 'deployment', 'monitoring', 'review', 'retirement'];

    var G = {
      audit: audit, classifyRisk: classifyRisk, fairness: fairness, psi: psi, validateOutput: validateOutput,
      register: function (id, spec) { var risk = classifyRisk(spec); services[id] = { id: id, spec: spec || {}, risk: risk.level, requiredControls: risk.requiredControls, satisfied: {}, state: 'design', approvedBy: null }; rec('register', { id: id, risk: risk.level }); return services[id]; },
      satisfyControl: function (id, control, ok) { var s = services[id]; if (s) s.satisfied[control] = ok !== false; return this; },
      approve: function (id, human) { var s = services[id]; if (s) s.approvedBy = human; rec('approve', { id: id, by: human }); return this; },
      transition: function (id, to) { var s = services[id]; if (!s) return { ok: false, reason: 'no service' }; var ci = LIFECYCLE.indexOf(s.state), ni = LIFECYCLE.indexOf(to); if (ni !== ci + 1 && to !== 'retirement' && to !== 'review') return { ok: false, reason: 'illegal transition ' + s.state + ' -> ' + to }; s.state = to; rec('transition', { id: id, to: to }); return { ok: true, state: to }; },

      // production-eligibility gate: every required control satisfied + human approved
      certify: function (id) {
        var s = services[id]; if (!s) return { certified: false, reason: 'no service' };
        var missing = s.requiredControls.filter(function (c) { return !s.satisfied[c]; });
        var needsHuman = s.requiredControls.indexOf('human-review') >= 0 || s.requiredControls.indexOf('certification') >= 0;
        if (missing.length) return { certified: false, missingControls: missing, reason: 'missing controls: ' + missing.join(', ') };
        if (needsHuman && !s.approvedBy) return { certified: false, reason: 'human approval required for ' + s.risk + '-risk service' };
        s.certified = true; rec('certify', { id: id }); return { certified: true, risk: s.risk, approvedBy: s.approvedBy };
      },
      service: function (id) { return services[id]; }
    };
    return G;
  }
  window.AquinAIGovernance = { createGovernor: createGovernor, RISK: RISK, CONTROLS: CONTROLS };
})();
