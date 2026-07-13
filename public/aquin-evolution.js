/*
 * aquin-evolution.js — Educational Self-Evolution Engine (AES-100, Vol II, Ch 48)
 * + Educational Impact Evaluation (Ch 49). The platform improves ITSELF — but
 * under two hard, engineered guarantees:
 *
 *  1) (Ch 48) It may improve IMPLEMENTATION (optimization / improvement) but SHALL
 *     NOT autonomously change CONSTITUTIONAL principles (Educational Truth,
 *     Governance, learner rights, safety). A constitutional change is OUT OF THIS
 *     ENGINE'S AUTHORITY and is rejected — it requires explicit human governance.
 *  2) (Ch 49) A change is accepted only if it improves EDUCATIONAL OUTCOMES, not
 *     technical/usage metrics. A change that raises engagement but LOWERS concept
 *     mastery is REJECTED. "Did this improve education?" is the only question.
 *
 * Governed pipeline: propose (classify) -> experiment (isolated) -> impact
 * evaluate -> human review (AI proposes, humans approve) -> progressive deploy ->
 * rollback available. Full evolution provenance.
 *
 * HONEST SCOPE: the experiment harness here compares supplied outcome metrics;
 * real isolated Simulation-World experiments plug in behind the same interface.
 */
(function () {
  var CATEGORIES = ['optimization', 'improvement', 'constitutional'];
  // touching any of these = constitutional -> beyond the engine's authority
  var CONSTITUTIONAL = /\b(truth|governance|learner rights?|constitution|proctoring|privacy policy|educational genome|safety principle)\b/i;

  function createEvolutionEngine(cfg) {
    cfg = cfg || {};
    var approve = cfg.approve || function () { return false; };   // human review; default deny
    var proposals = {}; var provenance = []; var seq = 0;
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function classify(change) {
      if (change.category && CATEGORIES.indexOf(change.category) >= 0) {
        if (change.category === 'constitutional') return 'constitutional';
      }
      if (CONSTITUTIONAL.test((change.target || '') + ' ' + (change.description || ''))) return 'constitutional';
      return change.changesBehaviour ? 'improvement' : 'optimization';
    }

    // Ch 49 — Impact Evaluation: educational outcome dominates usage metrics
    function impact(baseline, candidate) {
      baseline = baseline || {}; candidate = candidate || {};
      var dMastery = (candidate.mastery || 0) - (baseline.mastery || 0);
      var dMisc = (candidate.misconception || 0) - (baseline.misconception || 0);
      var dEng = (candidate.engagement || 0) - (baseline.engagement || 0);
      var dLatency = (candidate.latency || 0) - (baseline.latency || 0);
      if (dMastery < -0.01) return { betterEducation: false, reason: 'concept mastery decreased' + (dEng > 0 ? ' despite higher engagement (usage != learning)' : '') };
      if (dMisc > 0.05) return { betterEducation: false, reason: 'misconception rate increased' };
      if (dMastery >= 0.01) return { betterEducation: true, reason: 'concept mastery improved by ' + dMastery.toFixed(3) };
      if (Math.abs(dMastery) <= 0.01 && dLatency < 0) return { betterEducation: true, reason: 'education preserved, efficiency improved (latency ' + dLatency + ')' };
      return { betterEducation: false, reason: 'no measurable educational benefit' };
    }

    var E = {
      CATEGORIES: CATEGORIES, provenance: provenance, impact: impact,

      propose: function (change) {
        var id = change.id || ('evo_' + (++seq).toString(36));
        var category = classify(change);
        if (category === 'constitutional') {
          proposals[id] = { id: id, category: category, status: 'rejected-constitutional' };
          rec('propose', { id: id, category: category, status: 'rejected-constitutional' });
          return { id: id, category: category, status: 'rejected', reason: 'Constitutional change (Truth/Governance/rights/safety) is out of the Self-Evolution Engine\'s authority; it requires explicit human governance.' };
        }
        proposals[id] = { id: id, category: category, change: change, status: 'proposed' };
        rec('propose', { id: id, category: category });
        return { id: id, category: category, status: 'proposed' };
      },

      // isolated experiment + impact evaluation
      experiment: function (id, outcomes) {
        var p = proposals[id]; if (!p || p.status !== 'proposed') return { ok: false, reason: 'not a live proposal' };
        var ev = impact(outcomes.baseline, outcomes.candidate);
        p.impact = ev; p.status = ev.betterEducation ? 'verified' : 'rejected-impact';
        rec('experiment', { id: id, betterEducation: ev.betterEducation, reason: ev.reason });
        return { id: id, status: p.status, impact: ev };
      },

      // AI proposes; humans approve (deploy requires human review)
      deploy: function (id) {
        var p = proposals[id]; if (!p || p.status !== 'verified') return { ok: false, reason: 'must be verified before deploy' };
        if (!approve(p)) { p.status = 'awaiting-approval'; rec('review', { id: id, approved: false }); return { ok: false, status: 'awaiting-approval', reason: 'human review did not approve' }; }
        p.status = 'deployed'; p.stages = ['research', 'developer', 'pilot', 'regional', 'global']; rec('deploy', { id: id, progressive: p.stages });
        return { ok: true, status: 'deployed', progressive: p.stages };
      },
      rollback: function (id, reason) { var p = proposals[id]; if (!p) return { ok: false }; p.status = 'rolled-back'; rec('rollback', { id: id, reason: reason || 'regression' }); return { ok: true, status: 'rolled-back' }; },
      status: function (id) { return proposals[id] && proposals[id].status; }
    };
    return E;
  }
  window.AquinEvolution = { CATEGORIES: CATEGORIES, createEvolutionEngine: createEvolutionEngine };
})();
