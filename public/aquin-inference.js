/*
 * aquin-inference.js — AES-100 Vol III Part II Ch 18: Unified AI Runtime, Inference
 * & Cognitive Execution Engine (UAIRCE). Makes intelligence a built-in OS capability:
 * models are governed runtime resources, not external apps. Real, tested cores:
 *
 *  - MODEL REGISTRY + capability ROUTING: register models with a capability, version,
 *    context window, and health; a request is routed to the best healthy, version-
 *    compatible model (the AI equivalent of the Ch 1 service discovery).
 *  - CONTEXT-WINDOW MANAGEMENT (the real LLM-runtime problem): a context has a TOKEN
 *    BUDGET (the model's window); adding turns that would exceed it EVICTS the oldest
 *    non-pinned turns until it fits — a pinned system prompt is never evicted.
 *  - INFERENCE BATCHING: many small requests are grouped into batches (bounded by a
 *    batch size) for GPU throughput — the standard serving optimization.
 *  - SAFETY GATE: input/output must pass a policy before/after inference (composes
 *    the Ch V AI Execution Contract idea).
 *
 * HONEST SCOPE: the registry/routing/context-budget/batching/safety logic is real
 * and tested; the actual model weights, GPU/TPU kernels, KV-cache, and tokenizer are
 * declared substrates — this GOVERNS a model, it is not the model. (~M-LOC C++ → core.)
 */
(function () {
  function parseMajor(v) { return parseInt(String(v || '1.0.0').split('.')[0], 10) || 0; }

  function createAIRuntime(cfg) {
    cfg = cfg || {};
    var models = {}; var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var R = {
      provenance: provenance,
      registerModel: function (spec) { models[spec.id] = { id: spec.id, capability: spec.capability, version: spec.version || '1.0.0', contextWindow: spec.contextWindow || 4096, health: 'healthy' }; rec('register-model', { id: spec.id, capability: spec.capability }); return this; },
      setHealth: function (id, h) { if (models[id]) models[id].health = h; return this; },

      // route to the best healthy, version-compatible model for a capability
      route: function (req) {
        var cands = Object.keys(models).map(function (k) { return models[k]; }).filter(function (m) {
          return m.health === 'healthy' && m.capability === req.capability && (!req.minVersion || parseMajor(m.version) === parseMajor(req.minVersion));
        }).sort(function (a, b) { return parseMajor(b.version) - parseMajor(a.version); });
        var m = cands[0] || null;
        rec('route', { capability: req.capability, chosen: m && m.id });
        return m ? { ok: true, model: m.id, contextWindow: m.contextWindow, version: m.version } : { ok: false, reason: 'no healthy model for capability "' + req.capability + '"' };
      },

      // a context with a token budget; adding over-budget turns evicts oldest non-pinned
      createContext: function (modelId, opts) {
        opts = opts || {}; var m = models[modelId];
        var budget = (m ? m.contextWindow : 4096) - (opts.reserveForOutput || 512);
        var turns = [], used = 0;
        return {
          budget: budget,
          add: function (turn, tokens, pinned) {
            var evicted = [];
            // evict oldest non-pinned until this turn fits
            while (used + tokens > budget && turns.some(function (t) { return !t.pinned; })) {
              var idx = turns.findIndex(function (t) { return !t.pinned; });
              used -= turns[idx].tokens; evicted.push(turns[idx].turn); turns.splice(idx, 1);
            }
            if (used + tokens > budget) return { added: false, reason: 'turn (' + tokens + ') exceeds budget even after eviction' };
            turns.push({ turn: turn, tokens: tokens, pinned: !!pinned }); used += tokens;
            return { added: true, used: used, budget: budget, evicted: evicted };
          },
          window: function () { return turns.map(function (t) { return t.turn; }); },
          used: function () { return used; }
        };
      },

      // batch requests for throughput
      batch: function (requests, batchSize) {
        batchSize = batchSize || 8; var batches = [];
        for (var i = 0; i < requests.length; i += batchSize) batches.push(requests.slice(i, i + batchSize));
        rec('batch', { requests: requests.length, batches: batches.length });
        return { batches: batches.length, batchSize: batchSize, groups: batches.map(function (b) { return b.length; }) };
      },

      // safety gate: input + output must pass policy
      safetyGate: function (payload, policy) {
        if (policy && typeof policy === 'function' && !policy(payload)) { rec('safety-block', {}); return { allowed: false, reason: 'safety policy blocked this payload' }; }
        return { allowed: true };
      },
      model: function (id) { return models[id]; }
    };
    return R;
  }
  window.AquinInference = { createAIRuntime: createAIRuntime };
})();
