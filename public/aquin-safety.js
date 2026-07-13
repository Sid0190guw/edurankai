/*
 * aquin-safety.js — Educational Safety Intelligence & Guardian Alert Runtime
 * Domain (AES-100, Vol II, Ch 44). Purpose: educational PROTECTION, not
 * surveillance. Principle: "Protect without surveilling. Inform without
 * alarming. Intervene with evidence, not assumptions."
 *
 * The engineered core is a strict three-tier distinction, enforced in code:
 *   OBSERVED FACT     — something the system actually knows (e.g. a flagged link)
 *   RISK INDICATOR    — a pattern that MAY suggest concern (uncertain)
 *   VERIFIED CONCERN  — confirmed by the learner / educator / guardian / source
 *
 * The system NEVER states "the learner is being exploited." From risk indicators
 * it says only "multiple indicators suggest the learner may be encountering …;
 * additional review is recommended." Alerts are graduated (0..5), consent-gated
 * for guardian notification, and the guardian dashboard separates OBSERVATIONS
 * from RECOMMENDATIONS. Every alert is explainable + audited.
 *
 * Composes the Intervention Decision Engine (Ch 42) authority/consent model and
 * the Mentor (Ch 9) for wellbeing. HONEST SCOPE: anti-phishing / content-
 * verification are integrated evidence SOURCES (they produce observed facts);
 * this engine is the governed risk-estimation + alerting layer above them.
 */
(function () {
  var TIERS = ['observed-fact', 'risk-indicator', 'verified-concern'];
  var CATEGORIES = ['educational', 'digital-wellbeing', 'online-safety', 'information-integrity', 'social', 'self-reported-wellbeing'];
  var ALERT = ['observation', 'reminder', 'coaching', 'guardian-summary', 'urgent-review', 'critical-safety'];

  function createSafetyIntelligence(cfg) {
    cfg = cfg || {};
    var consent = {}; (cfg.consent || []).forEach(function (p) { consent[p] = true; });
    var obs = [];              // accumulated observations (all tiers)
    var audit = [];
    function rec(d) { audit.push(Object.assign({ at: Date.now() }, d)); }

    var S = {
      TIERS: TIERS, CATEGORIES: CATEGORIES, ALERT: ALERT, audit: audit,
      grantConsent: function (p) { consent[p] = true; return this; },
      revokeConsent: function (p) { delete consent[p]; return this; },

      // record an authorized observation with its evidential tier + provenance
      observe: function (o) {
        if (!o || CATEGORIES.indexOf(o.category) < 0 || TIERS.indexOf(o.tier) < 0) return { ok: false, reason: 'invalid category/tier' };
        if (!o.provenance || !o.provenance.source) return { ok: false, reason: 'observation needs provenance' };
        obs.push({ category: o.category, tier: o.tier, signal: o.signal || null, confidence: o.confidence != null ? o.confidence : 0.5, crisis: !!o.crisis, at: Date.now(), provenance: o.provenance });
        rec({ op: 'observe', category: o.category, tier: o.tier, source: o.provenance.source });
        return { ok: true };
      },

      // anti-phishing / cyber integration: a flagged link is an OBSERVED FACT
      flagLink: function (url, verdict) {
        if (verdict === 'phishing' || verdict === 'scam' || verdict === 'malicious') {
          this.observe({ category: 'online-safety', tier: 'observed-fact', signal: verdict + ':' + url, confidence: 0.95, provenance: { source: 'anti-phishing-engine' } });
          rec({ op: 'block-link', verdict: verdict });
          return { blocked: true, explained: 'This link was identified as ' + verdict + ' and was blocked to protect you.', recorded: true };
        }
        return { blocked: false };
      },

      // estimate risk for a category — hedged where it is only indicators
      assess: function (category) {
        var inds = obs.filter(function (o) { return o.category === category; });
        if (!inds.length) return { category: category, riskLevel: 0, alert: 'observation', statement: 'No indicators for ' + category + '.', isVerified: false, confidence: 0, indicators: 0 };
        var verified = inds.filter(function (o) { return o.tier === 'verified-concern'; });
        var indicators = inds.filter(function (o) { return o.tier === 'risk-indicator'; });
        var maxConf = Math.max.apply(null, inds.map(function (o) { return o.confidence; }));
        var isVerified = verified.length > 0;
        var explicitCrisis = inds.some(function (o) { return o.crisis; });

        var level;
        if (explicitCrisis) level = 5;                                   // critical safety (explicit only)
        else if (isVerified && maxConf >= 0.7) level = 4;                // urgent, human review
        else if (indicators.length >= 3 && maxConf >= 0.5) level = 3;    // guardian summary
        else if (indicators.length >= 1 && maxConf >= 0.4) level = 2;    // coaching
        else level = 1;                                                  // gentle reminder

        // consent gating: guardian summary requires consent, else stay at coaching
        var note = null;
        if (level === 3 && !consent['guardian-share']) { level = 2; note = 'guardian notification not consented — kept at coaching'; }

        var statement = isVerified
          ? ('Verified concern in ' + category + ' (confirmed by an authorized source).')
          : ('Multiple indicators suggest the learner may be encountering ' + category + ' concerns. Additional review is recommended. This is NOT a confirmed fact.');

        var escalate = level === 5 ? { to: 'emergency', pausesMission: true } : (level >= 3 && consent['guardian-share'] ? { to: 'guardian' } : null);
        rec({ op: 'assess', category: category, level: level, isVerified: isVerified });
        return {
          category: category, riskLevel: level, alert: ALERT[level], statement: statement,
          isVerified: isVerified, confidence: +maxConf.toFixed(2), indicators: indicators.length, observedFacts: inds.filter(function (o) { return o.tier === 'observed-fact'; }).length,
          recommendation: level >= 2 ? 'Review with an educator; consider a supportive conversation.' : 'Continue monitoring; no action needed.',
          escalate: escalate, note: note,
          why: 'confidence ' + maxConf.toFixed(2) + ', ' + indicators.length + ' indicator(s), verified=' + isVerified
        };
      },

      // guardian dashboard: OBSERVATIONS separated from RECOMMENDATIONS (consent-gated)
      guardianDashboard: function () {
        if (!consent['guardian-share']) return { available: false, reason: 'guardian sharing not consented' };
        var byCat = {}; CATEGORIES.forEach(function (c) { var a = S.assess(c); if (a.riskLevel > 0 || a.observedFacts > 0) byCat[c] = { level: a.alert, statement: a.statement, verified: a.isVerified }; });
        return {
          available: true,
          observations: byCat,                                     // factual, evidence-backed
          recommendations: ['Encourage a conversation about study planning.', 'Support healthy study routines.', 'Help prepare for upcoming examinations.']
        };
      }
    };
    return S;
  }
  window.AquinSafety = { TIERS: TIERS, CATEGORIES: CATEGORIES, ALERT: ALERT, createSafetyIntelligence: createSafetyIntelligence };
})();
