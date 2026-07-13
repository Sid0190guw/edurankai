/*
 * aquin-collective.js — Collective Educational Intelligence Engine (AES-100,
 * Vol II, Ch 47). "One learner teaches the AI; millions of learners improve
 * education itself." It discovers educational knowledge that emerges only across
 * populations — which teaching strategies work, where curricula produce
 * misconceptions, which explanations perform best — and turns it into evidence.
 *
 * Privacy is engineered IN, not bolted on:
 *  - It reasons ONLY over AGGREGATES. An observation carrying individual identity
 *    (learnerId / name / email) is REJECTED by design.
 *  - k-ANONYMITY: any pattern backed by fewer than `minCohort` learners is
 *    SUPPRESSED — never reported.
 *  - Genome proposals are CANDIDATES requiring human governance; the engine
 *    NEVER autonomously changes Educational Truth or curriculum.
 *
 * Proven in tests: individual data rejected; small cohort suppressed; strategy
 * discovery ranks by aggregate mastery with evidence + cohort size; curriculum
 * weakness surfaced; genome proposal is human-governed. HONEST SCOPE: differential
 * privacy / federated learning / secure aggregation are the deeper techniques
 * that plug in behind the same aggregate interface.
 */
(function () {
  var IDENTITY_FIELDS = ['learnerId', 'name', 'email', 'phone', 'deviceId', 'studentId'];

  function createCollective(cfg) {
    cfg = cfg || {};
    var minCohort = cfg.minCohort || 5;      // k-anonymity threshold
    var obs = [];                            // aggregate observations only
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function hasIdentity(o) { return IDENTITY_FIELDS.some(function (f) { return o[f] != null; }); }

    var C = {
      minCohort: minCohort, provenance: provenance,

      // ingest an AGGREGATE observation (never individual). Privacy by design.
      ingest: function (o) {
        if (!o || !o.concept || !o.strategy || o.cohortSize == null) return { ok: false, reason: 'need aggregate {concept, strategy, cohortSize, avgMastery, ...}' };
        if (hasIdentity(o)) { rec('reject-identity', { concept: o.concept }); return { ok: false, reason: 'individual identity is not permitted — Collective Intelligence reasons over aggregates only' }; }
        obs.push({ concept: o.concept, strategy: o.strategy, cohortSize: o.cohortSize, avgMastery: o.avgMastery != null ? o.avgMastery : null, avgRetention: o.avgRetention != null ? o.avgRetention : null, misconceptionRate: o.misconceptionRate != null ? o.misconceptionRate : null, explanation: o.explanation || null });
        rec('ingest', { concept: o.concept, strategy: o.strategy, cohort: o.cohortSize });
        return { ok: true };
      },

      // discover which teaching strategy yields better mastery (k-anonymity applied)
      compareStrategies: function (concept) {
        var byStrat = {};
        obs.filter(function (o) { return o.concept === concept; }).forEach(function (o) { var s = (byStrat[o.strategy] = byStrat[o.strategy] || { strategy: o.strategy, cohort: 0, masterySum: 0, n: 0 }); s.cohort += o.cohortSize; if (o.avgMastery != null) { s.masterySum += o.avgMastery * o.cohortSize; s.n += o.cohortSize; } });
        var ranked = Object.keys(byStrat).map(function (k) { var s = byStrat[k]; return { strategy: s.strategy, cohort: s.cohort, avgMastery: s.n ? +(s.masterySum / s.n).toFixed(3) : null }; })
          .filter(function (s) { return s.cohort >= minCohort; })          // k-anonymity: suppress small cohorts
          .sort(function (a, b) { return (b.avgMastery || 0) - (a.avgMastery || 0); });
        var suppressed = Object.keys(byStrat).filter(function (k) { return byStrat[k].cohort < minCohort; });
        rec('compare-strategies', { concept: concept, ranked: ranked.length, suppressed: suppressed.length });
        return { concept: concept, ranked: ranked, best: ranked[0] || null, suppressedForPrivacy: suppressed, evidence: ranked.length >= 2 ? (ranked[0].strategy + ' ' + ranked[0].avgMastery + ' vs ' + ranked[ranked.length - 1].strategy + ' ' + ranked[ranked.length - 1].avgMastery) : 'insufficient comparison' };
      },

      // curriculum weaknesses: concepts with high misconception rate (k-anonymity)
      curriculumWeaknesses: function (threshold) {
        threshold = threshold != null ? threshold : 0.2;
        var byConcept = {};
        obs.forEach(function (o) { if (o.misconceptionRate == null) return; var c = (byConcept[o.concept] = byConcept[o.concept] || { cohort: 0, sum: 0, n: 0 }); c.cohort += o.cohortSize; c.sum += o.misconceptionRate * o.cohortSize; c.n += o.cohortSize; });
        return Object.keys(byConcept).map(function (k) { var c = byConcept[k]; return { concept: k, misconceptionRate: +(c.sum / c.n).toFixed(3), cohort: c.cohort }; })
          .filter(function (c) { return c.cohort >= minCohort && c.misconceptionRate >= threshold; })
          .sort(function (a, b) { return b.misconceptionRate - a.misconceptionRate; });
      },

      // a validated collective finding becomes a GENOME CANDIDATE — human-governed
      proposeGenomeUpdate: function (finding) {
        rec('genome-proposal', { finding: finding && finding.summary });
        return { candidate: finding, status: 'candidate', requiresHumanGovernance: true, autoApplied: false, pathway: ['replication', 'independent-verification', 'expert-review', 'governance-approval'] };
      }
    };
    return C;
  }
  window.AquinCollective = { createCollective: createCollective };
})();
