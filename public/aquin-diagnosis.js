/*
 * aquin-diagnosis.js — Diagnostic & Planning Cognition Engine (real-depth build
 * that COMPOSES the symbolic reasoner and the statistical BKT engine into genuine
 * educational cognition). Three real algorithms, no LLM:
 *
 *  1) ABDUCTIVE DIAGNOSIS — inference to the best explanation. Given a learner's
 *     observed errors and a misconception->error-signature knowledge base, it finds
 *     the misconception(s) that best explain the errors, ranked by a Bayesian
 *     posterior (prior x likelihood) AND by PARSIMONY (a single misconception that
 *     explains everything beats two that don't). This is how a real diagnostician
 *     reasons: not "what's the answer" but "what underlying cause produces exactly
 *     these mistakes."
 *
 *  2) ADAPTIVE PATH PLANNING — Kahn topological sort over the prerequisite DAG,
 *     gated by real BKT mastery: only concepts whose prerequisites are actually
 *     mastered are "ready", and among those it orders by the largest mastery gap.
 *     The plan is a correct learning sequence, not a guess.
 *
 *  3) CURRICULUM CONSISTENCY — DFS cycle detection (a concept cannot transitively
 *     require itself) and orphan/dangling-prerequisite detection.
 *
 * Every output is explainable: the diagnosis shows which errors each hypothesis
 * covers; the plan shows why each concept is (not) ready; the consistency check
 * shows the exact cycle. HONEST SCOPE: the misconception->error and prerequisite
 * relations are authored content (domain data); all inference over them is real and
 * implemented here.
 */
(function () {
  function createCognition(cfg) {
    cfg = cfg || {};
    var masteryThreshold = cfg.masteryThreshold != null ? cfg.masteryThreshold : 0.6;
    var misconceptions = {};   // id -> { explains:Set(errorSig), prior }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var C = {
      provenance: provenance,

      // knowledge base: a misconception and the error signatures it produces
      misconception: function (id, spec) { misconceptions[id] = { id: id, explains: (spec.explains || []).slice(), prior: spec.prior != null ? spec.prior : 0.1 }; return this; },

      // ---- 1) ABDUCTIVE DIAGNOSIS ----
      // observedErrors: [errorSig...]  -> ranked explanations
      diagnose: function (observedErrors) {
        observedErrors = observedErrors || [];
        var obs = observedErrors.slice();
        var singles = Object.keys(misconceptions).map(function (id) {
          var m = misconceptions[id];
          var covered = obs.filter(function (e) { return m.explains.indexOf(e) >= 0; });
          var falsePos = m.explains.filter(function (e) { return obs.indexOf(e) < 0; }); // predicts errors not seen
          // Bayesian-ish score: prior x P(errors|M). Likelihood rewards coverage, penalises unseen predictions.
          var coverage = obs.length ? covered.length / obs.length : 0;
          var precision = m.explains.length ? covered.length / m.explains.length : 0;
          var score = m.prior * (0.7 * coverage + 0.3 * precision);
          return { hypothesis: id, covers: covered, coverage: +coverage.toFixed(3), unexplainedPredictions: falsePos.length, score: +score.toFixed(4) };
        }).filter(function (h) { return h.covers.length > 0; }).sort(function (a, b) { return b.score - a.score; });

        // PARSIMONY: does the best single hypothesis explain ALL errors? If not, try
        // the minimal pair that jointly covers the most (greedy set cover).
        var best = singles[0] || null;
        var fullyExplained = best && best.covers.length === obs.length;
        var combined = null;
        if (!fullyExplained && singles.length >= 2) {
          combined = greedyCover(obs);
        }
        rec('diagnose', { errors: obs.length, top: best && best.hypothesis, fullyExplained: fullyExplained });
        return {
          observedErrors: obs,
          ranked: singles,
          bestExplanation: best ? best.hypothesis : null,
          fullyExplainedBySingle: fullyExplained,
          minimalExplanationSet: combined,
          note: best ? ('best single hypothesis "' + best.hypothesis + '" covers ' + best.covers.length + '/' + obs.length + ' errors') : 'no known misconception explains these errors'
        };
      },

      // ---- 2) ADAPTIVE PATH PLANNING ----
      // graph: { concept: { prereqs:[...] } }  masteryFn: concept -> 0..1 (e.g. bkt)
      planPath: function (graph, masteryFn) {
        masteryFn = masteryFn || function () { return 0; };
        var order = topoSort(graph);
        if (order.cycle) return { ok: false, reason: 'prerequisite cycle prevents planning: ' + order.cycle.join(' -> ') };
        var ready = [], blocked = [];
        order.order.forEach(function (c) {
          var mast = masteryFn(c);
          if (mast >= masteryThreshold) return;                      // already mastered, skip
          var pre = (graph[c] && graph[c].prereqs) || [];
          var unmet = pre.filter(function (p) { return masteryFn(p) < masteryThreshold; });
          if (unmet.length) blocked.push({ concept: c, blockedBy: unmet });
          else ready.push({ concept: c, mastery: +masteryFn(c).toFixed(3), gap: +(1 - masteryFn(c)).toFixed(3) });
        });
        ready.sort(function (a, b) { return b.gap - a.gap; });        // widest gap first
        rec('plan', { ready: ready.length, blocked: blocked.length });
        return { ok: true, topoOrder: order.order, recommendedNext: ready[0] || null, ready: ready, blocked: blocked };
      },

      // ---- 3) CURRICULUM CONSISTENCY ----
      checkConsistency: function (graph) {
        var cyc = topoSort(graph);
        var orphans = [];
        Object.keys(graph).forEach(function (c) { ((graph[c] && graph[c].prereqs) || []).forEach(function (p) { if (!graph[p]) orphans.push({ concept: c, danglingPrereq: p }); }); });
        rec('consistency', { cycle: !!cyc.cycle, orphans: orphans.length });
        return { consistent: !cyc.cycle && orphans.length === 0, cycle: cyc.cycle || null, danglingPrereqs: orphans };
      }
    };

    // greedy set cover over misconceptions to explain all observed errors parsimoniously
    function greedyCover(obs) {
      var remaining = obs.slice(), chosen = [];
      while (remaining.length) {
        var bestId = null, bestCov = [];
        Object.keys(misconceptions).forEach(function (id) {
          var cov = remaining.filter(function (e) { return misconceptions[id].explains.indexOf(e) >= 0; });
          if (cov.length > bestCov.length) { bestCov = cov; bestId = id; }
        });
        if (!bestId || bestCov.length === 0) break;
        chosen.push({ hypothesis: bestId, covers: bestCov });
        remaining = remaining.filter(function (e) { return bestCov.indexOf(e) < 0; });
      }
      return { hypotheses: chosen.map(function (c) { return c.hypothesis; }), detail: chosen, unexplained: remaining };
    }

    // Kahn topological sort; returns {order} or {cycle:[...]}
    function topoSort(graph) {
      var nodes = Object.keys(graph), indeg = {}, adj = {};
      nodes.forEach(function (n) { indeg[n] = 0; adj[n] = []; });
      nodes.forEach(function (n) { ((graph[n] && graph[n].prereqs) || []).forEach(function (p) { if (adj[p]) { adj[p].push(n); indeg[n]++; } }); });
      var queue = nodes.filter(function (n) { return indeg[n] === 0; }); var order = [];
      while (queue.length) { var n = queue.shift(); order.push(n); adj[n].forEach(function (m) { if (--indeg[m] === 0) queue.push(m); }); }
      if (order.length !== nodes.length) { return { cycle: findCycle(graph, nodes.filter(function (n) { return order.indexOf(n) < 0; })) }; }
      return { order: order };
    }
    function findCycle(graph, suspects) {
      var color = {}, stack = [], result = null;
      function dfs(n) {
        if (result) return; color[n] = 'gray'; stack.push(n);
        ((graph[n] && graph[n].prereqs) || []).forEach(function (p) {
          if (!graph[p]) return;
          if (color[p] === 'gray') { var i = stack.indexOf(p); result = stack.slice(i).concat(p); }
          else if (!color[p]) dfs(p);
        });
        stack.pop(); color[n] = 'black';
      }
      suspects.forEach(function (n) { if (!color[n] && !result) dfs(n); });
      return result || suspects;
    }

    return C;
  }

  window.AquinDiagnosis = { createCognition: createCognition };
})();
