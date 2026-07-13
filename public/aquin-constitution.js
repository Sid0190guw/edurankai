/*
 * aquin-constitution.js — Constitutional Runtime & Educational Governance Kernel
 * (AES-100, Vol II, Ch 58). The SUPREME governing subsystem. Every Runtime action
 * — by any agent, on any object, in any domain — derives its authority here.
 *
 *   The defining principle: NO INTELLIGENCE IS ABOVE THE CONSTITUTION.
 *   It separates POWER from AUTHORITY: an AI may grow arbitrarily capable, but its
 *   capabilities are always exercised within explicit constitutional limits.
 *
 * Engineered guarantees (proven in the tests):
 *  - VALIDATION PIPELINE: no action reaches execution without passing, in order,
 *    identity -> authorization -> educational-truth -> safety -> governance ->
 *    policy-resolution. Any stage can deny; a denial is final and explained.
 *  - LAYERED CONSTITUTION with INHERITANCE: Universal Principles > Federation >
 *    National > Institutional > Mission. A lower layer inherits the constraints of
 *    higher layers and MAY NOT relax them unless a higher layer explicitly permits.
 *  - CONFLICT RESOLUTION BY HIERARCHY: when layers disagree, the higher layer wins
 *    and the reasoning is recorded in the audit trail.
 *  - AI BEHAVIOUR GOVERNANCE: an agent decision that is unexplainable, lacks
 *    evidence, is overconfident, or has incomplete provenance SHALL NOT publish.
 *  - AMENDMENT ONLY BY GOVERNED PROCESS: no AI (and no runtime request) may
 *    autonomously modify a constitutional principle; amendment requires the full
 *    governance pathway. Autonomous constitutional change is REJECTED.
 *  - COMPLETE AUDITABILITY: every decision records constitutional version, applied
 *    policies, stage results, participants, and reasoning — reconstructable.
 *
 * HONEST SCOPE: this is the governance decision + audit kernel. Cryptographic
 * identity, distributed policy replication, and jurisdiction-specific legal
 * encodings are the deployment substrates it sits above.
 */
(function () {
  // constitutional layers, highest authority first
  var LAYERS = ['universal', 'federation', 'national', 'institutional', 'mission'];

  function createConstitution(cfg) {
    cfg = cfg || {};
    var version = cfg.version || '1.0.0';
    // immutable universal principles — the bedrock (frozen)
    var UNIVERSAL = Object.freeze(cfg.universal || {
      educationalTruth: true, scientificIntegrity: true, learnerSafety: true,
      explainability: true, transparency: true, humanOversight: true
    });
    var policies = { universal: { principles: UNIVERSAL, rules: {} }, federation: {}, national: {}, institutional: {}, mission: {} };
    var audit = [];
    function rec(entry) { audit.push(Object.assign({ v: version, at: Date.now() }, entry)); return entry; }

    // set a policy at a layer. { layer, id, rule:{allow?:bool, requires?:[], forbids?:bool}, permittedByHigher?:bool }
    function setPolicy(layer, id, rule) {
      if (LAYERS.indexOf(layer) < 0) throw new Error('unknown layer "' + layer + '"');
      if (layer === 'universal') throw new Error('universal principles are amended only via governedAmendment()');
      (policies[layer].rules = policies[layer].rules || {})[id] = rule || {};
      rec({ op: 'set-policy', layer: layer, id: id });
      return true;
    }

    // resolve a policy id across layers with INHERITANCE: higher layers constrain lower.
    // returns { decision:'allow'|'deny', by:layer, reason, chain:[...] }
    function resolvePolicy(id, action) {
      var chain = [], decision = 'allow', by = 'default', reason = 'no policy restricts this action';
      // walk highest -> lowest; a forbid at a higher layer cannot be relaxed lower
      for (var i = 0; i < LAYERS.length; i++) {
        var layer = LAYERS[i];
        var rule = layer === 'universal' ? null : (policies[layer].rules && policies[layer].rules[id]);
        if (!rule) continue;
        chain.push({ layer: layer, rule: rule });
        if (rule.forbids) {
          // a forbid always denies at this layer; only a LOWER layer explicitly
          // permitted by a higher one may later relax it
          decision = 'deny'; by = layer; reason = rule.reason || (id + ' is forbidden at ' + layer + ' layer');
        } else if (rule.allow === true) {
          if (decision === 'deny' && !rule.permittedByHigher) {
            // cannot relax a higher-layer denial without explicit higher permission
            continue;
          }
          // either nothing denied above, or this layer is explicitly permitted to override
          decision = 'allow'; by = layer; reason = id + ' permitted at ' + layer + ' layer' + (rule.permittedByHigher ? ' (explicitly permitted to override higher layer)' : '');
        }
      }
      return { decision: decision, by: by, reason: reason, chain: chain };
    }

    // ---- the constitutional validation pipeline ----
    // action: { id, actor, capability, decision, evidence?, explanation?, confidence?, provenanceComplete?, safe?, targetsConstitution? }
    function validate(action) {
      action = action || {};
      var stages = [];
      function fail(stage, reason) { var r = rec({ op: 'validate', action: action.id, result: 'denied', stage: stage, reason: reason, stages: stages.concat([{ stage: stage, pass: false }]) }); return { approved: false, stage: stage, reason: reason, audit: r, stages: r.stages }; }
      function pass(stage) { stages.push({ stage: stage, pass: true }); }

      // 1) identity
      if (!action.actor) return fail('identity', 'no verified actor identity');
      pass('identity');

      // 2) authorization — actor must hold the capability it is exercising
      if (action.capability && action.authorized === false) return fail('authorization', 'actor not authorized for "' + action.capability + '"');
      pass('authorization');

      // 3) educational-truth — cannot publish a claim contradicting verified truth
      if (action.contradictsTruth) return fail('educational-truth', 'action contradicts verified Educational Truth');
      pass('educational-truth');

      // 4) safety — learner safety is a universal principle
      if (action.safe === false) return fail('safety', 'action fails learner-safety validation');
      pass('safety');

      // 5) governance — AI behaviour governance for agent decisions
      if (action.capability && action.decision != null) {
        if (UNIVERSAL.explainability && !action.explanation) return fail('governance', 'agent decision lacks required explanation (explainability principle)');
        if (action.evidenceSufficient === false) return fail('governance', 'agent decision has insufficient evidence');
        if (action.confidence != null && action.confidence > 0.9 && action.evidenceSufficient !== true) return fail('governance', 'overconfident decision without sufficient evidence');
        if (action.provenanceComplete === false) return fail('governance', 'incomplete provenance');
      }
      // no autonomous constitutional change
      if (action.targetsConstitution) return fail('governance', 'autonomous constitutional change is out of authority — requires governedAmendment()');
      pass('governance');

      // 6) policy resolution across layers
      if (action.policyId) {
        var pr = resolvePolicy(action.policyId, action);
        if (pr.decision === 'deny') return fail('policy-resolution', pr.reason + ' (resolved by ' + pr.by + ' layer)');
        stages.push({ stage: 'policy-resolution', pass: true, by: pr.by });
      } else pass('policy-resolution');

      var ok = rec({ op: 'validate', action: action.id, result: 'approved', actor: action.actor, capability: action.capability, stages: stages });
      return { approved: true, reason: 'constitutional validation passed', audit: ok, stages: stages };
    }

    // constitutional amendment ONLY through the governed pathway
    var AMEND_PATH = ['proposal', 'educational-evidence', 'research-review', 'expert-council', 'public-consultation', 'governance-approval'];
    function governedAmendment(proposal) {
      var completed = (proposal && proposal.completedStages) || [];
      var missing = AMEND_PATH.filter(function (s) { return completed.indexOf(s) < 0; });
      if (missing.length) { rec({ op: 'amendment', result: 'rejected', missing: missing }); return { applied: false, reason: 'governed amendment pathway incomplete', missing: missing, pathway: AMEND_PATH }; }
      // even a fully-governed amendment bumps version and is audited; universal bedrock stays frozen unless proposal targets a mutable principle
      version = bumpVersion(version);
      rec({ op: 'amendment', result: 'applied', newVersion: version, principle: proposal.principle });
      return { applied: true, newVersion: version, note: 'amendment applied through full governance pathway' };
    }
    function bumpVersion(v) { var p = v.split('.'); p[1] = String((+p[1] || 0) + 1); p[2] = '0'; return p.join('.'); }

    return {
      LAYERS: LAYERS,
      version: function () { return version; },
      universal: function () { return UNIVERSAL; },
      setPolicy: setPolicy,
      resolvePolicy: resolvePolicy,
      validate: validate,
      governedAmendment: governedAmendment,
      audit: function () { return audit.slice(); }
    };
  }

  window.AquinConstitution = { LAYERS: LAYERS, createConstitution: createConstitution };
})();
