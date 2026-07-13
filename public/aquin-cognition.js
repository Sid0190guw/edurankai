/*
 * aquin-cognition.js — Educational Cognitive Execution Engine (AES-001, Ch 12).
 * The reasoning core: reasoning is a PIPELINE, not a model invocation. It turns
 * activated Educational Memory into a governed Educational Decision + a
 * Verification Contract, through the constitutional Cognitive Pipeline:
 *
 *   context-construction -> semantic-interpretation -> hypothesis-generation ->
 *   collaborative-deliberation -> simulation -> decision-synthesis ->
 *   verification-preparation
 *
 * Multiple REASONING MODALITIES (symbolic / graph / neural / probabilistic /
 * constraint) are equal constitutional participants — none is privileged. It
 * composes the engines already built: Memory (cognitive material), the Learner
 * Intelligence Core (hypotheses + adaptation), Concept graph (prerequisites),
 * and Consistency (truth). Output preserves alternatives, confidence, an
 * Educational-Wisdom note, and full provenance; it is deterministic.
 *
 * HONEST SCOPE: modalities are pluggable functions — a real symbolic prover,
 * GNN, or foundation model plugs in here. The reference modalities compute
 * genuine signals (prereq satisfaction, learner confidence) so the pipeline is
 * testable end-to-end; they are not LLMs.
 */
(function () {
  function createEngine(cfg) {
    cfg = cfg || {};
    var modalities = {};
    var E = {
      registerModality: function (name, fn) { modalities[name] = fn; return this; },
      modalities: function () { return Object.keys(modalities); },

      run: function (ctx) {
        ctx = ctx || {};
        if (!ctx.objectives || !ctx.objectives.length) throw new Error('cognition requires at least one Educational Objective');
        if (!ctx.learner) throw new Error('cognition requires a learner model (Runtime Domain)');
        var prov = [];
        function phase(name, detail) { prov.push({ phase: name, detail: detail || null }); }
        var obj = ctx.objectives[0];
        var context = ctx.context || 'default';
        var target = obj.targetMastery != null ? obj.targetMastery : 0.75;

        // 1) CONTEXT CONSTRUCTION — assemble working memory + objectives
        var workingConcepts = ctx.memory ? ctx.memory.layers.working : [];
        phase('context-construction', { objectives: ctx.objectives.length, workingConcepts: workingConcepts.length });

        // 2) SEMANTIC INTERPRETATION — activated reality -> conceptual structures (+truth check)
        var truthConsistent = true;
        if (ctx.consistency) { var chk = ctx.consistency.check(); truthConsistent = chk.ok; }
        phase('semantic-interpretation', { interpreted: workingConcepts.length, truthConsistent: truthConsistent });

        // 3) HYPOTHESIS GENERATION — primary from the learner's adaptation, plus alternatives (no premature commit)
        var primary = ctx.learner.adapt({ conceptId: obj.conceptId, targetMastery: target, context: context });
        var hypotheses = [{ action: primary.action, rationale: primary.rationale, utility: 1.0 }];
        ['assess', 'reinforce', 'advance', 'reconstruct', 'revise-prerequisite'].forEach(function (alt) { if (alt !== primary.action) hypotheses.push({ action: alt, rationale: 'alternative educational strategy', utility: 0.4 }); });
        phase('hypothesis-generation', { count: hypotheses.length, primary: primary.action });

        // 4) COLLABORATIVE DELIBERATION — every modality contributes; none dominates
        var contributions = [], confSum = 0, confN = 0;
        var delibCtx = { ctx: ctx, objective: obj, primary: primary, hypotheses: hypotheses, understanding: ctx.learner.understanding(obj.conceptId, context) };
        Object.keys(modalities).forEach(function (name) {
          var r = modalities[name](delibCtx) || {};
          contributions.push({ modality: name, confidence: r.confidence, note: r.note || '' });
          if (typeof r.confidence === 'number') { confSum += r.confidence; confN++; }
        });
        var combinedConfidence = confN ? +(confSum / confN).toFixed(3) : 0.5;
        phase('collaborative-deliberation', { modalities: contributions.length, combinedConfidence: combinedConfidence });

        // 5) SIMULATION — predict the educational future of the primary hypothesis
        var u = delibCtx.understanding;
        var predicted = primary.action === 'advance' ? 'objective already met (mastery ' + u.overall.mastery + ')' : ('expected mastery to rise from ' + u.overall.mastery + ' toward ' + target);
        phase('simulation', { predicted: predicted });

        // 6) DECISION SYNTHESIS — integrate, preserve alternatives, apply Educational Wisdom
        var wisdom = primary.action === 'reconstruct' ? 'prioritize conceptual reconstruction over repetition (long-term learning > short-term score)'
          : primary.action === 'revise-prerequisite' ? 'recover foundations before advancing (avoid cognitive overload)'
          : 'aligned with long-term learning objectives';
        var decision = {
          conceptId: obj.conceptId, action: primary.action, rationale: primary.rationale,
          utility: hypotheses[0].utility, confidence: combinedConfidence,
          alternatives: hypotheses.slice(1).map(function (h) { return h.action; }),
          authority: 'assisted', wisdom: wisdom, visualization: primary.visualization, tutorDepth: primary.tutorDepth
        };
        phase('decision-synthesis', { action: decision.action, confidence: combinedConfidence, alternativesPreserved: decision.alternatives.length });

        // 7) VERIFICATION PREPARATION — the contract Execution will be held to
        var vc = {
          conceptId: obj.conceptId,
          expected: { direction: decision.action === 'advance' ? 'maintain' : 'increase' },
          evidenceRequirements: ['concept-application', 'explanation-ability', 'transfer'],
          successCriteria: 'overall mastery >= ' + target + ' with adequate confidence'
        };
        phase('verification-preparation', vc);

        return {
          decision: decision, verificationContract: vc, contributions: contributions,
          provenance: prov, health: Math.round(combinedConfidence * 100), truthConsistent: truthConsistent
        };
      }
    };
    return E;
  }
  window.AquinCognition = { createEngine: createEngine };
})();
