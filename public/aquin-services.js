/*
 * aquin-services.js — AES-100 Vol III Part II Ch 1: System Services Architecture
 * (SSA). Applications never touch the kernel directly — they go through governed
 * platform SERVICES. This is the service registry + DISCOVERY layer: services
 * register with a semantic version + capabilities + health; consumers DISCOVER a
 * service by capability, get only healthy + version-COMPATIBLE ones, newest first.
 * Composes the Ch 50 boot orchestrator (aquin-integration.js) for start ordering.
 * No invented CS — this is a service registry with semver-based discovery.
 *
 * Proven in the tests:
 *  - DISCOVERY BY CAPABILITY returns matching services.
 *  - VERSION COMPATIBILITY: a consumer needing >= a minimum, same-major version
 *    gets only compatible providers, newest first (semver rules).
 *  - HEALTH-AWARE: an unhealthy/retired service is never returned by discovery.
 *  - LIFECYCLE: installed→registered→initialized→activated→suspended→retired,
 *    illegal transitions rejected.
 *  - Dependency listing for a service.
 *
 * HONEST SCOPE: registry/discovery/versioning logic is real and tested; the C++
 * platform runtime, IPC transport, and service sandboxing are declared substrates.
 */
(function () {
  var LIFECYCLE = ['installed', 'registered', 'initialized', 'activated', 'suspended', 'retired'];
  var TRANS = { installed: ['registered'], registered: ['initialized'], initialized: ['activated'], activated: ['suspended', 'retired'], suspended: ['activated', 'retired'], retired: [] };

  function parseVer(v) { var p = String(v || '0.0.0').split('.').map(function (x) { return parseInt(x, 10) || 0; }); return { major: p[0], minor: p[1] || 0, patch: p[2] || 0 }; }
  function cmpVer(a, b) { var x = parseVer(a), y = parseVer(b); return (x.major - y.major) || (x.minor - y.minor) || (x.patch - y.patch); }
  // compatible if same major and >= minVersion (semver: majors may break)
  function compatible(ver, minVersion) { if (!minVersion) return true; return parseVer(ver).major === parseVer(minVersion).major && cmpVer(ver, minVersion) >= 0; }

  function createServiceRegistry() {
    var services = {}; var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var R = {
      provenance: provenance, LIFECYCLE: LIFECYCLE,
      register: function (spec) {
        if (!spec || !spec.id) throw new Error('service needs an id');
        services[spec.id] = { id: spec.id, name: spec.name || spec.id, version: spec.version || '1.0.0', capabilities: (spec.capabilities || []).slice(), deps: (spec.deps || []).slice(), state: 'registered', health: 'healthy' };
        rec('register', { id: spec.id, version: spec.version, caps: spec.capabilities });
        return services[spec.id];
      },
      transition: function (id, to) { var s = services[id]; if (!s) return { ok: false }; if ((TRANS[s.state] || []).indexOf(to) < 0) return { ok: false, reason: 'illegal ' + s.state + '->' + to }; s.state = to; rec('transition', { id: id, to: to }); return { ok: true, state: to }; },
      setHealth: function (id, h) { if (services[id]) services[id].health = h; return this; },

      // DISCOVERY: healthy + version-compatible providers of a capability, newest first
      discover: function (query) {
        query = query || {};
        var out = Object.keys(services).map(function (k) { return services[k]; }).filter(function (s) {
          if (s.health !== 'healthy' || s.state === 'retired') return false;
          if (query.name && s.name !== query.name) return false;
          if (query.capability && s.capabilities.indexOf(query.capability) < 0) return false;
          if (query.minVersion && !compatible(s.version, query.minVersion)) return false;
          return true;
        }).sort(function (a, b) { return cmpVer(b.version, a.version); });   // newest first
        rec('discover', { query: query, found: out.length });
        return out.map(function (s) { return { id: s.id, name: s.name, version: s.version, capabilities: s.capabilities }; });
      },
      // best single provider (highest compatible version, healthy)
      resolve: function (query) { return this.discover(query)[0] || null; },
      dependencies: function (id) { return services[id] ? services[id].deps.slice() : null; },
      service: function (id) { return services[id]; }, list: function () { return Object.keys(services); }
    };
    return R;
  }
  window.AquinServices = { createServiceRegistry: createServiceRegistry, cmpVer: cmpVer, compatible: compatible };
})();
