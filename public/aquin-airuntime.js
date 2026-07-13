/*
 * aquin-airuntime.js — Educational AI Runtime Layer (AES-001, Ch 15).
 * Constitutional principle: AI models are INFRASTRUCTURE; Educational
 * Intelligence is ARCHITECTURE. Runtime Domains request educational CAPABILITIES
 * (language, reasoning, vision, speech, simulation, creative, analytical) through
 * governed AI Execution Contracts — never a model by name. Providers are
 * swappable behind a stable capability interface (Model Independence), and no AI
 * output becomes Educational Reality until it passes CAPABILITY VERIFICATION.
 *
 *   Runtime Domain -> AI Execution Contract -> AI Runtime Layer -> (selected
 *   provider) -> Capability Verification -> Educational Runtime Object
 *
 * Proven in tests: swapping the provider changes nothing for the caller;
 * unverifiable/"hallucinated" output is rejected, not integrated; deterministic
 * contracts get reproducibility checked; full provenance records which provider
 * ran. HONEST SCOPE: providers are pluggable functions — a real LLM / symbolic
 * engine / vision model plugs in here; the reference providers are deterministic
 * stand-ins so the governance layer is testable without a model.
 */
(function () {
  var CAPABILITIES = ['language', 'reasoning', 'vision', 'speech', 'simulation', 'creative', 'analytical'];
  var CAP = {}; CAPABILITIES.forEach(function (c) { CAP[c] = 1; });

  function createRuntime(cfg) {
    cfg = cfg || {};
    // default capability verification: reject empty / flagged output. Real
    // deployments pass a verify that runs Truth/Consistency/Governance checks.
    var verify = cfg.verify || function (capability, output) {
      if (output == null || (typeof output === 'string' && !output.trim())) return { ok: false, reason: 'empty output' };
      if (output && output.flagged) return { ok: false, reason: 'flagged: ' + output.flagged };
      return { ok: true };
    };
    var providers = {};   // capability -> { providerId -> fn }
    var policy = {};      // capability -> providerId (institutional selection)
    var provenance = [];
    var seq = 0;
    function id(k) { seq++; return (k || 'rto') + '_' + seq.toString(36); }
    function freeze(o) { if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { freeze(o[k]); }); Object.freeze(o); } return o; }

    var R = {
      CAPABILITIES: CAPABILITIES, provenance: provenance,
      registerProvider: function (capability, providerId, fn) {
        if (!CAP[capability]) throw new Error('unknown capability "' + capability + '"');
        (providers[capability] = providers[capability] || {})[providerId] = fn;
        if (!policy[capability]) policy[capability] = providerId;   // first becomes default
        return this;
      },
      setPolicy: function (capability, providerId) { policy[capability] = providerId; return this; },
      providerFor: function (capability) { return policy[capability]; },

      // the ONLY way a Runtime Domain obtains AI: a governed contract
      execute: function (contract) {
        contract = contract || {};
        var t = { at: Date.now() }, txId = id('ai');
        if (!CAP[contract.capability]) { provenance.push(freeze({ txId: txId, status: 'rejected', reason: 'unknown capability', capability: contract.capability })); return freeze({ ok: false, status: 'rejected', reason: 'unknown capability "' + contract.capability + '"' }); }
        var pid = contract.provider || policy[contract.capability];
        var fn = providers[contract.capability] && providers[contract.capability][pid];
        if (!fn) { provenance.push(freeze({ txId: txId, status: 'rejected', reason: 'no provider', capability: contract.capability })); return freeze({ ok: false, status: 'no-provider', reason: 'no provider for "' + contract.capability + '"' }); }

        // run the selected provider (Runtime Domain is unaware which one)
        var out = fn(contract);
        var output = out && out.output !== undefined ? out.output : out;

        // determinism check when the contract requires reproducibility
        var reproducible = null;
        if (contract.deterministic) {
          var out2 = fn(contract); var output2 = out2 && out2.output !== undefined ? out2.output : out2;
          reproducible = JSON.stringify(output) === JSON.stringify(output2);
        }

        // CAPABILITY VERIFICATION — AI output is not Educational Reality yet
        var v = verify(contract.capability, output, contract);
        if (!v.ok) { provenance.push(freeze({ txId: txId, status: 'rejected-verification', capability: contract.capability, provider: pid, reason: v.reason })); return freeze({ ok: false, status: 'rejected-verification', reason: v.reason, provider: pid }); }
        if (contract.deterministic && reproducible === false) { provenance.push(freeze({ txId: txId, status: 'rejected-nondeterministic', capability: contract.capability, provider: pid })); return freeze({ ok: false, status: 'rejected-nondeterministic', reason: 'deterministic contract but provider is non-reproducible', provider: pid }); }

        var rto = freeze({ id: id('rto'), txId: txId, capability: contract.capability, provider: pid, output: output, verified: true, reproducible: reproducible, provenance: { objective: contract.objective || null, ranBy: pid } });
        provenance.push(freeze({ txId: txId, status: 'verified', capability: contract.capability, provider: pid, objectId: rto.id }));
        return freeze({ ok: true, status: 'verified', runtimeObject: rto, provider: pid });
      },

      // Dynamic Model Composition — cooperate multiple capabilities under governance
      compose: function (contracts) { var self = this; return contracts.map(function (c) { return self.execute(c); }); }
    };
    return R;
  }
  window.AquinAIRuntime = { CAPABILITIES: CAPABILITIES, createRuntime: createRuntime };
})();
