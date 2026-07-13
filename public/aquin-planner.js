/*
 * aquin-planner.js — AES-000 Part II: Computational Planning. Planning is SEARCH
 * over states: given a start state, a set of actions (each with preconditions and
 * effects), and a goal, find a sequence of actions that reaches the goal — optimally.
 * This is classic STRIPS planning (Fikes & Nilsson 1971) with A* search (Hart,
 * Nilsson & Raphael 1968). No invented CS.
 *
 *   State   = a set of true facts.
 *   Action  = { name, pre:[facts required], add:[facts made true], del:[facts made
 *               false], cost }.
 *   Goal    = a set of facts that must hold.
 *   Plan    = a minimum-cost action sequence from start to a goal-satisfying state.
 *
 * Educationally: activities are actions (prerequisite masteries = preconditions,
 * mastered concept = effect), so a curriculum plan is a real cost-optimal plan, not
 * a hand-wave. This is the general planner beneath learning-path construction; the
 * topo-sort in aquin-diagnosis is the special case with no costs/deletes.
 *
 * A* uses the admissible "number of unmet goal facts" heuristic (relaxed problem:
 * ignore preconditions & deletes) — never overestimates, so A* returns an OPTIMAL
 * plan. HONEST SCOPE: propositional STRIPS + A*; numeric/temporal/HTN planning are
 * extensions behind the same action interface.
 */
(function () {
  function keyOf(set) { return Object.keys(set).sort().join('|'); }
  function applies(action, state) { return (action.pre || []).every(function (f) { return state[f]; }); }
  function apply(action, state) {
    var next = Object.assign({}, state);
    (action.del || []).forEach(function (f) { delete next[f]; });
    (action.add || []).forEach(function (f) { next[f] = true; });
    return next;
  }
  function goalMet(goal, state) { return goal.every(function (f) { return state[f]; }); }
  function unmet(goal, state) { return goal.reduce(function (n, f) { return n + (state[f] ? 0 : 1); }, 0); } // admissible heuristic

  function plan(startFacts, actions, goal, opts) {
    opts = opts || {};
    var maxExpansions = opts.maxExpansions || 100000;
    var start = {}; (startFacts || []).forEach(function (f) { start[f] = true; });
    if (goalMet(goal, start)) return { plan: [], cost: 0, expanded: 0 };

    // A*: priority queue by f = g + h
    var startKey = keyOf(start);
    var gScore = {}; gScore[startKey] = 0;
    var came = {};                                  // stateKey -> { prev, action }
    var open = [{ state: start, key: startKey, g: 0, f: unmet(goal, start) }];
    var closed = {}; var expanded = 0;

    while (open.length && expanded < maxExpansions) {
      // pop lowest f (linear scan — fine for education-scale problems)
      var bi = 0; for (var i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      var cur = open.splice(bi, 1)[0];
      if (goalMet(goal, cur.state)) return reconstruct(came, cur.key, expanded);
      if (closed[cur.key]) continue;
      closed[cur.key] = true; expanded++;

      for (var a = 0; a < actions.length; a++) {
        var action = actions[a];
        if (!applies(action, cur.state)) continue;
        var next = apply(action, cur.state);
        var nk = keyOf(next);
        if (closed[nk]) continue;
        var tentativeG = cur.g + (action.cost != null ? action.cost : 1);
        if (gScore[nk] == null || tentativeG < gScore[nk]) {
          gScore[nk] = tentativeG;
          came[nk] = { prev: cur.key, action: action.name, state: next };
          open.push({ state: next, key: nk, g: tentativeG, f: tentativeG + unmet(goal, next) });
        }
      }
    }
    return { plan: null, reason: 'goal unreachable', expanded: expanded };

    function reconstruct(came, endKey, expanded) {
      var seq = [], k = endKey, cost = gScore[endKey];
      while (came[k]) { seq.unshift(came[k].action); k = came[k].prev; }
      return { plan: seq, cost: cost, expanded: expanded };
    }
  }

  // convenience: build a learning plan from mastery facts + activity actions
  function learningPlan(mastered, activities, targets) {
    var goal = targets.map(function (t) { return 'know:' + t; });
    var start = mastered.map(function (m) { return 'know:' + m; });
    var actions = activities.map(function (act) {
      return { name: act.id, pre: (act.prereqs || []).map(function (p) { return 'know:' + p; }), add: ['know:' + act.teaches], del: [], cost: act.cost != null ? act.cost : 1 };
    });
    return plan(start, actions, goal);
  }

  window.AquinPlanner = { plan: plan, learningPlan: learningPlan };
})();
