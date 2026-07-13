/*
 * aquin-ai-runtime.js — AES Part V: the AI Runtime. In AquinTutor an AI model is a
 * computational ENGINE, never the architecture — so it may only run inside a
 * governed AI EXECUTION CONTRACT, not a free-form prompt. The contract declares
 * what the model is allowed to do; the runtime enforces it on the way OUT, so a
 * model that hallucinates, escalates capability, drops its grounding, or breaks
 * schema is rejected BEFORE its output can touch educational reality.
 *
 *   Contract = { capability, outputSchema, requiresGrounding, forbids, maxClaims }
 *   execute(contract, input, modelFn):
 *     1) input is checked (declares the requested capability == the contract's)
 *     2) modelFn runs (the AI — a DECLARED SUBSTRATE, injected, never faked here)
 *     3) output is VALIDATED against the contract:
 *          - matches the output schema (types/required fields)
 *          - if requiresGrounding: every claim cites evidence that was actually
 *            provided in the input (no fabricated citations)
 *          - contains none of the forbidden content / no capability escalation
 *     4) pass -> a governed result; fail -> rejected with the exact reason.
 *
 * This is the concrete form of "AI Execution Contracts replace prompts": every AI
 * decision is capability-bounded, grounded, schema-valid, and auditable. HONEST
 * SCOPE: the runtime + contract enforcement are real; the model itself is whatever
 * modelFn you inject (self-hosted LLM, Claude, a stub) — this governs it, it does
 * not pretend to be it.
 */
(function () {
  function typeOf(v) { return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v; }

  function validateSchema(obj, schema) {
    var errs = [];
    Object.keys(schema).forEach(function (field) {
      var spec = schema[field];
      var required = spec.required !== false;
      if (obj[field] == null) { if (required) errs.push('missing required field "' + field + '"'); return; }
      if (spec.type && typeOf(obj[field]) !== spec.type) errs.push('field "' + field + '" must be ' + spec.type + ' (got ' + typeOf(obj[field]) + ')');
    });
    return errs;
  }

  function createAIRuntime(cfg) {
    cfg = cfg || {};
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function defineContract(spec) {
      return {
        capability: spec.capability, outputSchema: spec.outputSchema || {},
        requiresGrounding: !!spec.requiresGrounding, forbids: spec.forbids || [],
        maxClaims: spec.maxClaims != null ? spec.maxClaims : Infinity
      };
    }

    // run a model under a contract and validate its output
    function execute(contract, input, modelFn) {
      input = input || {};
      // 1) capability check — the request must match the contract (no escalation)
      if (input.capability && input.capability !== contract.capability) {
        rec('reject', { stage: 'capability', want: contract.capability, got: input.capability });
        return { ok: false, stage: 'capability', reason: 'capability escalation: contract permits "' + contract.capability + '", request asked "' + input.capability + '"' };
      }
      // 2) run the AI (declared substrate)
      var output;
      try { output = modelFn(input); }
      catch (e) { rec('reject', { stage: 'model-error' }); return { ok: false, stage: 'model', reason: 'model error: ' + (e && e.message || e) }; }
      if (output == null || typeof output !== 'object') return { ok: false, stage: 'output', reason: 'model produced no structured output' };

      // 3a) schema
      var schemaErrs = validateSchema(output, contract.outputSchema);
      if (schemaErrs.length) { rec('reject', { stage: 'schema', errs: schemaErrs.length }); return { ok: false, stage: 'schema', reason: schemaErrs[0] }; }

      // 3b) grounding — every claim must cite evidence actually present in the input
      var claims = output.claims || [];
      if (claims.length > contract.maxClaims) return { ok: false, stage: 'claims', reason: 'too many claims (' + claims.length + ' > ' + contract.maxClaims + ')' };
      if (contract.requiresGrounding) {
        var providedEvidence = {}; (input.evidence || []).forEach(function (e) { providedEvidence[e.id] = true; });
        var ungrounded = claims.filter(function (c) { return !c.evidenceId || !providedEvidence[c.evidenceId]; });
        if (ungrounded.length) { rec('reject', { stage: 'grounding', count: ungrounded.length }); return { ok: false, stage: 'grounding', reason: ungrounded.length + ' claim(s) cite evidence not provided in the input (fabricated citation)', ungrounded: ungrounded.map(function (c) { return c.text; }) }; }
      }

      // 3c) forbidden content / capability
      var text = JSON.stringify(output).toLowerCase();
      var hit = contract.forbids.filter(function (f) { return text.indexOf(String(f).toLowerCase()) >= 0; });
      if (hit.length) { rec('reject', { stage: 'forbidden', hit: hit }); return { ok: false, stage: 'forbidden', reason: 'output contains forbidden content: "' + hit[0] + '"' }; }

      rec('execute', { capability: contract.capability, claims: claims.length });
      return { ok: true, output: output, contract: contract.capability, grounded: contract.requiresGrounding, claims: claims.length };
    }

    return { provenance: provenance, defineContract: defineContract, execute: execute, validateSchema: validateSchema };
  }
  window.AquinAIRuntime = { createAIRuntime: createAIRuntime };
})();
