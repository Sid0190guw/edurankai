/*
 * aquin-research.js — Autonomous Educational Research Engine (AES-001, Ch 16).
 * AquinTutor doesn't only consume research — it performs it, under constitution.
 * A governed research lifecycle over the engines already built:
 *
 *   identify gaps (Concept graph) -> construct competing hypotheses (epistemic
 *   diversity) -> plan/execute experiments (Simulation Engine, isolated worlds)
 *   -> critically evaluate -> VERIFY before evolution -> integrate (governed).
 *
 * The single most important safety property, proven in the tests: no research
 * conclusion modifies Educational Truth just because computation produced a
 * favourable result. A finding that would contradict existing Truth is REJECTED
 * (Research Verification), exactly like the Ingestion Pipeline quarantines a bad
 * source. Findings integrate only through the governed Consistency gate.
 *
 * Composes: Concept graph (gaps), Simulation (experiments), Consistency (truth
 * gate). HONEST SCOPE: real literature mining, lab automation, and human-in-the-
 * loop peer review are named phases; this brick implements the computational
 * research loop (gap->hypothesis->simulate->verify->integrate) end-to-end.
 */
(function () {
  function createResearchEngine(cfg) {
    cfg = cfg || {};
    var knowledge = cfg.knowledge, simulation = cfg.simulation, consistency = cfg.consistency;
    var provenance = [];
    var stats = { gaps: 0, hypotheses: 0, integrated: 0, rejected: 0 };
    function rec(phase, detail) { provenance.push({ phase: phase, at: Date.now(), detail: detail || null }); }

    var R = {
      provenance: provenance,

      // PHASE 1 — Knowledge Gap Identification (over the Concept graph)
      identifyGaps: function () {
        var gaps = [];
        Object.keys(knowledge.nodes).forEach(function (id) {
          var c = knowledge.get(id), d = c.dimensions || {};
          if (!d.mathematical) gaps.push({ type: 'missing-formal-model', concept: id });
          if (d.misconception && d.misconception.items) d.misconception.items.forEach(function (m) { gaps.push({ type: 'unresolved-misconception', concept: id, misconceptionId: m.id }); });
          if (knowledge.relations(id).length === 0 && knowledge.relations(id, { incoming: true }).length === 0) gaps.push({ type: 'isolated-concept', concept: id });
        });
        stats.gaps = gaps.length; rec('gap-identification', { found: gaps.length });
        return gaps;
      },

      // PHASE 2 — Hypothesis Construction (multiple, competing — no premature convergence)
      hypothesize: function (gap) {
        var hyps = [];
        if (gap.type === 'unresolved-misconception') {
          ['reconstruct', 'reinforce', 'assess'].forEach(function (action) { hyps.push({ id: 'h_' + Math.random().toString(36).slice(2, 7), gap: gap, kind: 'pedagogy', action: action, confidence: null }); });
        } else if (gap.type === 'missing-formal-model') {
          hyps.push({ id: 'h_' + Math.random().toString(36).slice(2, 7), gap: gap, kind: 'truth', proposal: { subject: gap.concept + '.formal-model', value: 'has-quantitative-model', domain: ['general'], provenance: { source: 'autonomous-research' } }, confidence: 0.5 });
        } else {
          hyps.push({ id: 'h_' + Math.random().toString(36).slice(2, 7), gap: gap, kind: 'structural', confidence: 0.4 });
        }
        stats.hypotheses += hyps.length; rec('hypothesis-construction', { gap: gap.type, hypotheses: hyps.length });
        return hyps;
      },

      // PHASE 3+4+5 — Evidence Planning + Experimental Design + Execution
      // (pedagogy hypotheses are tested experimentally via the Simulation Engine)
      experiment: function (hypotheses, testCtx) {
        var pedag = hypotheses.filter(function (h) { return h.kind === 'pedagogy'; });
        if (pedag.length && simulation && testCtx && testCtx.learner) {
          var actions = pedag.map(function (h) { return h.action; });
          var pf = simulation.parallelFutures(testCtx.learner, actions, testCtx.conceptId, { misconceptionId: testCtx.misconceptionId });
          pedag.forEach(function (h) { var f = pf.futures.filter(function (x) { return x.action === h.action; })[0]; h.confidence = f ? +(0.5 + f.delta).toFixed(3) : 0.3; h.evidence = f || null; });
          rec('experiment', { tested: actions.length, best: pf.best && pf.best.action });
          return { best: pf.best, hypotheses: hypotheses };
        }
        rec('experiment', { tested: 0, note: 'no experimental hypotheses' });
        return { best: null, hypotheses: hypotheses };
      },

      // PHASE 6 — Critical Evaluation (rank; keep alternatives visible)
      evaluate: function (hypotheses) {
        var ranked = hypotheses.slice().sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); });
        rec('critical-evaluation', { ranked: ranked.map(function (h) { return (h.action || h.kind) + ':' + h.confidence; }) });
        return ranked;
      },

      // PHASE 7 — VERIFY before evolution, then governed Knowledge Integration
      verifyAndIntegrate: function (finding) {
        if (finding.kind === 'truth' && finding.proposal) {
          // Research Verification: a proposal that contradicts existing Truth is REJECTED
          var sandbox = new (consistency.constructor)();
          var existing = (consistency.assertions || []).slice();
          var threw = null;
          try { existing.concat([finding.proposal]).forEach(function (a) { sandbox.add(a); }); var chk = sandbox.check(); if (chk.hardViolations.length) threw = chk.hardViolations[0].detail; }
          catch (e) { threw = String(e && e.message || e); }
          if (threw) { stats.rejected++; rec('research-verification', { status: 'rejected', reason: threw }); return { status: 'rejected', reason: 'contradicts Educational Truth: ' + threw }; }
          consistency.add(finding.proposal); stats.integrated++;
          rec('knowledge-integration', { status: 'integrated', subject: finding.proposal.subject });
          return { status: 'integrated', subject: finding.proposal.subject };
        }
        // pedagogy findings become methodology recommendations, not Truth edits
        stats.integrated++; rec('knowledge-integration', { status: 'recommended', action: finding.action });
        return { status: 'recommended', action: finding.action, confidence: finding.confidence };
      },

      // Meta-Research: evaluate the research process itself
      metaResearch: function () { return { gapsIdentified: stats.gaps, hypothesesTested: stats.hypotheses, integrated: stats.integrated, rejected: stats.rejected, integrationRate: stats.hypotheses ? +(stats.integrated / stats.hypotheses).toFixed(2) : 0 }; }
    };
    return R;
  }
  window.AquinResearch = { createResearchEngine: createResearchEngine };
})();
