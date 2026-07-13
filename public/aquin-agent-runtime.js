/*
 * aquin-agent-runtime.js — AES-100 Vol III Ch 41: Kernel Autonomous Agent Runtime
 * (KAAR). Agents are first-class kernel-governed Runtime Objects with a persistent
 * IDENTITY, explicit CAPABILITIES, GOALS, a LIFECYCLE, DELEGATION, and a TRUST
 * score — never processes with unrestricted privileges. The kernel stays the
 * supreme authority: an agent can only ever do what it was explicitly granted, in
 * a lifecycle state that permits it. No invented CS — this is a governed actor
 * model + capability security + a finite-state lifecycle.
 *
 * Guarantees proven in the tests:
 *  - LIFECYCLE FSM: created→registered→authenticated→active→idle→archived→retired;
 *    illegal transitions are rejected.
 *  - CAPABILITY SECURITY: an agent refuses any action it was not explicitly granted.
 *  - GOVERNED EXECUTION: an agent cannot execute unless it is in the 'active' state.
 *  - GOALS with sub-goals + progress + success/failure criteria.
 *  - DELEGATION never exceeds policy: work is delegated only to an agent that holds
 *    the required capability; delegating a capability the delegator lacks is denied.
 *  - TRUST updates from outcomes and steers candidate selection.
 *  - HUMAN OVERRIDE is always available; full audit provenance.
 *
 * HONEST SCOPE: the governance/lifecycle/capability/trust logic is real and tested;
 * the C++ kernel, OS scheduling, and network transport of the spec are the declared
 * substrates this control logic sits above.
 */
(function () {
  var LIFECYCLE = ['created', 'registered', 'authenticated', 'active', 'idle', 'archived', 'retired'];
  var TRANSITIONS = {
    created: ['registered'], registered: ['authenticated', 'retired'], authenticated: ['active', 'retired'],
    active: ['idle', 'archived', 'retired'], idle: ['active', 'archived', 'retired'], archived: ['active', 'retired'], retired: []
  };

  function createAgentRuntime(cfg) {
    cfg = cfg || {};
    var agents = {}; var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function registerAgent(spec) {
      if (!spec || !spec.id) throw new Error('agent needs an id');
      agents[spec.id] = {
        id: spec.id, type: spec.type || 'generic', owner: spec.owner || null,
        state: 'created', capabilities: {}, granted: {}, goals: [], handlers: spec.handlers || {},
        trust: { successRate: 0.5, runs: 0, successes: 0, policyViolations: 0 }, version: 1, createdAt: Date.now()
      };
      // registration advances created -> registered
      transition(spec.id, 'registered');
      rec('register-agent', { id: spec.id, type: spec.type });
      return agents[spec.id];
    }

    function transition(id, to) {
      var a = agents[id]; if (!a) return { ok: false, reason: 'no such agent' };
      var allowed = TRANSITIONS[a.state] || [];
      if (allowed.indexOf(to) < 0) { rec('transition-denied', { id: id, from: a.state, to: to }); return { ok: false, reason: 'illegal transition ' + a.state + ' -> ' + to }; }
      a.state = to; rec('transition', { id: id, to: to }); return { ok: true, state: to };
    }

    // capabilities are granted explicitly by the kernel (capability security)
    function grantCapability(id, cap) { var a = agents[id]; if (!a) return false; a.granted[cap] = true; rec('grant', { id: id, cap: cap }); return true; }
    function revokeCapability(id, cap) { var a = agents[id]; if (a) { delete a.granted[cap]; rec('revoke', { id: id, cap: cap }); } return true; }

    // GOVERNED EXECUTION: must be active AND hold the capability
    function execute(id, cap, task) {
      var a = agents[id]; if (!a) return { ok: false, reason: 'no such agent' };
      if (cfg.humanHold) return { ok: false, reason: 'human override: runtime is held', overridden: true };
      if (a.state !== 'active') { rec('exec-denied', { id: id, reason: 'not-active', state: a.state }); return { ok: false, reason: 'agent not active (state ' + a.state + ')' }; }
      if (!a.granted[cap]) { a.trust.policyViolations++; rec('exec-denied', { id: id, reason: 'capability', cap: cap }); return { ok: false, reason: 'capability "' + cap + '" not granted' }; }
      var out; try { out = a.handlers[cap] ? a.handlers[cap](task) : { done: true }; } catch (e) { out = { error: String(e && e.message || e) }; }
      rec('execute', { id: id, cap: cap }); return { ok: true, by: id, result: out };
    }

    // record an outcome -> trust update (steers future delegation)
    function report(id, success) {
      var a = agents[id]; if (!a) return; a.trust.runs++; if (success) a.trust.successes++;
      a.trust.successRate = a.trust.runs ? +(a.trust.successes / a.trust.runs).toFixed(3) : 0.5;
      rec('trust-update', { id: id, successRate: a.trust.successRate });
    }

    // goals with sub-goals + progress
    function assignGoal(id, goal) {
      var a = agents[id]; if (!a) return { ok: false }; var g = { goalId: 'g_' + (a.goals.length + 1), priority: goal.priority || 5, requires: goal.requires || [], progress: 0, subGoals: goal.subGoals || [], success: goal.success || null, done: false };
      a.goals.push(g); rec('assign-goal', { id: id, goal: g.goalId }); return { ok: true, goal: g };
    }

    // DELEGATION: never exceeds policy. Delegate only to an agent holding the cap,
    // and only if the delegator itself holds it (can't grant what you lack).
    function delegate(fromId, cap, task) {
      var from = agents[fromId]; if (!from) return { ok: false, reason: 'no delegator' };
      if (!from.granted[cap]) return { ok: false, reason: 'delegator lacks "' + cap + '" — cannot delegate authority it does not hold' };
      var candidates = Object.keys(agents).filter(function (k) { return k !== fromId && agents[k].granted[cap] && agents[k].state === 'active'; })
        .sort(function (x, y) { return agents[y].trust.successRate - agents[x].trust.successRate; });  // highest trust first
      if (!candidates.length) { rec('delegate-fail', { from: fromId, cap: cap }); return { ok: false, reason: 'no capable, active agent for "' + cap + '"' }; }
      var chosen = candidates[0];
      var res = execute(chosen, cap, task);
      rec('delegate', { from: fromId, to: chosen, cap: cap });
      return { ok: res.ok, delegatedTo: chosen, trust: agents[chosen].trust.successRate, result: res };
    }

    return {
      provenance: provenance, LIFECYCLE: LIFECYCLE,
      registerAgent: registerAgent, transition: transition,
      grantCapability: grantCapability, revokeCapability: revokeCapability,
      execute: execute, report: report, assignGoal: assignGoal, delegate: delegate,
      agent: function (id) { return agents[id]; }, agents: function () { return Object.keys(agents); },
      // human override — always available
      hold: function () { cfg.humanHold = true; rec('human-hold', {}); }, release: function () { cfg.humanHold = false; rec('human-release', {}); }
    };
  }
  window.AquinAgentRuntime = { LIFECYCLE: LIFECYCLE, createAgentRuntime: createAgentRuntime };
})();
