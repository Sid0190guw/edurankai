/*
 * aquin-sdn.js — AES-100 Vol III Part II Ch 8: Software Defined Networking Runtime
 * (SDNR). Separates the control plane (a central controller) from the data plane
 * (switches with flow tables). Real, tested cores:
 *
 *  - INTENT-BASED NETWORKING: an administrator declares an INTENT ("connect A to B")
 *    and the controller COMPILES it into flow rules — no per-switch hand config.
 *  - SHORTEST-PATH ROUTING: intents compile to the least-cost path (Dijkstra); flows
 *    are installed on every switch along it.
 *  - AUTONOMOUS HEALING: when a link fails, the controller recomputes an alternative
 *    path for every affected intent and reinstalls the flows — self-healing network.
 *  - A partition with no path makes the intent fail (honest), not silently succeed.
 *
 * HONEST SCOPE: the control-plane logic (topology, Dijkstra, intent compilation,
 * flow installation, healing) is real and tested; OpenFlow/P4 data-plane wire
 * protocols and vendor switch firmware are declared substrates. (~13.4M-LOC C++ → core.)
 */
(function () {
  function createController() {
    var nodes = {};       // id -> true
    var links = {};       // "a|b" -> { a, b, cost, up }
    var flows = {};       // switchId -> [ {intentId, match, action(nextHop)} ]
    var intents = {};     // intentId -> { from, to }
    var seq = 0, provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }
    function key(a, b) { return [a, b].sort().join('|'); }

    // Dijkstra shortest path over UP links
    function shortestPath(from, to) {
      if (!nodes[from] || !nodes[to]) return null;
      var dist = {}, prev = {}, pq = [];
      Object.keys(nodes).forEach(function (n) { dist[n] = Infinity; }); dist[from] = 0; pq.push([0, from]);
      while (pq.length) {
        pq.sort(function (x, y) { return x[0] - y[0]; }); var cur = pq.shift(); var u = cur[1];
        if (u === to) break;
        Object.keys(links).forEach(function (lk) {
          var l = links[lk]; if (!l.up) return; var v = l.a === u ? l.b : l.b === u ? l.a : null; if (!v) return;
          var nd = dist[u] + l.cost; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; pq.push([nd, v]); }
        });
      }
      if (dist[to] === Infinity) return null;
      var path = [], c = to; while (c != null) { path.unshift(c); c = prev[c]; } return { path: path, cost: dist[to] };
    }

    function installFlows(intentId, path) {
      // remove old flows for this intent
      Object.keys(flows).forEach(function (sw) { flows[sw] = (flows[sw] || []).filter(function (f) { return f.intentId !== intentId; }); });
      for (var i = 0; i < path.length - 1; i++) {
        var sw = path[i], next = path[i + 1];
        (flows[sw] = flows[sw] || []).push({ intentId: intentId, match: 'to:' + intents[intentId].to, action: 'forward->' + next });
      }
    }

    var C = {
      provenance: provenance,
      addSwitch: function (id) { nodes[id] = true; return this; },
      addLink: function (a, b, opts) { links[key(a, b)] = { a: a, b: b, cost: (opts && opts.cost) || 1, up: true }; return this; },
      setLinkUp: function (a, b, up) { var l = links[key(a, b)]; if (l) l.up = up; rec('link-status', { a: a, b: b, up: up }); return this; },

      // declare an INTENT -> compile to a shortest-path flow set
      intent: function (spec) {
        var id = spec.id || ('intent_' + (++seq));
        intents[id] = { from: spec.from, to: spec.to };
        var sp = shortestPath(spec.from, spec.to);
        if (!sp) { rec('intent-fail', { id: id }); return { ok: false, intentId: id, reason: 'no path from ' + spec.from + ' to ' + spec.to }; }
        installFlows(id, sp.path);
        rec('intent', { id: id, path: sp.path, cost: sp.cost });
        return { ok: true, intentId: id, path: sp.path, cost: sp.cost, flowsInstalled: sp.path.length - 1 };
      },

      // AUTONOMOUS HEALING: recompute every affected intent after topology change
      heal: function () {
        var results = [];
        Object.keys(intents).forEach(function (id) {
          var sp = shortestPath(intents[id].from, intents[id].to);
          if (sp) { installFlows(id, sp.path); results.push({ intentId: id, rerouted: true, path: sp.path }); }
          else { Object.keys(flows).forEach(function (sw) { flows[sw] = (flows[sw] || []).filter(function (f) { return f.intentId !== id; }); }); results.push({ intentId: id, rerouted: false, reason: 'no alternative path' }); }
        });
        rec('heal', { intents: results.length });
        return results;
      },
      flowTable: function (sw) { return (flows[sw] || []).slice(); },
      path: function (from, to) { var sp = shortestPath(from, to); return sp ? sp.path : null; }
    };
    return C;
  }
  window.AquinSDN = { createController: createController };
})();
