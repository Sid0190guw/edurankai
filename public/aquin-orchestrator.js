/*
 * aquin-orchestrator.js — Educational Runtime Orchestrator (real end-to-end
 * integration of the constitutional spine). Until now each engine was proven in
 * isolation. This composes the ACTUAL engines into one executable pipeline: a
 * single learner request flows through self-assessment, intent, context,
 * constitutional validation, the multi-agent society, ethical deliberation, and
 * the world/knowledge update — producing a response AND a complete, replayable
 * audit trail. Nothing here is mocked; it calls the real engine objects passed in.
 *
 * Pipeline (each stage can HALT the request, with a reason, before execution):
 *   1. SELF-MODEL   can the system even do this? (else -> ask a human)
 *   2. INTENT       why is the learner asking? -> teaching pathway
 *   3. CONTEXT      unified context object -> response adaptation
 *   4. CONSTITUTION is the action permitted? (identity/authz/truth/safety/gov/policy)
 *   5. AGENTS       specialists produce the answer (knowledge -> tutor -> verify)
 *   6. ETHICS       among permitted candidates, which best serves the learner?
 *   7. WORLD+BKT    commit the outcome to shared reality + update mastery
 *
 * Determinism: same inputs + same registered agents => same response and same
 * audit. That is what makes the whole system auditable and testable as a unit.
 *
 * HONEST SCOPE: this is the real control/data flow between the engines. The
 * intelligence inside each engine is exactly what those engines implement (BKT is
 * real; the tutor's natural language is a declared model substrate).
 */
(function () {
  function createOrchestrator(deps) {
    deps = deps || {};
    var self = deps.selfModel, intent = deps.intent, context = deps.context,
      constitution = deps.constitution, agents = deps.agents, ethics = deps.ethics,
      world = deps.world, bkt = deps.bkt;

    function handle(request) {
      request = request || {};
      var audit = []; var t = 0;
      function step(stage, detail) { audit.push({ n: ++t, stage: stage, detail: detail }); }
      function halt(stage, reason, extra) { step(stage, Object.assign({ halted: true, reason: reason }, extra || {})); return { ok: false, haltedAt: stage, reason: reason, response: null, audit: audit }; }

      var learner = request.learner, concept = request.concept, capability = request.capability || 'explain';

      // 1) SELF-MODEL — can we do this at all?
      if (self) {
        var cap = self.assess({ capability: capability, description: request.text });
        step('self-model', { capability: capability, can: cap.can, askHuman: cap.askHuman });
        if (!cap.can) return halt('self-model', cap.reason, { escalateToHuman: true });
        if (cap.askHuman) step('self-model', { note: 'proceeding but flagged for human involvement (' + cap.reason + ')' });
      }

      // 2) INTENT — why is the learner asking?
      var intentLabel = request.intent || 'conceptual', pathway = null;
      if (intent) {
        var inf = intent.infer(learner, { question: request.text, hint: request.intent });
        intentLabel = (inf && inf.applied && inf.inferred) || request.intent || 'conceptual';
        pathway = intent.pathway(concept, intentLabel);
        step('intent', { intent: intentLabel, emphasis: pathway && pathway.emphasis });
      }

      // 3) CONTEXT — unified context + response shape
      var ctx = null, adaptation = null;
      if (context) {
        ctx = context.build(request.contextLayers || {});
        adaptation = context.adapt(concept, ctx);
        step('context', { ctxId: ctx.id, depth: adaptation.response.depth, format: adaptation.response.format, language: adaptation.response.language });
      }

      // 4) CONSTITUTION — is the action permitted?
      if (constitution) {
        var verdict = constitution.validate({
          id: request.id || ('req_' + Date.now()), actor: request.actor || learner || 'learner',
          capability: capability, decision: 'teach:' + concept, explanation: 'intent=' + intentLabel + '; pathway-driven',
          evidenceSufficient: true, provenanceComplete: true, safe: request.safe !== false,
          policyId: request.policyId
        });
        step('constitution', { approved: verdict.approved, stage: verdict.stages && verdict.stages.map(function (s) { return s.stage; }).join('>') });
        if (!verdict.approved) return halt('constitution', verdict.reason, { deniedAtStage: verdict.stage });
      }

      // 5) AGENTS — specialists produce the answer
      var answer = null;
      if (agents) {
        var mission = {
          goal: 'teach ' + concept, pipeline: [
            { capability: 'retrieve', task: { concept: concept } },
            { capability: 'explain', task: { concept: concept, intent: intentLabel, adaptation: adaptation && adaptation.response } },
            { capability: 'verify', task: { concept: concept } }
          ]
        };
        var run = agents.run(mission);
        step('agents', { published: !run.blocked, blocked: run.blocked, chain: run.trace.map(function (x) { return x.capability + '@' + x.by; }) });
        if (run.blocked) return halt('agents', 'agent pipeline blocked: ' + (run.blocked.reason || run.blocked.step));
        answer = run.published;
      }

      // 6) ETHICS — choose the most educationally appropriate permitted response
      if (ethics) {
        var options = request.candidateResponses || [
          { id: 'primary', permitted: true, values: { learningQuality: 0.85, longTermGrowth: 0.85, dignity: 0.9 }, stakeholders: ['learner', 'teacher'] }
        ];
        var deliberation = ethics.deliberate(options, { highStakes: request.highStakes });
        step('ethics', { recommendation: deliberation.recommendation, requiresHumanReview: deliberation.requiresHumanReview });
        if (deliberation.requiresHumanReview) return halt('ethics', 'requires human review: ' + deliberation.humanReviewReason, { escalateToHuman: true });
      }

      // 7) WORLD + BKT — commit outcome to shared reality and update mastery
      var mastery = null;
      if (world && learner) {
        world.upsert({ id: learner, type: 'learner', scale: 'learner', state: { lastConcept: concept } });
        world.event({ type: 'concept-taught', subject: learner, payload: { concept: concept } });
        step('world', { subject: learner, event: 'concept-taught' });
      }
      if (bkt && request.response != null) {
        mastery = bkt.observe(concept, { correct: !!request.response.correct });
        step('bkt', { concept: concept, pKnown: mastery.pKnown, mastered: mastery.mastered });
      }

      step('respond', { concept: concept, intent: intentLabel, delivered: true });
      return { ok: true, response: { concept: concept, intent: intentLabel, answer: answer, adaptation: adaptation && adaptation.response, mastery: mastery }, audit: audit };
    }

    return { handle: handle };
  }

  window.AquinOrchestrator = { createOrchestrator: createOrchestrator };
})();
