/*
 * aquin-knowledge-runtime.js — AES Part V: the Knowledge Runtime. A Part-V Runtime
 * is a constitutional Runtime Domain that plugs into the Educational Operating
 * Kernel (aquin-eok.js): it registers as a subsystem and the ONLY way to change its
 * state is a governed Educational Transaction through kernel.submit(), which runs
 * the constitution gate, writes an immutable Runtime Object, and appends the ledger.
 *
 * This runtime wraps the Chapter-1 KnowledgeStore (aquin-knowledge.js). Reads go
 * straight to the store; WRITES (put-concept / relate) go through the kernel, so
 * every change to Knowledge is: governance-checked, provenance-bearing, immutable-
 * object-producing, and audit-logged. A write that violates a Knowledge invariant
 * (presentation, learner-state, invalid Concept) is rejected by the store's throw,
 * which the kernel records as a rejected transaction — no bypass exists.
 *
 * HONEST SCOPE: composition of two real engines (EOK + KnowledgeStore); this proves
 * the Part-V pattern — a subsystem becomes a *governed* runtime by routing its
 * mutations through the kernel — not that we ship a distributed KV store.
 */
(function () {
  function createKnowledgeRuntime(kernel, opts) {
    opts = opts || {};
    if (!kernel || typeof kernel.register !== 'function') throw new Error('Knowledge Runtime needs an EOK kernel');
    if (typeof window === 'undefined' || !window.AquinKnowledge) throw new Error('Knowledge Runtime needs aquin-knowledge.js');
    var store = opts.store || window.AquinKnowledge.createKnowledgeStore(opts.storeCfg || {});

    // register as a constitutional subsystem: the kernel calls apply(txn, K) for writes
    kernel.register('knowledge', {
      apply: function (txn) {
        if (txn.type === 'put-concept') return store.putConcept(txn.payload, txn.opts || {});     // may throw -> kernel records 'rejected'
        if (txn.type === 'relate') return store.relate(txn.payload.from, txn.payload.to, txn.payload.type, txn.opts || {});
        if (txn.type === 'retire-relation') return { retired: store.retireRelation(txn.payload.rid, txn.payload.at) };
        throw new Error('knowledge runtime: unknown transaction type "' + txn.type + '"');
      }
    });

    return {
      store: store,
      // governed WRITES (the only mutation path)
      putConcept: function (concept, o) { return kernel.submit({ subsystem: 'knowledge', type: 'put-concept', payload: concept, opts: o, provenance: (o && o.provenance) || { source: 'knowledge-runtime' } }); },
      relate: function (from, to, type, o) { return kernel.submit({ subsystem: 'knowledge', type: 'relate', payload: { from: from, to: to, type: type }, opts: o, provenance: { source: 'knowledge-runtime' } }); },
      // free READS (no mutation)
      getConcept: function (id, o) { return store.getConcept(id, o); },
      relations: function (id, o) { return store.relations(id, o); },
      subgraph: function (seeds, policy) { return store.subgraph(seeds, policy); },
      versionAt: function (t) { return store.versionAt(t); }
    };
  }
  window.AquinKnowledgeRuntime = { createKnowledgeRuntime: createKnowledgeRuntime };
})();
