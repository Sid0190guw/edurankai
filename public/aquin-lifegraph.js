/*
 * aquin-lifegraph.js — Educational Life Graph Engine (AES-100, Vol II, Ch 46).
 * A teacher remembers a learner as an evolving STORY, not a pile of records. The
 * Life Graph represents education as a lifelong CAUSAL network: events, concepts,
 * missions, people, interests, reflections, and misconceptions connected by TYPED
 * causal relationships (inspired / led-to / strengthened / corrected / mentored /
 * recurred / …), each with confidence + provenance.
 *
 * It answers "why did it happen?" and "what changed afterwards?" via graph
 * traversal, not keyword search: narrative chains, "what inspired this interest",
 * "who influenced this learner", "which misconceptions recurred", and a generated
 * educational biography — all from causal reasoning over the graph.
 *
 * This is the long-term semantic memory substrate the Mentor (Ch 9), Prediction
 * (Ch 45), Research, and Career engines read from. HONEST SCOPE: an in-memory
 * causal graph; distributed lifelong-scale partitioning implements the same
 * interface later.
 */
(function () {
  var NODE_TYPES = ['event', 'concept', 'mission', 'person', 'interest', 'reflection', 'misconception', 'achievement'];
  var REL_TYPES = ['inspired', 'led-to', 'strengthened', 'weakened', 'corrected', 'practiced', 'collaborated', 'mentored', 'researched', 'applied', 'verified', 'transferred', 'questioned', 'explained', 'reflected-on', 'created', 'discovered', 'attempted', 'succeeded', 'failed', 'recovered', 'recurred'];
  var FORWARD = { inspired: 1, 'led-to': 1, strengthened: 1, applied: 1, transferred: 1, created: 1, discovered: 1, recovered: 1 };

  function createLifeGraph(learnerId) {
    var nodes = {}, edges = [], seq = 0;
    function id(t) { seq++; return (t || 'n') + '_' + seq.toString(36); }

    var G = {
      learnerId: learnerId, NODE_TYPES: NODE_TYPES, REL_TYPES: REL_TYPES, edges: edges,
      addNode: function (spec) {
        if (NODE_TYPES.indexOf(spec.type) < 0) throw new Error('unknown node type "' + spec.type + '"');
        var nid = spec.id || id(spec.type); nodes[nid] = { id: nid, type: spec.type, label: spec.label || nid, at: spec.at || Date.now(), provenance: spec.provenance || null }; return nid;
      },
      link: function (from, to, rel, opts) {
        opts = opts || {};
        if (REL_TYPES.indexOf(rel) < 0) throw new Error('unknown relationship "' + rel + '"');
        if (!nodes[from] || !nodes[to]) throw new Error('link endpoints must be nodes');
        edges.push({ from: from, to: to, rel: rel, confidence: opts.confidence != null ? opts.confidence : 0.8, provenance: opts.provenance || null, evidence: opts.evidence || null, at: opts.at || Date.now() });
        return this;
      },
      node: function (nid) { return nodes[nid]; }, nodes: function () { return Object.keys(nodes); },

      // NARRATIVE: trace the forward causal chain from a starting node
      narrative: function (startId) {
        var chain = [], seen = {}, cur = startId;
        while (cur && !seen[cur]) {
          seen[cur] = true; var n = nodes[cur]; if (n) chain.push(n.label);
          var next = edges.filter(function (e) { return e.from === cur && FORWARD[e.rel]; }).sort(function (a, b) { return b.confidence - a.confidence; })[0];
          cur = next ? next.to : null;
        }
        return chain;
      },

      // semantic queries — graph traversals, not keyword search
      query: function (kind, arg) {
        if (kind === 'what-inspired') {   // back-trace 'inspired'/'led-to' to the root cause
          var chain = [], seen = {}, cur = arg;
          while (cur && !seen[cur]) { seen[cur] = true; var back = edges.filter(function (e) { return e.to === cur && (e.rel === 'inspired' || e.rel === 'led-to'); }).sort(function (a, b) { return b.confidence - a.confidence; })[0]; if (!back) break; chain.unshift(nodes[back.from] && nodes[back.from].label); cur = back.from; }
          return chain;
        }
        if (kind === 'influencers') {     // people who mentored/collaborated
          return edges.filter(function (e) { return (e.rel === 'mentored' || e.rel === 'collaborated') && nodes[e.from] && nodes[e.from].type === 'person'; }).map(function (e) { return { who: nodes[e.from].label, rel: e.rel }; });
        }
        if (kind === 'recurring-misconceptions') {  // misconception labels seen >1
          var byLabel = {}; Object.keys(nodes).forEach(function (k) { if (nodes[k].type === 'misconception') byLabel[nodes[k].label] = (byLabel[nodes[k].label] || 0) + 1; });
          edges.filter(function (e) { return e.rel === 'recurred'; }).forEach(function (e) { var l = nodes[e.to] && nodes[e.to].label; if (l) byLabel[l] = (byLabel[l] || 0) + 1; });
          return Object.keys(byLabel).filter(function (l) { return byLabel[l] > 1; });
        }
        if (kind === 'improved-confidence') {   // what strengthened confidence
          return edges.filter(function (e) { return e.rel === 'strengthened' && nodes[e.to] && /confidence/i.test(nodes[e.to].label); }).map(function (e) { return nodes[e.from].label; });
        }
        return [];
      },

      // generate an educational biography from graph reasoning
      biography: function () {
        var interests = Object.keys(nodes).filter(function (k) { return nodes[k].type === 'interest'; }).map(function (k) { return nodes[k].label; });
        var concepts = Object.keys(nodes).filter(function (k) { return nodes[k].type === 'concept'; }).map(function (k) { return nodes[k].label; });
        var turningPoints = Object.keys(nodes).filter(function (k) { return edges.filter(function (e) { return e.from === k && FORWARD[e.rel]; }).length >= 2; }).map(function (k) { return nodes[k].label; });
        var challenges = edges.filter(function (e) { return e.rel === 'recovered'; }).map(function (e) { return (nodes[e.from] && nodes[e.from].label) + ' → recovered'; });
        return {
          curiosityDevelopment: interests,
          conceptEvolution: concepts,
          turningPoints: turningPoints,
          majorChallenges: challenges,
          influencers: this.query('influencers').map(function (i) { return i.who; })
        };
      }
    };
    return G;
  }
  window.AquinLifeGraph = { NODE_TYPES: NODE_TYPES, REL_TYPES: REL_TYPES, createLifeGraph: createLifeGraph };
})();
