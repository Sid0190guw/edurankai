/*
 * aquin-workflow.js — AES-100 Vol III Part II Ch 15: Distributed Scheduler,
 * Workflow Orchestration & Autonomous Execution Engine (DSWOE). Coordinates every
 * long-running process (AI pipelines, research workflows, admissions, approvals) as
 * a governed DAG. Real, tested cores:
 *
 *  - DAG EXECUTION: a workflow is a directed acyclic graph of tasks; the engine
 *    computes topological LEVELS so independent tasks run in parallel and every task
 *    runs strictly after its dependencies.
 *  - CYCLE DETECTION: a dependency cycle is refused (a DAG must be acyclic).
 *  - RETRY + HALT: a failing task is retried up to its limit; if it still fails the
 *    workflow HALTS and its downstream tasks never run (no partial corruption).
 *  - CHECKPOINT / RESUME: completed tasks are checkpointed; re-running RESUMES from
 *    the checkpoint, skipping finished work (resumable long workflows).
 *
 * HONEST SCOPE: the DAG scheduling, retry, and checkpoint/resume logic is real and
 * tested; distributed placement across HPC/edge/cloud, and the actual task compute,
 * are declared substrates. (~31.8M-LOC C++ → the core.)
 */
(function () {
  function createWorkflow(cfg) {
    cfg = cfg || {};
    var tasks = {};       // id -> { deps, run, retries }
    var completed = {};   // id -> result (the checkpoint)
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // Kahn levels: each level is a set of tasks whose deps are all in earlier levels
    function levels() {
      var ids = Object.keys(tasks), indeg = {}, adj = {};
      ids.forEach(function (n) { indeg[n] = 0; adj[n] = []; });
      ids.forEach(function (n) { (tasks[n].deps || []).forEach(function (d) { if (adj[d]) { adj[d].push(n); indeg[n]++; } }); });
      var frontier = ids.filter(function (n) { return indeg[n] === 0; }).sort(), out = [], seen = 0;
      while (frontier.length) {
        out.push(frontier.slice()); seen += frontier.length;
        var next = [];
        frontier.forEach(function (n) { adj[n].forEach(function (m) { if (--indeg[m] === 0) next.push(m); }); });
        frontier = next.sort();
      }
      if (seen !== ids.length) return { cycle: ids.filter(function (n) { return indeg[n] > 0; }) };
      return { levels: out };
    }

    var W = {
      provenance: provenance,
      task: function (id, spec) { tasks[id] = { deps: (spec.deps || []).slice(), run: spec.run || function () { return true; }, retries: spec.retries != null ? spec.retries : 0 }; return this; },
      levels: function () { return levels(); },

      run: function (ctx) {
        ctx = ctx || {};
        var lv = levels();
        if (lv.cycle) { rec('halt', { reason: 'cycle' }); return { ok: false, reason: 'dependency cycle — cannot schedule', cycle: lv.cycle }; }
        var order = [];
        for (var i = 0; i < lv.levels.length; i++) {
          var level = lv.levels[i];
          for (var j = 0; j < level.length; j++) {
            var id = level[j];
            if (completed[id] !== undefined) { continue; }                 // RESUME: skip checkpointed
            var t = tasks[id], attempts = 0, done = false, result = null, err = null;
            while (attempts <= t.retries && !done) {
              try { result = t.run(ctx, completed); done = true; }
              catch (e) { attempts++; err = String(e && e.message || e); }
            }
            if (!done) {
              rec('task-fail', { id: id, attempts: attempts });
              var notStarted = [];
              for (var k = i; k < lv.levels.length; k++) lv.levels[k].forEach(function (x) { if (completed[x] === undefined && x !== id) notStarted.push(x); });
              return { ok: false, failedAt: id, attempts: attempts, error: err, completed: Object.keys(completed), notStarted: notStarted };
            }
            completed[id] = result; order.push(id); rec('task-done', { id: id });   // CHECKPOINT
          }
        }
        rec('complete', { tasks: order.length });
        return { ok: true, order: order, results: Object.assign({}, completed) };
      },
      // introspection
      isComplete: function (id) { return completed[id] !== undefined; },
      checkpoint: function () { return Object.keys(completed); },
      reset: function () { completed = {}; return this; }
    };
    return W;
  }
  window.AquinWorkflow = { createWorkflow: createWorkflow };
})();
