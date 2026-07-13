/*
 * aquin-cogmemory.js — AES-100 Vol III Part II Ch 20: Digital Memory, Knowledge
 * Persistence & Cognitive Continuity (DMKPCCF). This chapter's episodic/semantic
 * stores, consolidation, and forgetting are ALREADY real code in
 * aquin-memory-runtime.js, and temporal/historical reconstruction is in
 * aquin-knowledge.js (bitemporal). So — to build without duplicating — this engine
 * implements the two parts NOT yet covered:
 *
 *  - PROCEDURAL MEMORY: "how to do things", not facts. It records skill executions
 *    (a step sequence + success/failure), then CONSOLIDATES the most-successful
 *    sequence into a learned procedure with a measured success rate — so an agent
 *    reuses what worked, not just what it was told.
 *  - PRIVACY-PRESERVING MEMORY GOVERNANCE: every memory carries a consent scope,
 *    retention period, and PII fields. Access is DENIED unless the caller's scope
 *    covers the consent scope; retention EXPIRES old memories; export REDACTS PII.
 *
 * HONEST SCOPE: procedural consolidation + privacy governance are real and tested;
 * the multi-store working/semantic memory (aquin-memory-runtime.js), the forgetting
 * curve (aquin-memory.js), and bitemporal reconstruction (aquin-knowledge.js) are
 * the composed substrate. (~51.2M-LOC C++ spec → the un-covered core.)
 */
(function () {
  var DAY = 86400000;
  function createCognitiveMemory(cfg) {
    cfg = cfg || {};
    var now = cfg.now || function () { return Date.now(); };
    var executions = [];   // { skill, steps:[], success }
    var procedures = {};   // skill -> { steps, successRate, samples }
    var mems = {};         // id -> { content, consentScope, retentionUntil, pii:[], at }
    var seq = 0, provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: now(), detail: d || null }); }

    var M = {
      provenance: provenance,

      // ---- procedural memory ----
      recordExecution: function (skill, steps, success) { executions.push({ skill: skill, steps: steps.slice(), key: steps.join('>'), success: !!success }); rec('exec', { skill: skill, success: !!success }); return this; },
      consolidateProcedures: function () {
        var bySkill = {};
        executions.forEach(function (e) { var s = (bySkill[e.skill] = bySkill[e.skill] || {}); var k = (s[e.key] = s[e.key] || { steps: e.steps, runs: 0, wins: 0 }); k.runs++; if (e.success) k.wins++; });
        var out = [];
        Object.keys(bySkill).forEach(function (skill) {
          // pick the sequence with the highest success rate (min samples), then most runs
          var best = Object.keys(bySkill[skill]).map(function (k) { var c = bySkill[skill][k]; return { steps: c.steps, successRate: c.wins / c.runs, runs: c.runs }; })
            .filter(function (c) { return c.runs >= (cfg.minSamples || 1); })
            .sort(function (a, b) { return (b.successRate - a.successRate) || (b.runs - a.runs); })[0];
          if (best) { procedures[skill] = { steps: best.steps, successRate: +best.successRate.toFixed(3), samples: best.runs }; out.push(skill); }
        });
        rec('consolidate-procedures', { learned: out.length });
        return out;
      },
      retrieveProcedure: function (skill) { return procedures[skill] || null; },

      // ---- privacy-preserving memory governance ----
      store: function (content, opts) {
        opts = opts || {}; var id = 'mem_' + (++seq);
        mems[id] = { id: id, content: content, consentScope: opts.consentScope || 'self', retentionUntil: opts.retentionDays ? now() + opts.retentionDays * DAY : null, pii: opts.pii || [], at: now() };
        rec('store', { id: id, scope: mems[id].consentScope }); return id;
      },
      // access requires the caller's scope to COVER the memory's consent scope
      access: function (id, callerScopes) {
        var m = mems[id]; if (!m) return { ok: false, reason: 'no such memory (or expired)' };
        callerScopes = callerScopes || [];
        if (m.consentScope !== 'public' && callerScopes.indexOf(m.consentScope) < 0) { rec('access-denied', { id: id }); return { ok: false, reason: 'consent scope "' + m.consentScope + '" not granted to caller' }; }
        return { ok: true, content: m.content };
      },
      // retention: drop memories past their retention period
      enforceRetention: function () { var expired = []; Object.keys(mems).forEach(function (id) { var m = mems[id]; if (m.retentionUntil && now() >= m.retentionUntil) { delete mems[id]; expired.push(id); } }); rec('retention', { expired: expired.length }); return expired; },
      // export with PII redaction
      export: function (id, opts) {
        opts = opts || {}; var m = mems[id]; if (!m) return null;
        var c = JSON.parse(JSON.stringify(m.content));
        if (opts.redactPII !== false) m.pii.forEach(function (f) { if (c && typeof c === 'object' && f in c) c[f] = '[REDACTED]'; });
        return { id: id, content: c, redacted: m.pii.slice() };
      },
      count: function () { return Object.keys(mems).length; }
    };
    return M;
  }
  window.AquinCogMemory = { createCognitiveMemory: createCognitiveMemory };
})();
