/*
 * aquin-civilization.js — Educational Civilization Engine (AES-100, Vol II,
 * Ch 53). The highest layer: it coordinates a global educational ecosystem by
 * FEDERATION, not centralization. Institutions are autonomous Educational Nodes;
 * the engine coordinates, it does not control.
 *
 * Guarantees proven in the tests:
 *  - Portable lifelong Educational Identity: one learner's record spans many
 *    nodes (primary → high → university) WITHOUT fragmenting.
 *  - Knowledge/credential exchange occurs ONLY under a federation agreement.
 *  - Credentials are verifiable Runtime Objects (issuer + provenance + status).
 *  - Approved Educational Genome updates are distributed, but each node keeps its
 *    own LOCAL ADOPTION policy (it may adopt or defer).
 *  - Resilience: a node outage does not break the federation (graceful degradation).
 *
 * Composes the World Runtime (federated worlds), EOK (identity), Evolution
 * (genome). HONEST SCOPE: cross-jurisdiction transport, cryptographic credential
 * signing, and data-sovereignty enforcement are the deployment substrates behind
 * this coordination layer.
 */
(function () {
  function createCivilization() {
    var nodes = {};          // id -> { id, type, name, up:true, adoptedGenome }
    var agreements = {};     // "a|b" -> { share:[...] }
    var identities = {};     // learnerId -> [ { node, record, at } ]  (portable, lifelong)
    var credentials = {};    // credId -> { issuer, learner, kind, provenance, verified }
    var provenance = []; var seq = 0;
    function key(a, b) { return [a, b].sort().join('|'); }
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var C = {
      provenance: provenance,
      registerNode: function (n) { nodes[n.id] = { id: n.id, type: n.type || 'institution', name: n.name || n.id, up: true, adoptedGenome: null }; rec('register-node', { id: n.id, type: n.type }); return this; },
      nodes: function () { return Object.keys(nodes); },

      // federation agreement governs what two nodes may exchange
      agreement: function (a, b, spec) { agreements[key(a, b)] = { share: (spec && spec.share) || [] }; rec('agreement', { a: a, b: b, share: (spec && spec.share) }); return this; },
      canExchange: function (a, b, artifactType) { var ag = agreements[key(a, b)]; return !!(ag && ag.share.indexOf(artifactType) >= 0); },

      // portable lifelong Educational Identity — spans nodes, never fragments
      addRecord: function (learnerId, nodeId, record) { (identities[learnerId] = identities[learnerId] || []).push({ node: nodeId, record: record, at: Date.now() }); rec('identity-record', { learner: learnerId, node: nodeId }); return this; },
      identity: function (learnerId) { return { learner: learnerId, records: (identities[learnerId] || []).slice(), nodes: [].concat.apply([], (identities[learnerId] || []).map(function (r) { return [r.node]; })).filter(function (v, i, a) { return a.indexOf(v) === i; }) }; },

      // governed knowledge exchange
      exchange: function (fromNode, toNode, artifact) {
        if (!this.canExchange(fromNode, toNode, artifact.type)) { rec('exchange-denied', { from: fromNode, to: toNode, type: artifact.type }); return { ok: false, reason: 'no federation agreement permits sharing "' + artifact.type + '"' }; }
        rec('exchange', { from: fromNode, to: toNode, type: artifact.type }); return { ok: true, delivered: artifact.type };
      },

      // credential federation — verifiable Runtime Objects
      issueCredential: function (nodeId, learnerId, cred) { var id = 'cred_' + (++seq).toString(36); credentials[id] = { id: id, issuer: nodeId, learner: learnerId, kind: cred.kind || 'certificate', provenance: { issuedBy: nodeId, at: Date.now() }, verified: true }; rec('issue-credential', { id: id, issuer: nodeId }); return credentials[id]; },
      verifyCredential: function (credId) { var c = credentials[credId]; return c ? { valid: true, issuer: c.issuer, kind: c.kind, provenance: c.provenance } : { valid: false, reason: 'unknown credential' }; },

      // distribute an approved Genome version; each node keeps LOCAL adoption policy
      distributeGenome: function (version, adoptionPolicy) {
        var adopted = [], deferred = [];
        Object.keys(nodes).forEach(function (k) { var n = nodes[k]; if (!n.up) return; var adopt = adoptionPolicy ? adoptionPolicy(n) : true; if (adopt) { n.adoptedGenome = version; adopted.push(k); } else deferred.push(k); });
        rec('distribute-genome', { version: version, adopted: adopted.length, deferred: deferred.length });
        return { version: version, adopted: adopted, deferred: deferred };
      },

      // resilience: a node outage does not break the federation
      setNodeUp: function (nodeId, up) { if (nodes[nodeId]) nodes[nodeId].up = up; rec('node-status', { node: nodeId, up: up }); return this; },
      operationalNodes: function () { return Object.keys(nodes).filter(function (k) { return nodes[k].up; }); },
      civilizationHealth: function () { var total = Object.keys(nodes).length, up = this.operationalNodes().length; return { nodes: total, operational: up, degraded: total - up, federationRunning: up > 0 }; }
    };
    return C;
  }
  window.AquinCivilization = { createCivilization: createCivilization };
})();
