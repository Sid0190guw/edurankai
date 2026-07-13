/*
 * aquin-intervention.js — Educational Trust & Intervention Decision Engine
 * (AES-100, Vol II, Ch 42) + graduated consent / data-minimization (Ch 41).
 *
 * The AI does NOT act because it is intelligent — it acts only when the OS
 * decides intervention is JUSTIFIED. Observation never auto-produces action.
 * Every proposed intervention must satisfy FIVE constitutional requirements:
 *   1) Educational Benefit  2) Sufficient Evidence  3) Appropriate Authority
 *   4) Proportional Response  5) Explainability
 * If any fails, the intervention is delayed, REDUCED, or cancelled.
 *
 * Graduated intervention levels 0..5:
 *   0 observe · 1 gentle suggestion · 2 adaptive support · 3 coaching ·
 *   4 human collaboration (consent-gated) · 5 safety escalation (explicit crisis
 *   evidence only; pauses the mission and routes to humans — never fabricated).
 *
 * Consent (Ch 41): granular grant/revoke; DATA MINIMIZATION — data the learner
 * has not consented to is never used; unauthorized guardian/teacher notification
 * is reduced to coaching. Every decision is explainable + audited.
 *
 * HONEST SCOPE: encryption-at-rest, zero-trust transport, and incident response
 * (Ch 41 §5–11) are deployment/security substrates; this engine is the governed
 * DECISION layer above them.
 */
(function () {
  var LEVELS = ['observe', 'gentle-suggestion', 'adaptive-support', 'coaching', 'human-collaboration', 'safety-escalation'];
  // minimum aggregate confidence required to justify each level (proportionality)
  var REQ_CONF = { 0: 0, 1: 0.3, 2: 0.4, 3: 0.5, 4: 0.7, 5: 0.9 };

  function createInterventionEngine(cfg) {
    cfg = cfg || {};
    var consent = {};                       // permission -> true (granular, Ch 41)
    (cfg.consent || []).forEach(function (p) { consent[p] = true; });
    var audit = [];
    function rec(d) { audit.push(Object.assign({ at: Date.now() }, d)); }

    var E = {
      LEVELS: LEVELS, audit: audit,
      grantConsent: function (p) { consent[p] = true; rec({ op: 'consent-grant', permission: p }); return this; },
      revokeConsent: function (p) { delete consent[p]; rec({ op: 'consent-revoke', permission: p }); return this; },
      consented: function (p) { return !!consent[p]; },

      // the governed decision: does the OS authorize this intervention, and how?
      decide: function (spec) {
        spec = spec || {};
        var evidence = spec.evidence || [];
        var failed = [];

        // aggregate evidence confidence; detect explicit crisis (never inferred)
        var conf = evidence.length ? Math.max.apply(null, evidence.map(function (e) { return e.confidence || 0; })) : 0;
        var hasCrisis = evidence.some(function (e) { return e.type === 'crisis'; });

        // R1 — Educational Benefit
        var hasBenefit = !!spec.benefit;
        if (!hasBenefit) failed.push('educational-benefit');

        // R4 — Proportional Response: reduce level to what the evidence supports
        var level = spec.proposedLevel != null ? spec.proposedLevel : 1;
        if (hasCrisis) { level = 5; }
        else {
          if (!hasBenefit) level = 0;
          while (level > 0 && conf < REQ_CONF[level]) { failed.push('proportional-evidence@L' + level); level--; }
        }

        // R3 — Appropriate Authority + consent (data minimization)
        // level 4 (human collaboration) requires notification consent, else reduce to coaching
        if (level === 4) { var perm = spec.notifyPermission || 'guardian-share'; if (!consent[perm]) { failed.push('authority-consent(' + perm + ')'); level = 3; } }
        // any data the intervention wants must be consented; otherwise it is NOT used
        var dataUsed = (spec.requiresData || []).filter(function (d) { return consent[d]; });
        var dataDenied = (spec.requiresData || []).filter(function (d) { return !consent[d]; });
        if (dataDenied.length) failed.push('data-minimization(withheld:' + dataDenied.join('|') + ')');

        // decide
        var intervene = level > 0 && (hasBenefit || hasCrisis);
        var action = intervene ? LEVELS[level] : 'no-intervention';
        // safety escalation routes to humans regardless of consent (but never fabricated)
        var escalate = level === 5 ? { to: 'emergency', pausesMission: true } : (level === 4 ? { to: (spec.notify || 'guardian') } : null);

        // R5 — Explainability: every decision explains itself
        var decision = {
          intervene: intervene, level: level, action: action,
          why: intervene ? ('evidence confidence ' + conf.toFixed(2) + ' supports ' + action + (hasCrisis ? ' (explicit crisis evidence)' : '')) : ('not justified: ' + (failed[0] || 'insufficient evidence')),
          evidence: evidence.map(function (e) { return e.signal || e.type; }),
          confidence: +conf.toFixed(2),
          alternatives: LEVELS.slice(0, level).reverse(),
          authority: escalate ? escalate.to : (spec.authority || 'autonomous'),
          mission: spec.mission || null,
          dataUsed: dataUsed, dataWithheld: dataDenied,
          escalate: escalate, requirementsFailed: failed, explainable: true
        };
        rec({ op: 'decide', level: level, intervene: intervene, failed: failed });
        return decision;
      }
    };
    return E;
  }
  window.AquinIntervention = { LEVELS: LEVELS, createInterventionEngine: createInterventionEngine };
})();
