/*
 * aquin-memory-runtime.js — AES Part V: the Memory Runtime. Educational memory is
 * not one bucket. Grounded in the standard cognitive architecture (Atkinson-Shiffrin
 * / Tulving), this runtime keeps three real stores and moves between them:
 *
 *   - WORKING memory: a small, capacity-limited active set (evicts oldest).
 *   - EPISODIC memory: append-only, provenance-stamped record of what happened.
 *   - SEMANTIC memory: consolidated facts. A pattern that RECURS across episodes is
 *     CONSOLIDATED (promoted) to semantic memory with a strength that grows with
 *     repetition — and decays with time (Ebbinghaus) unless re-encountered.
 *
 * Retrieval ranks by RELEVANCE x RETENTION: a relevant but long-unseen memory is
 * weaker than a relevant recent one. Nothing enters memory without provenance
 * (same constitutional gate as Evidence). No invented CS — this is a classic
 * multi-store memory model with spacing-based consolidation and forgetting.
 *
 * HONEST SCOPE: in-memory three-store model with a real forgetting curve; the
 * forgetting math is the same family as aquin-memory.js/aquin-time.js.
 */
(function () {
  var DAY = 86400000;
  function createMemoryRuntime(cfg) {
    cfg = cfg || {};
    var workingCap = cfg.workingCapacity || 5;
    var consolidateAfter = cfg.consolidateAfter || 3;   // repetitions to promote to semantic
    var now = cfg.now || function () { return Date.now(); };
    var working = [];        // [{ item, at }]
    var episodic = [];       // [{ cue, content, provenance, at }]
    var semantic = {};       // key -> { fact, strength, lastSeen, reps }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: now(), detail: d || null }); }

    function retention(sem, at) {
      var elapsedDays = Math.max(0, (at - sem.lastSeen) / DAY);
      var strengthDays = Math.pow(2, sem.reps - 1);       // stronger memory survives longer (spacing)
      return Math.exp(-elapsedDays / strengthDays);
    }

    var R = {
      provenance: provenance,
      // record an episodic memory (constitutional: needs provenance)
      record: function (ev) {
        if (!ev || !ev.provenance || !ev.provenance.source) return { ok: false, reason: 'memory requires provenance (source)' };
        var at = ev.at != null ? ev.at : now();
        episodic.push({ cue: ev.cue || null, content: ev.content, key: ev.key || ev.cue, provenance: ev.provenance, at: at });
        // touch working memory
        working.push({ item: ev.content, at: at }); if (working.length > workingCap) working.shift();
        rec('record', { key: ev.key || ev.cue });
        return { ok: true };
      },

      // CONSOLIDATION: patterns recurring >= consolidateAfter times become semantic
      consolidate: function () {
        var counts = {};
        episodic.forEach(function (e) { if (e.key != null) (counts[e.key] = counts[e.key] || []).push(e); });
        var promoted = [];
        Object.keys(counts).forEach(function (k) {
          var reps = counts[k].length;
          if (reps >= consolidateAfter) {
            var last = counts[k][counts[k].length - 1];
            semantic[k] = { fact: last.content, strength: Math.min(1, reps / (consolidateAfter + 2)), lastSeen: last.at, reps: reps };
            promoted.push(k);
          }
        });
        rec('consolidate', { promoted: promoted.length });
        return { promoted: promoted };
      },

      // retrieval ranked by RELEVANCE x RETENTION (recency/strength-decayed)
      retrieve: function (cue, opts) {
        opts = opts || {}; var at = opts.at != null ? opts.at : now();
        var out = Object.keys(semantic).map(function (k) {
          var s = semantic[k];
          var relevance = cue == null ? 1 : (String(k).indexOf(String(cue)) >= 0 ? 1 : 0.2);
          var ret = retention(s, at);
          return { key: k, fact: s.fact, relevance: relevance, retention: +ret.toFixed(3), score: +(relevance * ret * s.strength).toFixed(4), reps: s.reps };
        }).filter(function (m) { return m.score > (opts.minScore != null ? opts.minScore : 0.01); })
          .sort(function (a, b) { return b.score - a.score; });
        return out;
      },
      working: function () { return working.map(function (w) { return w.item; }); },
      semanticCount: function () { return Object.keys(semantic).length; },
      episodicCount: function () { return episodic.length; }
    };
    return R;
  }
  window.AquinMemoryRuntime = { createMemoryRuntime: createMemoryRuntime };
})();
