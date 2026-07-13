/*
 * aquin-creativity.js — AES-000 Ch 24: "What is Educational Creativity?" as CODE.
 * Creativity is NOT randomness. The standard definition (Boden; Runco & Jaeger):
 * an idea is creative iff it is BOTH novel AND valuable (appropriate). This engine
 * implements that, grounded in named prior art — no invented computer science:
 *
 *   - COMBINATIONAL creativity (Boden): bridge two DISTANT concepts. Novelty is the
 *     graph distance between them (farther = more novel); value is the structural
 *     overlap that makes the bridge legitimate (shared features / relation types).
 *     Score = novelty x value; noise (novel but valueless) is filtered out.
 *   - ANALOGICAL transfer (Gentner structure-mapping theory): map one concept's
 *     RELATIONAL structure onto another domain — the solar-system <-> atom mapping
 *     falls out of matching relation types, not surface features.
 *   - EXPLORATORY creativity: generate novel problem framings for a concept by
 *     recombining its relations under a constraint.
 *
 * Educationally this is how a tutor invents a fresh analogy or a novel worked
 * example instead of repeating the textbook. HONEST SCOPE: combinational + analogical
 * creativity over a supplied concept graph; the "value" judgement uses structural
 * overlap (a real, computable proxy) — deeper semantic valuation is a Ch 18 (Truth)
 * concern layered on top.
 */
(function () {
  function createCreativity() {
    var nodes = {};   // id -> { id, domain, features:Set }
    var edges = [];   // { a, b, type }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function neighbors(id) { var out = {}; edges.forEach(function (e) { if (e.a === id) out[e.b] = 1; if (e.b === id) out[e.a] = 1; }); return Object.keys(out); }
    // BFS shortest-path distance (novelty proxy): far concepts = more novel to bridge
    function distance(a, b) {
      if (a === b) return 0;
      var seen = {}; seen[a] = true; var q = [[a, 0]];
      while (q.length) { var cur = q.shift(); var nb = neighbors(cur[0]); for (var i = 0; i < nb.length; i++) { if (nb[i] === b) return cur[1] + 1; if (!seen[nb[i]]) { seen[nb[i]] = true; q.push([nb[i], cur[1] + 1]); } } }
      return Infinity; // disconnected — maximally distant
    }
    function shared(a, b) {
      var fa = nodes[a] ? nodes[a].features : [], fb = nodes[b] ? nodes[b].features : [];
      return fa.filter(function (f) { return fb.indexOf(f) >= 0; });
    }

    var C = {
      provenance: provenance,
      concept: function (id, spec) { spec = spec || {}; nodes[id] = { id: id, domain: spec.domain || 'general', features: (spec.features || []).slice() }; return this; },
      relate: function (a, b, type) { edges.push({ a: a, b: b, type: type || 'related' }); return this; },

      // COMBINATIONAL creativity: rank novel-yet-valuable concept bridges
      combine: function (opts) {
        opts = opts || {};
        var minNovelty = opts.minNovelty != null ? opts.minNovelty : 2;   // must be at least this far apart
        var ids = Object.keys(nodes), out = [];
        for (var i = 0; i < ids.length; i++) for (var j = i + 1; j < ids.length; j++) {
          var a = ids[i], b = ids[j];
          var d = distance(a, b);
          var novelty = d === Infinity ? 1 : Math.min(1, (d - 1) / 4);     // 0 (adjacent) .. 1 (far/disconnected)
          if (d < minNovelty) continue;                                    // too obvious to be novel
          var sh = shared(a, b);
          var value = Math.min(1, sh.length / 2);                          // structural overlap => a valid bridge
          var score = +(novelty * value).toFixed(3);
          if (value > 0) out.push({ bridge: [a, b], distance: d, novelty: +novelty.toFixed(3), value: +value.toFixed(3), via: sh, creativity: score });
        }
        out.sort(function (x, y) { return y.creativity - x.creativity; });
        rec('combine', { candidates: out.length });
        return out;
      },

      // ANALOGICAL transfer (Gentner structure-mapping): map source relations onto target
      analogy: function (sourceId, targetId) {
        var srcRels = edges.filter(function (e) { return e.a === sourceId || e.b === sourceId; });
        var tgtRels = edges.filter(function (e) { return e.a === targetId || e.b === targetId; });
        // match by RELATION TYPE (structure, not surface); build role correspondences
        var mapping = [];
        srcRels.forEach(function (sr) {
          var sOther = sr.a === sourceId ? sr.b : sr.a;
          var match = tgtRels.filter(function (tr) { return tr.type === sr.type; })[0];
          if (match) { var tOther = match.a === targetId ? match.b : match.a; mapping.push({ relation: sr.type, source: sOther, maps_to: tOther }); }
        });
        rec('analogy', { source: sourceId, target: targetId, mapped: mapping.length });
        return {
          source: sourceId, target: targetId,
          systematicity: mapping.length,                 // Gentner: prefer mappings that preserve MORE relations
          mapping: mapping,
          valid: mapping.length >= 1,
          note: mapping.length ? sourceId + ' is to its parts as ' + targetId + ' is to its parts (structure preserved)' : 'no shared relational structure'
        };
      },

      // score an arbitrary idea by the novelty x value definition
      score: function (a, b) {
        var d = distance(a, b), sh = shared(a, b);
        var novelty = d === Infinity ? 1 : Math.min(1, (d - 1) / 4);
        var value = Math.min(1, sh.length / 2);
        return { novelty: +novelty.toFixed(3), value: +value.toFixed(3), creative: novelty > 0.3 && value > 0, reason: novelty <= 0.3 ? 'too obvious (low novelty)' : value === 0 ? 'novel but no valid bridge (not appropriate)' : 'novel AND valuable' };
      },
      distance: distance
    };
    return C;
  }
  window.AquinCreativity = { createCreativity: createCreativity };
})();
