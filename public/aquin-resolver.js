/*
 * aquin-resolver.js — AquinTutor Runtime Dependency Resolution Engine
 * (AES-001, Ch 1.2). The second subsystem, initialized right after Bootstrap.
 *
 * It NEVER initializes modules directly. It computes an immutable, reproducible
 * execution plan (identical manifests ⇒ identical plan — no random ordering)
 * that the kernel executes. It owns: manifest validation, the typed dependency
 * graph, non-terminating graph diagnostics, startup-level batching (parallel
 * init of independent modules), lifecycle state events, live impact analysis,
 * graceful-degradation policy, and the Runtime Stability Score.
 *
 * HONEST SCOPE: "cryptographically signed manifests" in the source spec needs a
 * server-issued key infrastructure that a browser page cannot self-provide; we
 * compute a real content integrity hash per manifest and treat signature
 * verification as a declared server-side boundary (see integrity()).
 */
(function () {
  var VERSION = '1.2.0';

  // ---- lifecycle states (immutable event vocabulary) --------------------
  var STATES = ['created','queued','waiting','initializing','loading-config','loading-dependencies',
    'allocating','registering','self-test','benchmark','healthy','partially-healthy','degraded',
    'failed','recovering','restarting','stopped','terminated'];

  // ---- default graceful-degradation policy by category ------------------
  // Educational continuity before computational perfection.
  var DEGRADATION = {
    rendering:   { action: 'simplified-renderer', keepsTeaching: true },
    animation:   { action: 'static-diagram',      keepsTeaching: true },
    translation: { action: 'original-language',   keepsTeaching: true },
    simulation:  { action: 'recorded-playback',   keepsTeaching: true },
    knowledge:   { action: 'cached-snapshot',     keepsTeaching: true },
    assessment:  { action: 'defer-and-queue',     keepsTeaching: true }
  };

  // ---- minimal, real semver constraint satisfaction ---------------------
  function parseV(v) { var m = String(v || '0.0.0').split('.').map(function (x) { return parseInt(x, 10) || 0; }); return [m[0] || 0, m[1] || 0, m[2] || 0]; }
  function cmp(a, b) { for (var i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return 0; }
  function satisfies(version, constraint) {
    if (!constraint || constraint === '*') return true;
    var v = parseV(version), c;
    if (constraint[0] === '^') { c = parseV(constraint.slice(1)); return cmp(v, c) >= 0 && v[0] === c[0]; }
    if (constraint[0] === '~') { c = parseV(constraint.slice(1)); return cmp(v, c) >= 0 && v[0] === c[0] && v[1] === c[1]; }
    if (constraint.slice(0, 2) === '>=') return cmp(v, parseV(constraint.slice(2))) >= 0;
    if (constraint.slice(0, 2) === '<=') return cmp(v, parseV(constraint.slice(2))) <= 0;
    if (constraint[0] === '>') return cmp(v, parseV(constraint.slice(1))) > 0;
    if (constraint[0] === '<') return cmp(v, parseV(constraint.slice(1))) < 0;
    return cmp(v, parseV(constraint)) === 0;
  }

  // ---- normalize a manifest's dependencies into typed edges -------------
  // deps entries may be "id" (mandatory) or {id,type,versionConstraint,reason}.
  function edgesOf(m) {
    var out = [];
    (m.deps || []).forEach(function (d) {
      if (typeof d === 'string') out.push({ dest: d, type: 'mandatory', versionConstraint: '*', reason: '' });
      else out.push({ dest: d.id, type: d.type || 'mandatory', versionConstraint: d.versionConstraint || '*', reason: d.reason || '' });
    });
    (m.optionalDeps || []).forEach(function (d) {
      var id = typeof d === 'string' ? d : d.id;
      out.push({ dest: id, type: 'optional', versionConstraint: (d && d.versionConstraint) || '*', reason: (d && d.reason) || '' });
    });
    return out;
  }
  function isBlocking(type) { return type === 'mandatory' || type === 'strong'; }

  function integrity(m) {
    // real content hash of the manifest (FNV-1a) — a deterministic fingerprint.
    var s = JSON.stringify({ id: m.id, version: m.version, deps: m.deps || [], optionalDeps: m.optionalDeps || [] });
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return 'fnv1a-' + h.toString(16);
  }

  // ---- build the typed dependency graph ---------------------------------
  function buildGraph(manifests) {
    var nodes = {}, adj = {}, radj = {}, edges = [];
    manifests.forEach(function (m) { nodes[m.id] = m; adj[m.id] = []; radj[m.id] = []; });
    manifests.forEach(function (m) {
      edgesOf(m).forEach(function (e) {
        var edge = { source: m.id, dest: e.dest, type: e.type, versionConstraint: e.versionConstraint, reason: e.reason, blocking: isBlocking(e.type) };
        edges.push(edge);
        if (nodes[e.dest]) { adj[e.dest].push(m.id); radj[m.id].push(e.dest); }  // dest must init before source
      });
    });
    return { nodes: nodes, adj: adj, radj: radj, edges: edges };
  }

  // ---- manifest validation (non-terminating; full diagnostics) ----------
  function validateManifests(manifests) {
    var diags = [], seen = {};
    manifests.forEach(function (m) {
      function bad(rule, severity, detail, resolution) { diags.push({ manifest: m.id || '(no id)', rule: rule, severity: severity, detail: detail, resolution: resolution || '' }); }
      if (!m.id) bad('required-id', 'error', 'manifest has no id', 'Assign a unique id');
      else if (seen[m.id]) bad('duplicate-id', 'error', 'duplicate subsystem id "' + m.id + '"', 'Ids must be unique'); else seen[m.id] = true;
      if (!m.version) bad('missing-version', 'warning', 'no version — defaulting to 0.0.0', 'Declare a semver version');
    });
    var ids = {}; manifests.forEach(function (m) { if (m.id) ids[m.id] = m; });
    manifests.forEach(function (m) {
      edgesOf(m).forEach(function (e) {
        var target = ids[e.dest];
        if (!target) {
          if (isBlocking(e.type)) diags.push({ manifest: m.id, rule: 'invalid-dependency-reference', severity: 'error', detail: 'mandatory dependency "' + e.dest + '" does not exist', resolution: 'Register "' + e.dest + '" or remove the dependency' });
          else diags.push({ manifest: m.id, rule: 'optional-dependency-absent', severity: 'warning', detail: 'optional dependency "' + e.dest + '" absent — will continue without it', resolution: '' });
        } else if (e.versionConstraint && e.versionConstraint !== '*' && !satisfies(target.version || '0.0.0', e.versionConstraint)) {
          diags.push({ manifest: m.id, rule: 'version-conflict', severity: 'error', detail: 'requires "' + e.dest + '" ' + e.versionConstraint + ' but found ' + (target.version || '0.0.0'), resolution: 'Align versions' });
        }
      });
    });
    return { ok: diags.filter(function (d) { return d.severity === 'error'; }).length === 0, diagnostics: diags };
  }

  // ---- cycle detection over blocking edges (trace, never auto-resolve) --
  function findCycle(graph) {
    var color = {}, stack = [], cyc = null;               // 0 unvisited,1 on-stack,2 done
    Object.keys(graph.nodes).forEach(function (id) { color[id] = 0; });
    function dfs(id) {
      if (cyc) return; color[id] = 1; stack.push(id);
      var deps = graph.radj[id].filter(function (d) {
        // only blocking edges constrain ordering
        return graph.edges.some(function (e) { return e.source === id && e.dest === d && e.blocking; });
      });
      for (var i = 0; i < deps.length; i++) {
        var d = deps[i];
        if (color[d] === 1) { cyc = stack.slice(stack.indexOf(d)).concat(d); return; }
        if (color[d] === 0) dfs(d);
        if (cyc) return;
      }
      stack.pop(); color[id] = 2;
    }
    Object.keys(graph.nodes).forEach(function (id) { if (color[id] === 0 && !cyc) dfs(id); });
    return cyc;
  }

  // ---- graph validation (non-terminating diagnostics) -------------------
  function validateGraph(graph) {
    var diags = [];
    var cyc = findCycle(graph);
    if (cyc) diags.push({ rule: 'cycle', severity: 'error', detail: 'dependency cycle: ' + cyc.join(' → '), chain: cyc });
    // duplicate edge detection
    var eseen = {};
    graph.edges.forEach(function (e) { var k = e.source + '->' + e.dest + ':' + e.type; if (eseen[k]) diags.push({ rule: 'duplicate-edge', severity: 'warning', detail: k }); eseen[k] = true; });
    return { ok: diags.filter(function (d) { return d.severity === 'error'; }).length === 0, diagnostics: diags, cycle: cyc };
  }

  // ---- startup levels: parallel batches, deterministic ------------------
  // level(id) = 0 if no blocking deps, else 1 + max(level(dep)); modules on the
  // same level cannot depend on each other, so they init in parallel.
  function computeLevels(graph) {
    var level = {}, ids = Object.keys(graph.nodes);
    function lvl(id, seen) {
      if (level[id] != null) return level[id];
      seen = seen || {}; if (seen[id]) return 0; seen[id] = true;
      var blockingDeps = graph.radj[id].filter(function (d) {
        return graph.nodes[d] && graph.edges.some(function (e) { return e.source === id && e.dest === d && e.blocking; });
      });
      var mx = -1; blockingDeps.forEach(function (d) { mx = Math.max(mx, lvl(d, seen)); });
      return (level[id] = mx + 1);
    }
    ids.forEach(function (id) { lvl(id); });
    var maxL = 0; ids.forEach(function (id) { maxL = Math.max(maxL, level[id]); });
    var levels = [];
    for (var L = 0; L <= maxL; L++) {
      var batch = ids.filter(function (id) { return level[id] === L; })
        // deterministic within a batch: priority desc, then id asc
        .sort(function (a, b) { var pa = graph.nodes[a].priority || 0, pb = graph.nodes[b].priority || 0; return pb - pa || (a < b ? -1 : 1); });
      levels.push(batch);
    }
    return levels;
  }

  function planHash(levels) { var s = JSON.stringify(levels), h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); }

  // ---- the authoritative execution plan (throws on hard errors) ---------
  function plan(manifests) {
    var mv = validateManifests(manifests);
    var graph = buildGraph(manifests);
    var gv = validateGraph(graph);
    var diagnostics = mv.diagnostics.concat(gv.diagnostics);
    if (gv.cycle) throw { code: 'DEPENDENCY_CYCLE', message: 'Dependency cycle detected: ' + gv.cycle.join(' → '), chain: gv.cycle, diagnostics: diagnostics };
    if (!mv.ok) throw { code: 'MANIFEST_INVALID', message: 'Manifest validation failed (' + mv.diagnostics.filter(function (d) { return d.severity === 'error'; }).length + ' error(s))', diagnostics: diagnostics };
    var levels = computeLevels(graph);
    return { levels: levels, order: [].concat.apply([], levels), hash: planHash(levels), diagnostics: diagnostics, graph: graph };
  }

  // ---- live impact analysis: who breaks if `id` fails -------------------
  function computeImpact(graph, id) {
    var direct = graph.adj[id] ? graph.adj[id].slice() : [];
    var transitive = {}, queue = direct.slice();
    while (queue.length) { var n = queue.shift(); if (transitive[n]) continue; transitive[n] = true; (graph.adj[n] || []).forEach(function (x) { queue.push(x); }); }
    var affected = Object.keys(transitive);
    var categories = {};
    affected.concat(id).forEach(function (a) { var cat = graph.nodes[a] && graph.nodes[a].category; if (cat) categories[cat] = (categories[cat] || 0) + 1; });
    return { failed: id, direct: direct, transitive: affected, categories: categories };
  }

  // ---- graceful degradation: isolate, preserve teaching -----------------
  function degrade(graph, id) {
    var node = graph.nodes[id] || {};
    var pol = (node.degradation) || DEGRADATION[node.category] || { action: 'isolate-branch', keepsTeaching: true };
    return { module: id, category: node.category || null, action: pol.action, keepsTeaching: pol.keepsTeaching !== false };
  }

  // ---- Runtime Stability Score (0..100), continuity weighted highest ----
  function stabilityScore(t) {
    t = t || {};
    function c(x, d) { return typeof x === 'number' ? Math.max(0, Math.min(1, x)) : d; }
    var initS = c(t.initSuccessRate, 1), recS = c(t.recoverySuccessRate, 1), avail = c(t.availability, 1),
        cont = c(t.educationalContinuity, 1), restart = c(t.restartFrequency, 0), viol = c(t.dependencyViolations, 0);
    var score = 0.35 * cont + 0.18 * initS + 0.15 * avail + 0.12 * recS + 0.10 * (1 - restart) + 0.10 * (1 - viol);
    return Math.round(score * 100);
  }

  // ---- execute a plan level-by-level (parallel within a level) ----------
  // emit(id, state, meta) publishes immutable lifecycle events.
  async function execute(plan, byId, ctx, emit) {
    var instances = {}, inited = [];
    function ev(id, s, meta) { if (emit) emit(id, s, meta || null); }
    Object.keys(byId).forEach(function (id) { ev(id, 'created'); });
    for (var L = 0; L < plan.levels.length; L++) {
      var batch = plan.levels[L];
      batch.forEach(function (id) { ev(id, 'queued', { level: L }); });
      await Promise.all(batch.map(async function (id) {
        var mod = byId[id]; if (!mod || typeof mod.init !== 'function') return;
        ev(id, 'initializing', { level: L });
        try { instances[id] = await mod.init(ctx); inited.push(id); ev(id, 'healthy'); }
        catch (e) { ev(id, 'failed', { error: String(e && e.message || e) }); throw { code: 'MODULE_INIT_FAILED', module: id, error: e, level: L, message: 'Module "' + id + '" failed at level ' + L + ': ' + String(e && e.message || e), inited: inited, instances: instances }; }
      }));
    }
    return { instances: instances, inited: inited };
  }

  window.AquinResolver = {
    version: VERSION, STATES: STATES, DEGRADATION: DEGRADATION,
    satisfies: satisfies, buildGraph: buildGraph, validateManifests: validateManifests,
    validateGraph: validateGraph, computeLevels: computeLevels, plan: plan,
    computeImpact: computeImpact, degrade: degrade, stabilityScore: stabilityScore,
    execute: execute, integrity: integrity
  };
})();
