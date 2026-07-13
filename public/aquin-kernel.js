/*
 * aquin-kernel.js — AquinTutor Educational Operating Kernel (AES-001, Ch 1.1).
 * The Runtime Bootstrap Engine: the single executable entry point. Every
 * subsystem initializes through it, in deterministic order, never on its own.
 *
 * window.AquinKernel.boot() runs a deterministic finite-state machine:
 *   IDLE → VERIFY → CONFIG → IDENTITY → CAPABILITY → GRAPH → INIT → HEALTH → READY
 * (or → FAILED, which tears every initialized module down in reverse order and
 *  never exposes a half-initialized runtime).
 *
 * HONEST SCOPE (this is a browser platform, not a native binary):
 *   Real & implemented here — FSM boot, dependency manifest → DAG → cycle
 *   detection (Kahn topological sort), immutable Object.freeze config with a
 *   structured validation report + SHA-256 checksum, crypto-seeded identity,
 *   and a capability analyzer that genuinely benchmarks the device into a
 *   multidimensional vector that render/sync/animation budgets derive from.
 *   Not applicable in a browser sandbox (declared, not faked): native GPU APIs
 *   (Vulkan/Metal/DirectX), NUMA/SIMD topology, executable digital-signature
 *   verification. Config integrity uses a real content hash instead.
 */
(function () {
  var VERSION = '1.1.0';
  var NA = { vulkan: 'native GPU API not exposed to browser', metal: 'native GPU API not exposed to browser',
             directx: 'native GPU API not exposed to browser', numa: 'CPU topology not exposed to browser',
             simd_topology: 'not exposed to browser', executable_signature: 'no executable to sign in a web sandbox; config uses SHA-256 checksum instead' };

  // ---- default configuration (System layer) -----------------------------
  var DEFAULT_CONFIG = {
    system:       { name: 'AquinTutor', kernel: VERSION, schemaVersion: 1 },
    deployment:   { id: 'web', profile: 'production', edge: true },
    institution:  { id: 'aquintutor', name: 'AquinTutor' },
    localization: { defaultLang: 'en', fallbackLang: 'en', rtl: true },
    rendering:    { backend: 'auto', targetFps: 60, maxParticles: 2000, adaptive: true },
    educational:  { defaultTier: 'undergraduate', offlineFirst: true, proctoring: 'advisory' },
    networking:   { syncMode: 'delta', retries: 3 },
    security:     { requireHttps: true }
  };

  // ---- config schema (type / range / enum / required) --------------------
  var SCHEMA = {
    'system.name':               { type: 'string',  required: true },
    'system.schemaVersion':      { type: 'number',  required: true, min: 1 },
    'deployment.profile':        { type: 'string',  required: true, enum: ['production', 'staging', 'development'] },
    'institution.id':            { type: 'string',  required: true },
    'localization.defaultLang':  { type: 'string',  required: true },
    'localization.fallbackLang': { type: 'string',  required: true },
    'rendering.targetFps':       { type: 'number',  required: true, min: 24, max: 240 },
    'rendering.maxParticles':    { type: 'number',  required: true, min: 0, max: 100000 },
    // proctoring MUST be advisory — a hard institutional rule, enforced at boot.
    'educational.proctoring':    { type: 'string',  required: true, enum: ['advisory'] },
    'educational.offlineFirst':  { type: 'boolean', required: true },
    'networking.retries':        { type: 'number',  required: true, min: 0, max: 10 }
  };

  function getPath(obj, path) { var p = path.split('.'); var v = obj; for (var i = 0; i < p.length; i++) { if (v == null) return undefined; v = v[p[i]]; } return v; }
  function deepMerge(a, b) { var out = {}; var k; for (k in a) out[k] = a[k]; for (k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k]) out[k] = deepMerge(a[k], b[k]); else out[k] = b[k]; } return out; }
  function deepFreeze(o) { if (o && typeof o === 'object') { Object.getOwnPropertyNames(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); } return o; }

  // ---- structured logger -------------------------------------------------
  function makeLogger(sessionId) {
    var buffer = [];
    function log(severity, subsystem, operation, meta) {
      var e = { ts: Date.now(), session: sessionId, subsystem: subsystem, severity: severity, operation: operation, meta: meta || null };
      buffer.push(e);
      if (severity === 'error' || severity === 'fatal') { try { console.error('[AquinKernel]', subsystem, operation, meta || ''); } catch (_) {} }
      return e;
    }
    log.buffer = buffer;
    return log;
  }

  // ---- SHA-256 checksum (real content integrity) -------------------------
  async function sha256(str) {
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
        var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      }
    } catch (_) {}
    // deterministic non-cryptographic fallback where SubtleCrypto is unavailable
    var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return 'fnv-' + h.toString(16);
  }

  // ---- identity ----------------------------------------------------------
  function uuid() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    var b; try { b = crypto.getRandomValues(new Uint8Array(16)); } catch (_) { b = null; }
    if (!b) { b = []; for (var i = 0; i < 16; i++) b.push(Math.floor(Math.random() * 256)); }
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function secureSeed() { try { var a = crypto.getRandomValues(new Uint32Array(4)); return Array.prototype.map.call(a, function (x) { return x.toString(16); }).join(''); } catch (_) { return Math.random().toString(16).slice(2); } }

  // ---- capability analyzer (real detection + benchmarks) -----------------
  function benchCpu() {
    // sustained integer throughput: iterations completed in a ~12ms budget
    var end = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 12;
    var n = 0, x = 0;
    while ((typeof performance !== 'undefined' ? performance.now() : Date.now()) < end) { x = (x + n * 2654435761) >>> 0; n++; }
    return n; // ops in 12ms — higher is faster
  }
  function benchWasm() {
    try {
      if (typeof WebAssembly === 'undefined') return { supported: false };
      // minimal module exporting add(i32,i32)->i32
      var bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
      var mod = new WebAssembly.Module(bytes);
      var inst = new WebAssembly.Instance(mod, {});
      var t0 = performance.now(), r = 0;
      for (var i = 0; i < 200000; i++) r = inst.exports.add(r, 1);
      return { supported: true, ok: r === 200000, ms: +(performance.now() - t0).toFixed(2) };
    } catch (_) { return { supported: false }; }
  }
  function detectGl() {
    try {
      var c = document.createElement('canvas');
      var gl2 = c.getContext('webgl2');
      if (gl2) { var dbg = gl2.getExtension('WEBGL_debug_renderer_info'); return { version: 2, maxTexture: gl2.getParameter(gl2.MAX_TEXTURE_SIZE), renderer: dbg ? gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null }; }
      var gl1 = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl1) return { version: 1, maxTexture: gl1.getParameter(gl1.MAX_TEXTURE_SIZE), renderer: null };
    } catch (_) {}
    return { version: 0 };
  }
  function measureRefresh() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'undefined') return resolve(60);
      var frames = [], last = 0, count = 0;
      function step(ts) { if (last) frames.push(ts - last); last = ts; if (++count < 8) requestAnimationFrame(step); else { frames.sort(function (a, b) { return a - b; }); var med = frames[Math.floor(frames.length / 2)] || 16.7; resolve(Math.round(1000 / med)); } }
      requestAnimationFrame(step);
    });
  }
  async function analyzeCapabilities(log) {
    var nav = (typeof navigator !== 'undefined') ? navigator : {};
    var cpuOps = benchCpu();
    var wasm = benchWasm();
    var gl = detectGl();
    var webgpu = !!(nav.gpu);
    var refresh = await measureRefresh();
    var storage = { quota: null, usage: null };
    try { if (nav.storage && nav.storage.estimate) { var est = await nav.storage.estimate(); storage = { quota: est.quota || null, usage: est.usage || null }; } } catch (_) {}
    var conn = nav.connection || {};
    var vector = {
      cores: nav.hardwareConcurrency || 2,
      memoryGB: nav.deviceMemory || null,
      cpuOps12ms: cpuOps,
      wasm: wasm,
      webgpu: webgpu,
      webgl: gl,
      refreshHz: refresh,
      dpr: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
      screen: (typeof screen !== 'undefined') ? { w: screen.width, h: screen.height } : null,
      touch: (typeof window !== 'undefined' && 'ontouchstart' in window) || (nav.maxTouchPoints > 0),
      maxTouch: nav.maxTouchPoints || 0,
      network: { type: conn.effectiveType || null, downlinkMbps: conn.downlink || null, rttMs: conn.rtt || null, saveData: !!conn.saveData },
      storage: storage,
      features: {
        serviceWorker: 'serviceWorker' in nav,
        cacheAPI: (typeof caches !== 'undefined'),
        indexedDB: (typeof indexedDB !== 'undefined'),
        webCodecs: (typeof window !== 'undefined' && 'VideoEncoder' in window),
        mediaSource: (typeof window !== 'undefined' && 'MediaSource' in window),
        audioWorklet: (typeof window !== 'undefined' && 'AudioWorklet' in window),
        speechRecognition: (typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)),
        speechSynthesis: (typeof window !== 'undefined' && 'speechSynthesis' in window),
        mediaDevices: !!(nav.mediaDevices && nav.mediaDevices.getUserMedia)
      },
      prefersReducedMotion: (typeof matchMedia !== 'undefined') ? matchMedia('(prefers-reduced-motion: reduce)').matches : false,
      notApplicable: NA
    };

    // Derive continuous budgets FROM the vector (no fixed device classes).
    var perf = (cpuOps / 1e5) * (vector.cores / 4) * (gl.version >= 2 ? 1.4 : gl.version === 1 ? 1.0 : 0.5) * (webgpu ? 1.3 : 1);
    if (vector.network.saveData) perf *= 0.6;                 // honour data-saver
    if (vector.prefersReducedMotion) perf *= 0.7;
    var budget = {
      score: +perf.toFixed(2),
      particleBudget: Math.max(120, Math.min(6000, Math.round(perf * 800))),
      targetFps: refresh >= 90 ? 60 : refresh,               // never promise more than the panel
      textureScale: perf > 2 ? 1 : perf > 1 ? 0.75 : 0.5,
      animationQuality: perf > 2.5 ? 'ultra' : perf > 1.4 ? 'high' : perf > 0.8 ? 'medium' : 'low',
      allowHeavyShaders: gl.version >= 2 && perf > 1.5,
      offlineViable: vector.features.serviceWorker && vector.features.cacheAPI
    };
    log('info', 'capability', 'analyzed', { score: budget.score, quality: budget.animationQuality, cores: vector.cores, gl: gl.version, webgpu: webgpu, refreshHz: refresh });
    return { vector: vector, budget: budget };
  }

  // ---- dependency graph: DAG + cycle detection (Kahn) --------------------
  function topoSort(modules) {
    var byId = {}, indeg = {}, adj = {};
    modules.forEach(function (m) { byId[m.id] = m; indeg[m.id] = 0; adj[m.id] = []; });
    modules.forEach(function (m) { (m.deps || []).forEach(function (d) {
      if (!byId[d]) throw { code: 'MISSING_DEP', message: 'Module "' + m.id + '" depends on unknown module "' + d + '"' };
      adj[d].push(m.id); indeg[m.id]++;
    }); });
    var queue = [], order = [];
    modules.forEach(function (m) { if (indeg[m.id] === 0) queue.push(m.id); });
    while (queue.length) { var id = queue.shift(); order.push(id); adj[id].forEach(function (n) { if (--indeg[n] === 0) queue.push(n); }); }
    if (order.length !== modules.length) {
      // a cycle exists — trace it and refuse to run (never auto-resolve)
      var remaining = modules.filter(function (m) { return order.indexOf(m.id) < 0; }).map(function (m) { return m.id; });
      var chain = traceCycle(remaining, byId);
      throw { code: 'DEPENDENCY_CYCLE', message: 'Dependency cycle detected: ' + chain.join(' → '), chain: chain };
    }
    return order.map(function (id) { return byId[id]; });
  }
  function traceCycle(nodes, byId) {
    var inSet = {}; nodes.forEach(function (n) { inSet[n] = true; });
    var stack = [], onStack = {}, found = null;
    function dfs(id) {
      if (found) return; stack.push(id); onStack[id] = true;
      var deps = (byId[id].deps || []).filter(function (d) { return inSet[d]; });
      for (var i = 0; i < deps.length; i++) {
        var d = deps[i];
        if (onStack[d]) { found = stack.slice(stack.indexOf(d)).concat(d); return; }
        if (!found) dfs(d);
      }
      stack.pop(); onStack[id] = false;
    }
    for (var i = 0; i < nodes.length && !found; i++) dfs(nodes[i]);
    return found || nodes;
  }

  // ---- the kernel --------------------------------------------------------
  var modules = [];
  var instances = {};
  var initedOrder = [];
  var K = {
    version: VERSION,
    state: 'idle',
    snapshot: null,
    identity: null,
    capabilities: null,
    report: null,
    log: null,
    _bootPromise: null,

    register: function (mod) {
      if (!mod || !mod.id || typeof mod.init !== 'function') throw new Error('register(mod): needs {id, init, deps?, healthCheck?}');
      if (this.state !== 'idle') throw new Error('register must happen before boot()');
      modules.push({ id: mod.id, deps: mod.deps || [], optionalDeps: mod.optionalDeps || [], category: mod.category || null, priority: mod.priority || 0, version: mod.version || '1.0.0', degradation: mod.degradation || null, phase: mod.phase || 2, init: mod.init, healthCheck: mod.healthCheck || null, dispose: mod.dispose || null });
      return this;
    },
    get: function (id) { return instances[id]; },

    boot: function (options) {
      if (this._bootPromise) return this._bootPromise;
      var self = this;
      this._bootPromise = (async function () {
        var sessionId = uuid();
        var log = self.log = makeLogger(sessionId);
        var report = self.report = { session: sessionId, startedAt: Date.now(), state: 'booting', validation: [], errors: [], phases: [] };
        function phase(name) { report.phases.push({ name: name, at: Date.now() }); log('info', 'bootstrap', 'phase', { phase: name }); }
        try {
          self.state = 'booting';

          // PHASE 0 — VERIFY: merge config layers by precedence, checksum.
          phase('verify');
          var layers = (options && options.configLayers) || [];
          var merged = DEFAULT_CONFIG;
          for (var i = 0; i < layers.length; i++) merged = deepMerge(merged, layers[i] || {});
          var checksum = await sha256(JSON.stringify(merged));

          // PHASE 1a — CONFIG: validate every field, collect a full report, freeze.
          phase('config');
          var keys = Object.keys(SCHEMA);
          for (var k = 0; k < keys.length; k++) {
            var key = keys[k], rule = SCHEMA[key], val = getPath(merged, key), issues = [];
            if (val === undefined || val === null) { if (rule.required) issues.push({ rule: 'required', expected: 'present', actual: 'missing' }); }
            else {
              if (rule.type && typeof val !== rule.type) issues.push({ rule: 'type', expected: rule.type, actual: typeof val });
              if (rule.enum && rule.enum.indexOf(val) < 0) issues.push({ rule: 'enum', expected: rule.enum.join('|'), actual: String(val) });
              if (typeof rule.min === 'number' && val < rule.min) issues.push({ rule: 'min', expected: '>=' + rule.min, actual: String(val) });
              if (typeof rule.max === 'number' && val > rule.max) issues.push({ rule: 'max', expected: '<=' + rule.max, actual: String(val) });
            }
            issues.forEach(function (is) { report.validation.push({ config: key, rule: is.rule, expected: is.expected, actual: is.actual, severity: 'error', resolution: 'Set ' + key + ' to a valid value (' + (rule.enum ? rule.enum.join('|') : rule.type) + ')' }); });
          }
          var errs = report.validation.filter(function (v) { return v.severity === 'error'; });
          if (errs.length) { var e = new Error('Configuration validation failed (' + errs.length + ' error' + (errs.length > 1 ? 's' : '') + ')'); e.validation = report.validation; throw e; }
          var snapshot = deepFreeze({ config: merged, checksum: checksum, schemaVersion: merged.system.schemaVersion, createdAt: Date.now() });
          self.snapshot = snapshot;
          log('info', 'config', 'frozen', { checksum: checksum.slice(0, 12) });

          // PHASE 1b — IDENTITY.
          phase('identity');
          self.identity = deepFreeze({
            sessionId: sessionId, kernelInstanceId: uuid(),
            deploymentId: merged.deployment.id, institutionId: merged.institution.id,
            timestamp: new Date().toISOString(), seed: secureSeed()
          });

          // PHASE 1c — CAPABILITY: benchmark → vector → budgets.
          phase('capability');
          self.capabilities = await analyzeCapabilities(log);

          // PHASE 2 — GRAPH: delegate planning to the Dependency Resolution
          // Engine (Ch 1.2, window.AquinResolver) when present; else use the
          // built-in topological sort. The plan is immutable & reproducible.
          phase('graph');
          var ctx = { snapshot: snapshot, identity: self.identity, capabilities: self.capabilities, log: log, get: self.get };
          var byId = {}; modules.forEach(function (mm) { byId[mm.id] = mm; });
          var levels = null, order = null;
          if (typeof window !== 'undefined' && window.AquinResolver) {
            var manifests = modules.map(function (mm) { return { id: mm.id, version: mm.version, category: mm.category, priority: mm.priority, deps: mm.deps, optionalDeps: mm.optionalDeps, degradation: mm.degradation }; });
            var planned = window.AquinResolver.plan(manifests);   // throws on cycle / invalid manifest
            report.plan = { levels: planned.levels, hash: planned.hash, resolver: window.AquinResolver.version };
            if (planned.diagnostics && planned.diagnostics.length) report.validation = report.validation.concat(planned.diagnostics);
            self._graph = planned.graph;
            levels = planned.levels;
            log('info', 'resolver', 'plan', { levels: planned.levels.length, hash: planned.hash });
          } else {
            order = topoSort(modules);
          }

          // PHASE 3 — INIT. With levels: init each level's independent modules in
          // PARALLEL, levels strictly in order. Without a resolver: sequential
          // topological order. Teardown (kernel-owned) works for either path.
          phase('init');
          var initOne = async function (mod, level) {
            try { instances[mod.id] = await mod.init(ctx); initedOrder.push(mod); log('info', mod.id, 'init.ok', level != null ? { level: level } : null); }
            catch (initErr) { var msg = 'Module "' + mod.id + '" failed to initialize: ' + String(initErr && initErr.message || initErr); log('fatal', mod.id, 'init.failed', { error: msg }); throw { code: 'MODULE_INIT_FAILED', module: mod.id, error: initErr, message: msg }; }
          };
          if (levels) {
            for (var L = 0; L < levels.length; L++) {
              await Promise.all(levels[L].map(function (id) { return initOne(byId[id], L); }));
            }
          } else {
            for (var mi = 0; mi < order.length; mi++) await initOne(order[mi]);
          }

          // PHASE 4 — HEALTH: every mandatory module must report healthy.
          phase('health');
          for (var h = 0; h < initedOrder.length; h++) {
            var im = initedOrder[h];
            if (im.healthCheck) { var ok = await im.healthCheck(ctx, instances[im.id]); if (!ok) throw { code: 'HEALTHCHECK_FAILED', module: im.id }; }
          }

          self.state = 'ready'; report.state = 'ready'; report.readyAt = Date.now();
          report.bootMs = report.readyAt - report.startedAt;
          log('info', 'bootstrap', 'ready', { bootMs: report.bootMs, modules: initedOrder.length });
          return { identity: self.identity, snapshot: snapshot, capabilities: self.capabilities, report: report };
        } catch (err) {
          self.state = 'failed'; report.state = 'failed';
          report.errors.push({ code: err && err.code || 'BOOT_ERROR', message: String(err && err.message || err), chain: err && err.chain, module: err && err.module });
          if (log) log('fatal', 'bootstrap', 'failed', report.errors[report.errors.length - 1]);
          // graceful teardown: dispose initialized modules in REVERSE order.
          for (var d = initedOrder.length - 1; d >= 0; d--) { try { if (initedOrder[d].dispose) initedOrder[d].dispose(instances[initedOrder[d].id]); } catch (_) {} }
          // never expose a partial runtime
          instances = {}; initedOrder = [];
          throw Object.assign(new Error(report.errors[report.errors.length - 1].message), { report: report });
        }
      })();
      return this._bootPromise;
    }
  };

  window.AquinKernel = K;
})();
