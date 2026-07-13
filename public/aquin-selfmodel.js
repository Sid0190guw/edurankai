/*
 * aquin-selfmodel.js — Educational Self-Model / "Consciousness Layer" (AES-100,
 * Vol II, Ch 64). This does NOT model human consciousness. It is a rigorous
 * systems-engineering self-model: the operating system's continuously-updated
 * understanding of ITSELF — what it can do, what it cannot, which Runtime Domains
 * are active, where its confidence boundaries lie, and when it must ask a human.
 *
 * It is the structural counterpart of Meta-Cognition (Ch 56): meta-cognition
 * audits a single conclusion's reliability; the self-model audits the SYSTEM's
 * standing capability and health. Both exist to keep a powerful system HONEST.
 *
 * Engineered guarantees (proven in the tests):
 *  - HONEST CAPABILITY INTROSPECTION: "what can I do?" answers only from Runtime
 *    Domains that are actually registered AND healthy; a down domain is reported
 *    as unavailable, never pretended.
 *  - DECLARED LIMITATIONS: "what can I NOT do?" is explicit; an out-of-scope
 *    request returns "I cannot", not a fabricated attempt.
 *  - CONFIDENCE BOUNDARY -> HUMAN ESCALATION: a request below the competence
 *    threshold, or that touches a declared limitation, or that needs a down
 *    domain, triggers "ask for human assistance".
 *  - GRACEFUL DEGRADATION AWARENESS: when a domain fails, the self-model's picture
 *    of overall capability shrinks accordingly (it knows it is degraded).
 *  - FAILURE-MODE + RESOURCE AWARENESS: it exposes health, load, and known failure
 *    modes rather than presenting a false all-green.
 *  - PROVENANCE of every self-assessment.
 *
 * HONEST SCOPE: introspection over a declared registry of domains/capabilities and
 * their reported health. It reflects the system; it is not a separate intelligence.
 */
(function () {
  function createSelfModel(cfg) {
    cfg = cfg || {};
    var competenceThreshold = cfg.competenceThreshold != null ? cfg.competenceThreshold : 0.55;
    var domains = {};        // name -> { name, capabilities:[], up, load, competence:{cap:0..1}, failureModes:[] }
    var limitations = [];    // explicit "cannot do" declarations
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var S = {
      provenance: provenance,

      registerDomain: function (spec) {
        domains[spec.name] = { name: spec.name, capabilities: (spec.capabilities || []).slice(), up: spec.up !== false, load: spec.load != null ? spec.load : 0, competence: spec.competence || {}, failureModes: (spec.failureModes || []).slice() };
        rec('register-domain', { name: spec.name, capabilities: domains[spec.name].capabilities });
        return this;
      },
      setDomainUp: function (name, up) { if (domains[name]) domains[name].up = up; rec('domain-status', { name: name, up: up }); return this; },
      declareLimitation: function (text) { limitations.push(text); rec('declare-limitation', { text: text }); return this; },

      // "What can I currently do?" — only healthy domains' capabilities
      capabilities: function () {
        var caps = {};
        Object.keys(domains).forEach(function (k) { var d = domains[k]; if (d.up) d.capabilities.forEach(function (c) { caps[c] = k; }); });
        return { available: Object.keys(caps), byDomain: caps };
      },
      // "What can I NOT do?" — capabilities of DOWN domains + explicit limitations
      cannot: function () {
        var downCaps = {};
        Object.keys(domains).forEach(function (k) { var d = domains[k]; if (!d.up) d.capabilities.forEach(function (c) { downCaps[c] = 'domain "' + k + '" is down'; }); });
        return { declaredLimitations: limitations.slice(), unavailableCapabilities: downCaps };
      },

      // can I do THIS request? honest yes/no + whether to escalate to a human
      assess: function (request) {
        request = request || {};
        var cap = request.capability;
        // explicit limitation match -> cannot, escalate
        var hitLimit = limitations.filter(function (l) { return request.description && l && request.description.toLowerCase().indexOf(l.toLowerCase()) >= 0; });
        if (hitLimit.length) { rec('assess', { capability: cap, can: false, escalate: true }); return { can: false, reason: 'declared limitation: ' + hitLimit[0], askHuman: true }; }
        // find a healthy domain offering the capability
        var owner = Object.keys(domains).filter(function (k) { return domains[k].capabilities.indexOf(cap) >= 0; })[0];
        if (!owner) { rec('assess', { capability: cap, can: false }); return { can: false, reason: 'no Runtime Domain provides "' + cap + '"', askHuman: true }; }
        if (!domains[owner].up) { rec('assess', { capability: cap, can: false, degraded: true }); return { can: false, reason: 'domain "' + owner + '" is currently down (degraded operation)', askHuman: true, degraded: true }; }
        // competence boundary
        var competence = domains[owner].competence[cap] != null ? domains[owner].competence[cap] : 0.7;
        if (competence < competenceThreshold) { rec('assess', { capability: cap, can: true, lowConfidence: true }); return { can: true, byDomain: owner, competence: competence, belowThreshold: true, askHuman: true, reason: 'competence ' + competence + ' is below threshold ' + competenceThreshold + ' — recommend human involvement' }; }
        rec('assess', { capability: cap, can: true });
        return { can: true, byDomain: owner, competence: competence, askHuman: false, reason: 'within competence' };
      },

      // overall operational self-picture — honest health, not a false all-green
      health: function () {
        var names = Object.keys(domains); var up = names.filter(function (k) { return domains[k].up; });
        var avgLoad = names.length ? names.reduce(function (s, k) { return s + domains[k].load; }, 0) / names.length : 0;
        var failureModes = [].concat.apply([], names.map(function (k) { return domains[k].failureModes.map(function (f) { return domains[k].name + ': ' + f; }); }));
        return {
          domains: names.length, operational: up.length, degraded: names.length - up.length,
          degradedMode: up.length < names.length,
          avgLoad: +avgLoad.toFixed(3),
          knownFailureModes: failureModes,
          capabilityCoverage: this.capabilities().available.length,
          summary: up.length === names.length ? 'all domains operational' : (up.length + '/' + names.length + ' domains operational — degraded')
        };
      }
    };
    return S;
  }

  window.AquinSelfModel = { createSelfModel: createSelfModel };
})();
