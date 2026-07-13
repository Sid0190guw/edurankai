/*
 * aquin-metacognition.js — Meta-Cognition & Reflective Intelligence Engine
 * (AES-100, Vol II, Ch 56). The layer that makes a powerful reasoner HONEST about
 * the limits of its own reasoning. It does not produce educational conclusions —
 * it examines the conclusions the other engines produce and asks:
 *
 *   "How confident should I actually be? What did I assume? What am I NOT seeing?
 *    Is there a better way to reason about this? What did I get wrong before?"
 *
 * Five reflective functions, each engineered as a guarantee:
 *  1) CONFIDENCE CALIBRATION — a claim's stated confidence is checked against the
 *     evidence behind it; overconfidence (high confidence, thin/conflicting
 *     evidence) is DOWN-CALIBRATED, not passed through. It reports calibrated
 *     confidence + why.
 *  2) ASSUMPTION ANALYSIS — surfaces the unstated assumptions a conclusion rests
 *     on, and flags which are unverified (an unverified load-bearing assumption is
 *     a risk, not a fact).
 *  3) BLIND-SPOT DETECTION — names what the reasoning did NOT consider
 *     (alternative causes, missing evidence types, populations not represented).
 *  4) ALTERNATIVE STRATEGIES — when a reasoning approach underperforms, it
 *     proposes other approaches instead of repeating the failing one.
 *  5) REFLECTIVE MEMORY — records past reasoning + how it actually turned out, so
 *     miscalibration is LEARNED FROM (calibration bias adapts toward truth).
 *
 * Constitutional stance: meta-cognition may lower confidence, add caveats, and
 * request more evidence, but it NEVER manufactures certainty and NEVER changes an
 * educational conclusion's content — it changes how much we should TRUST it.
 *
 * HONEST SCOPE: pure reasoning-about-reasoning over supplied claim/evidence
 * structures; it sits above the Cognition (Ch/aquin-cognition) and Consistency
 * engines and consumes their outputs. No model weights here — it is the auditor,
 * not the oracle.
 */
(function () {
  // load-bearing assumption keywords that are commonly left implicit
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  function createMetaCognition(cfg) {
    cfg = cfg || {};
    var reflections = [];                 // reflective memory: claim -> actual outcome
    var provenance = [];
    // learned calibration bias: how much this reasoner has historically been off
    var bias = { overconfidence: 0, samples: 0 };
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // 1) CONFIDENCE CALIBRATION
    // evidence: [{ supports:bool, strength:0..1, independent:bool }]
    function calibrate(claim) {
      claim = claim || {};
      var stated = claim.confidence != null ? clamp01(claim.confidence) : 0.5;
      var ev = claim.evidence || [];
      var support = ev.filter(function (e) { return e.supports !== false; });
      var against = ev.filter(function (e) { return e.supports === false; });
      var strength = support.reduce(function (s, e) { return s + (e.strength != null ? e.strength : 0.5); }, 0);
      var independents = support.filter(function (e) { return e.independent; }).length;

      // evidentiary ceiling: what the evidence can actually justify
      var ceiling;
      if (support.length === 0) ceiling = 0.2;                 // no support -> a guess
      else {
        ceiling = clamp01(0.35 + 0.12 * strength + 0.1 * independents);
        if (against.length) ceiling = clamp01(ceiling - 0.15 * against.length); // conflicting evidence
      }
      // apply learned overconfidence bias (from reflective memory)
      var biasAdj = bias.samples >= 3 ? (bias.overconfidence / bias.samples) : 0;
      var calibrated = clamp01(Math.min(stated, ceiling) - biasAdj);
      var overconfident = stated - calibrated > 0.15;

      var reasons = [];
      if (support.length === 0) reasons.push('no supporting evidence — confidence capped to a guess');
      if (against.length) reasons.push(against.length + ' piece(s) of conflicting evidence');
      if (independents < 2 && support.length) reasons.push('fewer than 2 independent sources');
      if (biasAdj > 0.02) reasons.push('history shows this reasoner runs overconfident (bias -' + biasAdj.toFixed(2) + ')');
      if (!reasons.length) reasons.push('evidence supports the stated confidence');

      rec('calibrate', { stated: stated, calibrated: calibrated, overconfident: overconfident });
      return {
        stated: +stated.toFixed(3), calibrated: +calibrated.toFixed(3),
        overconfident: overconfident, evidentiaryCeiling: +ceiling.toFixed(3),
        supporting: support.length, conflicting: against.length, independentSources: independents,
        reason: reasons.join('; ')
      };
    }

    // 2) ASSUMPTION ANALYSIS — surface + flag unverified load-bearing assumptions
    // claim.assumptions: [{ text, verified:bool, loadBearing:bool }]
    function assumptions(claim) {
      var list = (claim && claim.assumptions) || [];
      var unverified = list.filter(function (a) { return !a.verified; });
      var risky = unverified.filter(function (a) { return a.loadBearing; });
      rec('assumptions', { total: list.length, unverified: unverified.length, risky: risky.length });
      return {
        total: list.length,
        unverified: unverified.map(function (a) { return a.text; }),
        loadBearingUnverified: risky.map(function (a) { return a.text; }),
        // a conclusion resting on an unverified load-bearing assumption is a RISK, not a fact
        sound: risky.length === 0,
        note: risky.length ? 'conclusion depends on unverified assumption(s) — treat as provisional' : 'no unverified load-bearing assumptions'
      };
    }

    // 3) BLIND-SPOT DETECTION — what the reasoning did NOT consider
    // considered: string[] of evidence/factor types actually used
    // expected: string[] of what SHOULD be considered for this decision type
    function blindSpots(claim) {
      claim = claim || {};
      var considered = (claim.considered || []).map(String);
      var expected = (claim.expected || []).map(String);
      var missing = expected.filter(function (e) { return considered.indexOf(e) < 0; });
      // population coverage blind spot
      var pop = claim.population || {};
      var popGaps = [];
      if (pop.cohortSize != null && pop.cohortSize < (cfg.minPopulation || 30)) popGaps.push('small cohort (' + pop.cohortSize + ')');
      if (pop.singleContext) popGaps.push('single context — may not transfer');
      rec('blind-spots', { missing: missing.length, popGaps: popGaps.length });
      return {
        unconsideredFactors: missing,
        populationGaps: popGaps,
        hasBlindSpots: missing.length > 0 || popGaps.length > 0,
        note: (missing.length || popGaps.length) ? 'reasoning did not consider: ' + missing.concat(popGaps).join(', ') : 'no obvious blind spots for this decision type'
      };
    }

    // 4) ALTERNATIVE STRATEGIES — when an approach underperforms, propose others
    // attempt: { strategy, outcome:0..1 }, catalog: [strategy names]
    function alternatives(attempt, catalog) {
      attempt = attempt || {};
      catalog = catalog || [];
      var underperformed = (attempt.outcome != null ? attempt.outcome : 1) < (cfg.successThreshold || 0.5);
      var others = catalog.filter(function (s) { return s !== attempt.strategy; });
      rec('alternatives', { strategy: attempt.strategy, underperformed: underperformed, proposed: others.length });
      return {
        underperformed: underperformed,
        // do NOT repeat a failing approach — propose different ones
        proposed: underperformed ? others : [],
        keepCurrent: !underperformed,
        note: underperformed
          ? 'approach "' + attempt.strategy + '" underperformed (' + attempt.outcome + ') — try: ' + (others.join(', ') || 'no alternatives in catalog')
          : 'current approach is performing; keep it'
      };
    }

    // 5) REFLECTIVE MEMORY — record how a past claim actually turned out; learn bias
    // predicted: the confidence we stated; correct: did it turn out true?
    function reflect(entry) {
      entry = entry || {};
      var predicted = clamp01(entry.predictedConfidence != null ? entry.predictedConfidence : 0.5);
      var actual = entry.correct ? 1 : 0;
      var error = predicted - actual;              // >0 means we were overconfident
      reflections.push({ topic: entry.topic || null, predicted: predicted, correct: !!entry.correct, error: error, at: Date.now() });
      // update learned overconfidence bias only from confident-but-wrong / calibrated hits
      bias.overconfidence += Math.max(0, error);
      bias.samples += 1;
      rec('reflect', { topic: entry.topic, predicted: predicted, correct: !!entry.correct, error: +error.toFixed(3) });
      return {
        recorded: reflections.length,
        thisError: +error.toFixed(3),
        learnedOverconfidence: bias.samples >= 3 ? +(bias.overconfidence / bias.samples).toFixed(3) : 0,
        note: bias.samples < 3 ? 'gathering reflections before adjusting calibration' : 'calibration now adjusts for measured overconfidence'
      };
    }

    // full reflective review of one claim — the auditor's report
    function review(claim, opts) {
      opts = opts || {};
      var cal = calibrate(claim);
      var asm = assumptions(claim);
      var bs = blindSpots(claim);
      var trustworthy = !cal.overconfident && asm.sound && !bs.hasBlindSpots;
      return {
        calibration: cal,
        assumptions: asm,
        blindSpots: bs,
        alternatives: opts.attempt ? alternatives(opts.attempt, opts.catalog) : null,
        // the meta-verdict: never certainty, always calibrated trust
        verdict: trustworthy ? 'trustworthy-as-stated' : 'trust-with-caveats',
        caveats: [].concat(
          cal.overconfident ? ['down-calibrated confidence to ' + cal.calibrated] : [],
          asm.sound ? [] : ['unverified load-bearing assumption(s)'],
          bs.hasBlindSpots ? ['blind spots present'] : []
        )
      };
    }

    return {
      provenance: provenance,
      calibrate: calibrate,
      assumptions: assumptions,
      blindSpots: blindSpots,
      alternatives: alternatives,
      reflect: reflect,
      review: review,
      reflections: function () { return reflections.slice(); },
      calibrationBias: function () { return { overconfidence: +bias.overconfidence.toFixed(3), samples: bias.samples, adjustment: bias.samples >= 3 ? +(bias.overconfidence / bias.samples).toFixed(3) : 0 }; }
    };
  }

  window.AquinMetaCognition = { createMetaCognition: createMetaCognition };
})();
