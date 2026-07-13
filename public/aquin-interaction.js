/*
 * aquin-interaction.js — Human–Educational Intelligence Interaction Engine
 * (AES-001, Ch 19). Interaction is not conversation — it is constitutional
 * collaboration. Every interaction is governed Educational Intent evaluated
 * against the actor's AUTHORITY, then either accepted, routed to verification,
 * or rejected. Initiative is mixed: the Intelligence may proactively recommend.
 *
 * The defining property, proven in the tests: authority is intrinsic to the
 * communication. A learner may ask and submit evidence but CANNOT redefine
 * Educational Truth; an educator may adapt instruction but not overturn
 * scientific truth; a researcher may only PROPOSE truth, which is routed through
 * the Consistency gate (contradictions rejected) — nobody edits Truth by fiat.
 *
 * Composes: Consistency (propose-truth gate), Learner Core (mixed-initiative
 * recommendations, interactive verification). HONEST SCOPE: intent recognition
 * here is contract-based (typed intents); a real NLU/LLM classifies free text
 * into these typed intents via the AI Runtime Layer — this is the governed layer
 * above it.
 */
(function () {
  // authority matrix — what each role is constitutionally permitted to intend
  var CAN = {
    learner:    { ask: 1, answer: 1, 'request-explanation': 1, 'submit-evidence': 1, reflect: 1, disagree: 1 },
    educator:   { ask: 1, 'request-explanation': 1, 'adapt-instruction': 1, intervene: 1, review: 1, 'submit-evidence': 1, override: 1 },
    researcher: { ask: 1, 'request-explanation': 1, 'propose-truth': 1, 'design-experiment': 1, review: 1 },
    admin:      { ask: 1, 'modify-policy': 1, review: 1, override: 1 }
  };
  // intents no role may perform by fiat (constitutional invariants)
  var FORBIDDEN = { 'redefine-truth': 'Educational Truth cannot be redefined by fiat; propose it for verification' };

  function createInteractionEngine(cfg) {
    cfg = cfg || {};
    var consistency = cfg.consistency || null;
    var provenance = [];
    var health = { interactions: 0, accepted: 0, rejected: 0, verified: 0 };
    function rec(d) { provenance.push(Object.assign({ at: Date.now() }, d)); }

    var E = {
      provenance: provenance,
      health: function () { return Object.assign({}, health, { acceptanceRate: health.interactions ? +(health.accepted / health.interactions).toFixed(2) : 0 }); },

      // the governed interaction path
      interact: function (actor, intent, ctx) {
        ctx = ctx || {}; health.interactions++;
        var role = actor && actor.role, itype = intent && intent.type;
        function reject(reason) { health.rejected++; rec({ role: role, intent: itype, status: 'rejected', reason: reason }); return { accepted: false, status: 'rejected', reason: reason }; }

        if (FORBIDDEN[itype]) return reject(FORBIDDEN[itype]);
        if (!CAN[role] || !CAN[role][itype]) return reject((role || 'unknown') + ' lacks authority for "' + itype + '"');

        // propose-truth is never applied directly — it goes through verification
        if (itype === 'propose-truth') {
          if (!consistency || !intent.proposal) return reject('propose-truth requires a proposal + consistency gate');
          var sandbox = new (consistency.constructor)();
          var threw = null;
          try { (consistency.assertions || []).concat([intent.proposal]).forEach(function (a) { sandbox.add(a); }); var chk = sandbox.check(); if (chk.hardViolations.length) threw = chk.hardViolations[0].detail; }
          catch (e) { threw = String(e && e.message || e); }
          if (threw) return reject('proposal contradicts Educational Truth: ' + threw);
          health.accepted++; health.verified++; rec({ role: role, intent: itype, status: 'accepted-for-verification' });
          return { accepted: true, status: 'accepted-for-verification', note: 'consistent proposal queued for governed verification before it becomes Truth' };
        }

        // ordinary accepted interactions
        health.accepted++;
        var response = null;
        if (itype === 'ask' || itype === 'request-explanation') response = { kind: 'explanation', about: (intent.payload && intent.payload.conceptId) || null };
        else if (itype === 'adapt-instruction' || itype === 'intervene' || itype === 'override') response = { kind: 'ack', applied: true, scope: 'within-authority' };
        else if (itype === 'submit-evidence') response = { kind: 'evidence-received' };
        rec({ role: role, intent: itype, status: 'accepted' });
        return { accepted: true, status: 'accepted', response: response, initiative: 'human' };
      },

      // Mixed-Initiative: the Intelligence proactively recommends when justified
      proactive: function (ctx) {
        if (ctx && ctx.learner && ctx.conceptId) {
          var u = ctx.learner.understanding(ctx.conceptId, ctx.context);
          if (u.overall.mastery < 0.4 && u.overall.confidence >= 0.3) { rec({ status: 'proactive', kind: 'revise-prerequisite', conceptId: ctx.conceptId }); return { initiative: 'ai', recommendation: 'revise-prerequisite', conceptId: ctx.conceptId, rationale: 'mastery low with adequate confidence' }; }
          var mc = Object.keys(u.misconceptions).some(function (k) { return u.misconceptions[k].belief >= 0.55; });
          if (mc) { rec({ status: 'proactive', kind: 'reconstruct', conceptId: ctx.conceptId }); return { initiative: 'ai', recommendation: 'reconstruct', conceptId: ctx.conceptId, rationale: 'active misconception detected' }; }
        }
        return { initiative: 'ai', recommendation: null };
      }
    };
    return E;
  }
  window.AquinInteraction = { CAN: CAN, createInteractionEngine: createInteractionEngine };
})();
