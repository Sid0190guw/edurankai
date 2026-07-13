/*
 * aquin-curriculum.js — AES Part IV: the Curriculum Planner. Single-step "what
 * next" is aquin-diagnosis.planPath; this builds a WHOLE personalized curriculum to
 * a goal: a prerequisite-respecting sequence, per-concept effort estimates from
 * current mastery, and SPACED REVIEW checkpoints interleaved so earlier concepts
 * are re-touched before they are forgotten. It composes the STRIPS planner (order),
 * BKT mastery (what's needed + effort), and the forgetting model (when to review).
 *
 * Grounded: Kahn topological order (prerequisites), mastery-learning (Bloom — only
 * advance when the prerequisite is mastered), spaced repetition (Ebbinghaus). No
 * invented CS.
 *
 * HONEST SCOPE: sequencing + effort + review scheduling over a supplied concept DAG
 * and a mastery function (from BKT). Real-time re-planning is `plan()` re-run with
 * updated mastery — it is deterministic given the same inputs.
 */
(function () {
  function createCurriculum(cfg) {
    cfg = cfg || {};
    var masteryThreshold = cfg.masteryThreshold != null ? cfg.masteryThreshold : 0.85;
    var sessionsPerLevel = cfg.sessionsPerLevel || 3;      // effort to move a concept ~one band
    var reviewEveryN = cfg.reviewEveryN || 3;              // interleave a review checkpoint every N new concepts

    function prereqs(graph, id) { return (graph[id] && graph[id].prereqs) || []; }

    // topological order over only the concepts needed to reach the goals
    function neededClosure(graph, goals) {
      var need = {}, stack = goals.slice();
      while (stack.length) { var c = stack.pop(); if (need[c]) continue; need[c] = true; prereqs(graph, c).forEach(function (p) { stack.push(p); }); }
      return Object.keys(need);
    }
    function topoOrder(graph, ids) {
      var indeg = {}, adj = {}; ids.forEach(function (n) { indeg[n] = 0; adj[n] = []; });
      ids.forEach(function (n) { prereqs(graph, n).forEach(function (p) { if (adj[p]) { adj[p].push(n); indeg[n]++; } }); });
      var q = ids.filter(function (n) { return indeg[n] === 0; }), order = [];
      // deterministic: stable order by id within each indegree tier
      q.sort();
      while (q.length) { var n = q.shift(); order.push(n); adj[n].sort().forEach(function (m) { if (--indeg[m] === 0) { q.push(m); q.sort(); } }); }
      return order.length === ids.length ? order : null;   // null => cycle
    }

    function effortFor(mastery) {
      // sessions to reach the mastery threshold, ~proportional to the gap
      var gap = Math.max(0, masteryThreshold - mastery);
      return Math.ceil(gap / (masteryThreshold) * sessionsPerLevel) || (mastery >= masteryThreshold ? 0 : 1);
    }

    function plan(graph, masteryFn, goals) {
      masteryFn = masteryFn || function () { return 0; };
      var ids = neededClosure(graph, goals);
      var order = topoOrder(graph, ids);
      if (!order) return { ok: false, reason: 'prerequisite cycle — cannot sequence' };

      var steps = [], learned = [], newSinceReview = 0, totalSessions = 0;
      order.forEach(function (c) {
        var m = masteryFn(c);
        if (m >= masteryThreshold) { learned.push(c); return; }      // already mastered — skip
        var effort = effortFor(m);
        totalSessions += effort;
        steps.push({ kind: 'learn', concept: c, currentMastery: +m.toFixed(3), estimatedSessions: effort, unlocks: order.filter(function (x) { return prereqs(graph, x).indexOf(c) >= 0; }) });
        learned.push(c); newSinceReview++;
        // interleave a spaced-review checkpoint of earlier concepts
        if (newSinceReview >= reviewEveryN) {
          var reviewSet = learned.slice(-reviewEveryN - 1, -1);
          if (reviewSet.length) { steps.push({ kind: 'review', concepts: reviewSet, why: 'spaced review before forgetting (Ebbinghaus)' }); totalSessions += 1; }
          newSinceReview = 0;
        }
      });
      return {
        ok: true, goals: goals, totalConcepts: order.length, toLearn: steps.filter(function (s) { return s.kind === 'learn'; }).length,
        estimatedSessions: totalSessions, sequence: steps,
        firstUp: steps.filter(function (s) { return s.kind === 'learn'; })[0] || null
      };
    }

    return { plan: plan };
  }
  window.AquinCurriculum = { createCurriculum: createCurriculum };
})();
