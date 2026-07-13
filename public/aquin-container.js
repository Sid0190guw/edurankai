/*
 * aquin-container.js — AES-100 Vol III Part II Ch 11: Container Runtime &
 * Orchestration Engine (CROE). The universal application execution platform. Real,
 * tested cores:
 *
 *  - IMAGE SIGNATURE GATE: an unsigned image cannot run unless policy explicitly
 *    allows it (supply-chain security).
 *  - BIN-PACKING SCHEDULER: a container is placed on a node that has enough CPU +
 *    memory (best-fit — pack tightly); if none fits it stays pending, never
 *    overcommitted silently.
 *  - AUTOSCALING (Kubernetes HPA formula): desired = ceil(replicas × currentUtil /
 *    targetUtil), clamped to [min, max].
 *  - SELF-HEALING: a failed container (or every container on a failed node) is
 *    rescheduled onto a healthy node with capacity; if none, it is reported pending.
 *
 * HONEST SCOPE: the scheduling, quota accounting, autoscaling, and healing logic is
 * real and tested; OCI image layers, Linux namespaces/cgroups, GPU drivers, and
 * confidential-computing attestation are declared substrates. (~18.7M-LOC C++ → core.)
 */
(function () {
  function createOrchestrator(cfg) {
    cfg = cfg || {};
    var nodes = {};        // id -> { cpu, mem, up, used:{cpu,mem}, containers:[] }
    var images = {};       // id -> { signed }
    var containers = {};   // id -> { image, cpu, mem, node, state }
    var seq = 0, provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function fits(node, spec) { return node.up && (node.cpu - node.used.cpu) >= spec.cpu && (node.mem - node.used.mem) >= spec.mem; }
    // best-fit: the node that leaves the least leftover capacity (tight packing)
    function pickNode(spec) {
      var cands = Object.keys(nodes).filter(function (k) { return fits(nodes[k], spec); });
      if (!cands.length) return null;
      return cands.sort(function (a, b) {
        var la = (nodes[a].cpu - nodes[a].used.cpu - spec.cpu) + (nodes[a].mem - nodes[a].used.mem - spec.mem);
        var lb = (nodes[b].cpu - nodes[b].used.cpu - spec.cpu) + (nodes[b].mem - nodes[b].used.mem - spec.mem);
        return la - lb;
      })[0];
    }

    var O = {
      provenance: provenance,
      addNode: function (id, spec) { nodes[id] = { id: id, cpu: spec.cpu, mem: spec.mem, up: true, used: { cpu: 0, mem: 0 }, containers: [] }; return this; },
      registerImage: function (id, spec) { images[id] = { signed: !!(spec && spec.signed) }; return this; },

      // run a container: signature gate -> bin-pack schedule
      run: function (spec) {
        var img = images[spec.image];
        if (!img) return { ok: false, reason: 'image "' + spec.image + '" not in registry' };
        if (!img.signed && !cfg.allowUnsigned) { rec('reject', { image: spec.image, reason: 'unsigned' }); return { ok: false, reason: 'unsigned image "' + spec.image + '" — refused (supply-chain policy)' }; }
        var node = pickNode(spec);
        if (!node) { rec('pending', { image: spec.image }); return { ok: false, pending: true, reason: 'no node with capacity for ' + spec.cpu + 'cpu/' + spec.mem + 'mem' }; }
        var id = spec.id || ('c_' + (++seq)); nodes[node].used.cpu += spec.cpu; nodes[node].used.mem += spec.mem; nodes[node].containers.push(id);
        containers[id] = { id: id, image: spec.image, cpu: spec.cpu, mem: spec.mem, node: node, state: 'running' };
        rec('run', { id: id, node: node }); return { ok: true, container: id, node: node };
      },

      // HPA autoscaling
      autoscale: function (d) {
        var desired = Math.ceil(d.replicas * (d.currentUtil / d.targetUtil));
        desired = Math.max(d.min || 1, Math.min(d.max || Infinity, desired));
        return { current: d.replicas, desired: desired, action: desired > d.replicas ? 'scale-up' : desired < d.replicas ? 'scale-down' : 'hold' };
      },

      // self-healing: reschedule a container onto another healthy node
      heal: function (containerId) {
        var c = containers[containerId]; if (!c) return { ok: false };
        var old = nodes[c.node]; if (old) { old.used.cpu -= c.cpu; old.used.mem -= c.mem; old.containers = old.containers.filter(function (x) { return x !== containerId; }); }
        var node = pickNode({ cpu: c.cpu, mem: c.mem });
        if (!node) { c.state = 'pending'; return { ok: false, pending: true, reason: 'no capacity to reschedule' }; }
        c.node = node; c.state = 'running'; nodes[node].used.cpu += c.cpu; nodes[node].used.mem += c.mem; nodes[node].containers.push(containerId);
        rec('heal', { id: containerId, node: node }); return { ok: true, rescheduledTo: node };
      },
      // node failure: reschedule every container that was on it
      nodeFailure: function (nodeId) {
        var n = nodes[nodeId]; if (!n) return { ok: false }; n.up = false;
        var affected = n.containers.slice(); n.containers = []; n.used = { cpu: 0, mem: 0 };
        var results = affected.map(function (cid) { containers[cid].node = null; return { container: cid, result: O.heal(cid) }; });
        rec('node-failure', { node: nodeId, rescheduled: results.length });
        return { failedNode: nodeId, rescheduled: results };
      },
      nodeUsage: function (id) { var n = nodes[id]; return n ? { cpu: n.used.cpu + '/' + n.cpu, mem: n.used.mem + '/' + n.mem, containers: n.containers.length } : null; },
      container: function (id) { return containers[id]; }
    };
    return O;
  }
  window.AquinContainer = { createOrchestrator: createOrchestrator };
})();
