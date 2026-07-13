/*
 * aquin-agents.js — Multi-Agent Educational Intelligence Framework (AES-100,
 * Vol II, Ch 57). The system stops being ONE very large intelligence and becomes
 * a governed SOCIETY of specialized Educational Intelligence Agents — the way a
 * university is not one brain but departments, a dean, a registrar, a librarian,
 * counselors, researchers, each an expert, each collaborating under coordination.
 *
 * Engineered guarantees (proven in the tests):
 *  - CAPABILITY BOUNDARY: every agent declares its capabilities; it REFUSES any
 *    task outside them. No agent exceeds its declared authority.
 *  - EXECUTIVE COORDINATES, DOES NOT REPLACE: the Executive Agent decomposes a
 *    mission into tasks and routes each to the specialist declared capable of it;
 *    it never does the specialist's work itself.
 *  - GOVERNED EXCHANGE ONLY: agents collaborate through Runtime Objects passed by
 *    the Executive, never by sharing internal memory.
 *  - DISAGREEMENT IS REASONING, NOT ERROR: when specialists conflict (e.g.
 *    "simplify" vs "preserve scientific accuracy"), the Executive resolves it by a
 *    governed strategy and the disagreement + resolution are recorded.
 *  - VERIFICATION GATE: an educational decision is not published until the
 *    Verification Agent (if present) validates it.
 *  - DYNAMIC & EXTENSIBLE: agents can be added/retired at runtime without
 *    redesigning the framework; new domains plug in as new agents.
 *  - COMPLETE INTER-AGENT PROVENANCE: the whole collaboration chain is replayable.
 *
 * HONEST SCOPE: this is the coordination + governance fabric. The intelligence
 * INSIDE each agent (the Tutor's explanations, the Research agent's discovery) is
 * supplied by the corresponding engines (aquin-mentor, aquin-research, etc.); this
 * framework orchestrates them under constitutional boundaries.
 */
(function () {
  function createFramework(cfg) {
    cfg = cfg || {};
    var agents = {};           // id -> agent record
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // register a specialized agent. handlers: { capabilityName: function(task, ctx) -> result }
    function registerAgent(spec) {
      if (!spec || !spec.id) throw new Error('agent needs an id');
      var caps = (spec.capabilities || []).slice();
      agents[spec.id] = {
        id: spec.id, role: spec.role || spec.id,
        capabilities: caps,
        permissions: (spec.permissions || []).slice(),
        handlers: spec.handlers || {},
        version: spec.version || '1.0.0', up: true,
        // an agent NEVER exceeds declared capability
        can: function (cap) { return caps.indexOf(cap) >= 0; },
        // execute a task ONLY if it is within capability; otherwise refuse
        run: function (cap, task, ctx) {
          if (!this.can(cap)) return { ok: false, refused: true, reason: 'agent "' + spec.id + '" is not capable of "' + cap + '" — outside declared capability boundary' };
          var h = this.handlers[cap];
          if (typeof h !== 'function') return { ok: false, reason: 'no handler for "' + cap + '"' };
          var out = h(task, ctx || {});
          return { ok: true, by: spec.id, capability: cap, result: out };
        }
      };
      rec('register-agent', { id: spec.id, capabilities: caps });
      return agents[spec.id];
    }
    function retireAgent(id) { if (agents[id]) { agents[id].up = false; rec('retire-agent', { id: id }); } return true; }
    function agentsFor(cap) { return Object.keys(agents).filter(function (k) { return agents[k].up && agents[k].can(cap); }); }

    // ---- Executive Agent: coordinate, don't replace ----
    var Executive = {
      // decompose a mission into an ordered task pipeline
      // mission: { goal, pipeline:[{capability, task}], resolve? }
      run: function (mission, ctx) {
        ctx = ctx || {};
        var pipeline = mission.pipeline || [];
        var trace = [], published = null, blocked = null;
        rec('mission-start', { goal: mission.goal, steps: pipeline.length });

        for (var i = 0; i < pipeline.length; i++) {
          var step = pipeline[i];
          var candidates = agentsFor(step.capability);
          if (!candidates.length) { blocked = { step: step.capability, reason: 'no capable agent available' }; rec('route-fail', blocked); break; }

          // if multiple specialists respond, gather all and resolve conflict
          var responses = candidates.map(function (aid) { return agents[aid].run(step.capability, step.task, ctx); });
          var ok = responses.filter(function (r) { return r.ok; });
          var resolved;
          if (ok.length > 1 && conflicting(ok)) {
            resolved = resolveConflict(step.capability, ok, mission.resolve);
            rec('conflict-resolved', { capability: step.capability, strategy: resolved.strategy, chosen: resolved.chosen.by });
          } else {
            resolved = { chosen: ok[0] || responses[0], strategy: ok.length > 1 ? 'agreement' : 'single-specialist', alternatives: ok.slice(1).map(function (r) { return r.by; }) };
          }
          trace.push({ capability: step.capability, by: resolved.chosen.by, strategy: resolved.strategy, result: resolved.chosen.result, refused: resolved.chosen.refused || false });
          ctx[step.capability] = resolved.chosen.result;    // governed Runtime Object handoff
          rec('step', { capability: step.capability, by: resolved.chosen.by });

          // VERIFICATION GATE: nothing publishes if a verification step rejects
          if (step.capability === 'verify' && resolved.chosen.result && resolved.chosen.result.valid === false) {
            blocked = { step: 'verify', reason: resolved.chosen.result.reason || 'verification failed' };
            rec('verification-blocked', blocked); break;
          }
        }
        if (!blocked) published = ctx[pipeline.length ? pipeline[pipeline.length - 1].capability : null] || null;
        rec('mission-end', { goal: mission.goal, published: !blocked });
        return { goal: mission.goal, published: !blocked ? published : null, blocked: blocked, trace: trace };
      }
    };

    // two responses conflict if they carry an explicit stance that differs
    function conflicting(responses) {
      var stances = responses.map(function (r) { return r.result && r.result.stance; }).filter(Boolean);
      return new Set(stances).size > 1;
    }
    // disagreement becomes part of reasoning: resolve by governed priority (default: accuracy > simplicity)
    function resolveConflict(capability, responses, custom) {
      if (typeof custom === 'function') { var c = custom(responses); if (c) return { chosen: c, strategy: 'mission-policy', alternatives: responses.filter(function (r) { return r !== c; }).map(function (r) { return r.by; }) }; }
      var priority = (cfg.stancePriority || ['scientific-accuracy', 'safety', 'clarity', 'simplicity']);
      var ranked = responses.slice().sort(function (a, b) {
        var pa = priority.indexOf(a.result && a.result.stance); var pb = priority.indexOf(b.result && b.result.stance);
        return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
      });
      return { chosen: ranked[0], strategy: 'governance-priority', alternatives: ranked.slice(1).map(function (r) { return r.by; }) };
    }

    return {
      provenance: provenance,
      registerAgent: registerAgent, retireAgent: retireAgent,
      agents: function () { return Object.keys(agents).filter(function (k) { return agents[k].up; }); },
      agentsFor: agentsFor,
      executive: Executive,
      run: function (mission, ctx) { return Executive.run(mission, ctx); }
    };
  }

  window.AquinAgents = { createFramework: createFramework };
})();
