/*
 * aquin-multiagent.js — AES-100 Vol III Part II Ch 19: Autonomous Multi-Agent
 * Intelligence Framework (AMAIF). Coordinates many specialized agents. It composes
 * (not duplicates) the earlier agent engines (aquin-agents.js Executive routing,
 * aquin-agent-runtime.js lifecycle/trust) by adding the two CLASSIC named multi-
 * agent coordination algorithms:
 *
 *  - CONTRACT NET PROTOCOL (Smith 1980): a manager ANNOUNCES a task; capable agents
 *    submit BIDS (cost/fit); the manager AWARDS it to the best bid. Decentralised
 *    task allocation with no central assignment table.
 *  - BLACKBOARD ARCHITECTURE (Hearsay-II): a shared blackboard holds partial
 *    results; knowledge-source agents watch it and OPPORTUNISTICALLY contribute when
 *    their precondition appears, so a partial solution unlocks the next step.
 *  - TASK DECOMPOSITION + allocation, and majority CONSENSUS voting.
 *
 * HONEST SCOPE: the coordination algorithms (contract-net, blackboard, consensus)
 * are real and tested; the intelligence inside each agent is supplied by the domain
 * engines it wraps. (~M-LOC C++ multi-agent platform → the coordination core.)
 */
(function () {
  function createSociety() {
    var agents = {};    // id -> { capabilities, capacity, bidFn }
    var blackboard = {}; // key -> value  (shared partial solutions)
    var knowledgeSources = []; // { precondition(bb), contribute(bb) }
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var S = {
      provenance: provenance,
      agent: function (id, spec) { agents[id] = { id: id, capabilities: (spec.capabilities || []).slice(), capacity: spec.capacity != null ? spec.capacity : 1, bid: spec.bid || null }; return this; },

      // CONTRACT NET: announce -> collect bids -> award to best
      announce: function (task) {
        var bids = Object.keys(agents).map(function (aid) {
          var a = agents[aid];
          if (a.capabilities.indexOf(task.capability) < 0 || a.capacity <= 0) return null;
          var cost = a.bid ? a.bid(task) : (1 / (a.capacity));   // default: cheaper if more capacity
          return { agent: aid, cost: +cost.toFixed(3) };
        }).filter(Boolean).sort(function (x, y) { return x.cost - y.cost; });   // lowest cost wins
        if (!bids.length) { rec('announce-fail', { capability: task.capability }); return { ok: false, reason: 'no capable agent bid on "' + task.capability + '"', task: task.id }; }
        var winner = bids[0]; agents[winner.agent].capacity--;   // reserve capacity
        rec('award', { task: task.id, to: winner.agent, cost: winner.cost });
        return { ok: true, task: task.id, awardedTo: winner.agent, winningCost: winner.cost, bids: bids };
      },

      // decompose a goal into subtasks and allocate each via contract net
      decomposeAndAllocate: function (subtasks) {
        return subtasks.map(function (t) { var r = S.announce(t); return { task: t.id, capability: t.capability, awardedTo: r.ok ? r.awardedTo : null, unassigned: !r.ok }; });
      },

      // BLACKBOARD: post a partial result, then run any triggered knowledge sources
      knowledgeSource: function (ks) { knowledgeSources.push(ks); return this; },
      post: function (key, value) { blackboard[key] = value; rec('bb-post', { key: key }); return this; },
      // opportunistic cycle: run every KS whose precondition now holds, until quiescent
      solve: function (maxCycles) {
        maxCycles = maxCycles || 20; var fired = [];
        for (var c = 0; c < maxCycles; c++) {
          var any = false;
          knowledgeSources.forEach(function (ks, i) {
            if (!ks._done && ks.precondition(blackboard)) { var out = ks.contribute(blackboard); ks._done = true; any = true; fired.push(ks.name || ('ks' + i)); Object.assign(blackboard, out || {}); }
          });
          if (!any) break;
        }
        rec('bb-solve', { fired: fired.length });
        return { fired: fired, blackboard: JSON.parse(JSON.stringify(blackboard)) };
      },
      blackboard: function () { return JSON.parse(JSON.stringify(blackboard)); },

      // majority consensus among agents' votes
      consensus: function (votes) {
        var tally = {}; votes.forEach(function (v) { tally[v] = (tally[v] || 0) + 1; });
        var ranked = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; });
        var top = ranked[0], majority = tally[top] > votes.length / 2;
        return { decision: top, count: tally[top], total: votes.length, majority: majority, tally: tally };
      }
    };
    return S;
  }
  window.AquinMultiAgent = { createSociety: createSociety };
})();
