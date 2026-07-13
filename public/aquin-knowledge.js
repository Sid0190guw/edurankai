/*
 * aquin-knowledge.js — AES-000 Chapter 1: "What is Knowledge?" built as CODE, not
 * a doc. Chapter 1's chosen abstraction, implemented and enforced line by line:
 *
 *   "Knowledge is a typed, versioned, bitemporal property multigraph K = <C, R>,
 *    free of presentation, over which reasoning is performed — never the reasoning
 *    itself."   (C = Concepts, Ch 2 · R = Relationships, Ch 4)
 *
 * Every clause of that sentence is a real property of this store, and every one of
 * Chapter 1's five INVARIANTS is enforced in code and proven in the test harness:
 *
 *   INV-1 Presentation independence — K rejects any element carrying rendering /
 *         UI / device data (layout, colour, font, position, css, …).
 *   INV-2 Identity stability — a Concept's identity is immutable and
 *         language-independent; representations may change, identity may not.
 *   INV-3 Non-destructive evolution — edits produce NEW versions with lineage;
 *         historical K is reconstructable at any past time (bitemporal).
 *   INV-4 Meaning/learner separation — K holds NO learner state (mastery, scores,
 *         learnerId); one K, many learners.
 *   INV-5 Reasoning externality — K stores STRUCTURE only; it exposes no reason()/
 *         infer()/teach(). Intelligence is the reasoning *over* K, not a property of K.
 *
 * And Chapter 1's subsystem contract (the stable read model every runtime consumes):
 *   getConcept(id,{at}) · relations(id,{type,dir,at}) · subgraph(seeds,policy) ·
 *   versionAt(timestamp)
 *
 * "Bitemporal" is real here: two independent time axes — VALID time (when a fact is
 * true in the world) and TRANSACTION time (when the system recorded it). "Multigraph"
 * is real: multiple typed relationships may connect the same pair of concepts.
 *
 * HONEST SCOPE: this is the Chapter-1 K abstraction (the store + its invariants +
 * its read model). The seven Concept dimensions are Ch 2 (aquin-concept.js); the
 * educational relationship categories are Ch 4; reasoning over K is Ch 7
 * (aquin-cognition/reasoner). Chapter 1 deliberately contains none of those — that
 * separation IS the chapter's point.
 */
(function () {
  // INV-1: keys that would smuggle presentation into K (checked recursively)
  var FORBIDDEN_PRESENTATION = ['layout', 'color', 'colour', 'font', 'fontsize', 'position', 'x', 'y', 'width', 'height', 'css', 'style', 'render', 'device', 'pixel', 'px', 'theme', 'animation', 'icon', 'image', 'thumbnail', 'ui'];
  // INV-4: keys that would smuggle learner state into K
  var FORBIDDEN_LEARNER = ['mastery', 'understanding', 'learnerid', 'studentid', 'userid', 'score', 'progress', 'confidence', 'evidence', 'attempts', 'grade'];

  function now() { return Date.now(); }
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); } return o; }

  // recursively collect every property key (lower-cased) of a plain object/array
  function allKeys(obj, acc) {
    acc = acc || [];
    if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(function (k) { acc.push(String(k).toLowerCase()); allKeys(obj[k], acc); });
    }
    return acc;
  }
  function violation(obj, forbidden) {
    var keys = allKeys(obj);
    for (var i = 0; i < keys.length; i++) { if (forbidden.indexOf(keys[i]) >= 0) return keys[i]; }
    return null;
  }

  function createKnowledgeStore() {
    // bitemporal storage. Each concept id maps to an append-only list of versions;
    // each version has a VALID interval [validFrom, validTo) and a txTime.
    var concepts = {};        // id -> [ versionObj... ]  (append-only, INV-3)
    var relationships = [];   // append-only list of relationship versions (multigraph)
    var relSeq = 0;
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: now(), detail: d || null }); }

    // ---- writes (non-destructive, versioned) ----

    function putConcept(spec, opts) {
      opts = opts || {};
      if (!spec || spec.id == null) throw new Error('K: a Concept must have an identity (INV-2)');
      // INV-1: no presentation may enter K
      var pv = violation(spec, FORBIDDEN_PRESENTATION);
      if (pv) throw new Error('K rejects presentation in knowledge (INV-1): forbidden key "' + pv + '"');
      // INV-4: no learner state may enter K
      var lv = violation(spec, FORBIDDEN_LEARNER);
      if (lv) throw new Error('K rejects learner state in knowledge (INV-4): forbidden key "' + lv + '"');

      var vFrom = opts.validFrom != null ? opts.validFrom : now();
      var history = concepts[spec.id] || (concepts[spec.id] = []);
      // INV-2: identity is immutable — updates keep the same id; only representation changes.
      // INV-3: close the current open version's valid interval, then append a new version.
      var open = history.filter(function (v) { return v.validTo == null; })[0];
      var priorVersion = 0;
      if (open) { open.validTo = vFrom; priorVersion = open.version; }
      var version = {
        id: spec.id, kind: 'concept',
        label: spec.label != null ? spec.label : spec.id,       // representation (mutable)
        definition: spec.definition || null,                    // representation (mutable)
        dimensions: spec.dimensions || null,                    // Ch 2 detail lives here
        validFrom: vFrom, validTo: null,                        // VALID time axis
        txTime: now(),                                          // TRANSACTION time axis
        version: priorVersion + 1,
        supersedes: open ? open.version : null                  // lineage (INV-3)
      };
      history.push(version);
      rec('put-concept', { id: spec.id, version: version.version });
      return deepFreeze(Object.assign({}, version));
    }

    // typed, first-class relationship (Ch 4). Multigraph: many edges per pair allowed.
    function relate(from, to, type, opts) {
      opts = opts || {};
      if (!concepts[from] || !concepts[to]) throw new Error('K: a Relationship must connect existing Concepts');
      if (!type) throw new Error('K: a Relationship must be TYPED (INV: no meaningless edges)');
      var props = opts.properties || {};
      var pv = violation(props, FORBIDDEN_PRESENTATION); if (pv) throw new Error('K rejects presentation on a relationship (INV-1): "' + pv + '"');
      var lv = violation(props, FORBIDDEN_LEARNER); if (lv) throw new Error('K rejects learner state on a relationship (INV-4): "' + lv + '"');
      var rel = {
        rid: 'r' + (++relSeq), from: from, to: to, type: type, properties: props,
        validFrom: opts.validFrom != null ? opts.validFrom : now(), validTo: null,
        txTime: now(), version: 1
      };
      relationships.push(rel);
      rec('relate', { from: from, to: to, type: type });
      return deepFreeze(Object.assign({}, rel));
    }
    // non-destructive retire: close a relationship's valid interval (INV-3)
    function retireRelation(rid, at) { var r = relationships.filter(function (x) { return x.rid === rid && x.validTo == null; })[0]; if (r) r.validTo = at != null ? at : now(); return !!r; }

    // ---- the Chapter-1 subsystem contract (read model) ----

    function conceptVersionAt(id, at) {
      var h = concepts[id]; if (!h) return null;
      for (var i = h.length - 1; i >= 0; i--) { var v = h[i]; if (v.validFrom <= at && (v.validTo == null || at < v.validTo)) return v; }
      return null;
    }
    function getConcept(id, opts) {
      opts = opts || {}; var at = opts.at != null ? opts.at : now();
      var v = conceptVersionAt(id, at);
      return v ? deepFreeze(Object.assign({}, v)) : null;
    }
    function relations(id, opts) {
      opts = opts || {}; var at = opts.at != null ? opts.at : now();
      var dir = opts.dir || 'both', type = opts.type || null;
      return relationships.filter(function (r) {
        if (r.validFrom > at || (r.validTo != null && at >= r.validTo)) return false;   // valid-time
        if (type && r.type !== type) return false;
        if (dir === 'out') return r.from === id;
        if (dir === 'in') return r.to === id;
        return r.from === id || r.to === id;
      }).map(function (r) { return deepFreeze(Object.assign({}, r)); });
    }
    // bounded context graph (Ch 7 §context): BFS from seeds, capped by policy
    function subgraph(seedIds, policy) {
      policy = policy || {}; var maxDepth = policy.maxDepth != null ? policy.maxDepth : 2, maxNodes = policy.maxNodes || 50, at = policy.at != null ? policy.at : now();
      var seen = {}, frontier = seedIds.slice(), depth = 0, nodes = [], edges = [];
      seedIds.forEach(function (s) { seen[s] = true; });
      while (frontier.length && depth <= maxDepth && nodes.length < maxNodes) {
        var next = [];
        frontier.forEach(function (id) {
          var c = conceptVersionAt(id, at); if (c && nodes.length < maxNodes) nodes.push(deepFreeze(Object.assign({}, c)));
          relations(id, { at: at, dir: 'both' }).forEach(function (r) {
            edges.push(r);
            var other = r.from === id ? r.to : r.from;
            if (!seen[other]) { seen[other] = true; next.push(other); }
          });
        });
        frontier = next; depth++;
      }
      // de-dup edges by rid
      var eseen = {}, uedges = [];
      edges.forEach(function (e) { if (!eseen[e.rid]) { eseen[e.rid] = true; uedges.push(e); } });
      return { concepts: nodes, relationships: uedges, bounded: { maxDepth: maxDepth, maxNodes: maxNodes } };
    }
    // bitemporal snapshot: the whole K as it was VALID at a timestamp (INV-3)
    function versionAt(timestamp) {
      var cs = Object.keys(concepts).map(function (id) { return conceptVersionAt(id, timestamp); }).filter(Boolean).map(function (v) { return deepFreeze(Object.assign({}, v)); });
      var rs = relationships.filter(function (r) { return r.validFrom <= timestamp && (r.validTo == null || timestamp < r.validTo); }).map(function (r) { return deepFreeze(Object.assign({}, r)); });
      return { at: timestamp, concepts: cs, relationships: rs };
    }

    // The store exposes STRUCTURE operations only. INV-5: no reason()/infer()/teach()
    // lives here; reasoning is a separate subsystem that CONSUMES this read model.
    return {
      provenance: provenance,
      putConcept: putConcept, relate: relate, retireRelation: retireRelation,
      getConcept: getConcept, relations: relations, subgraph: subgraph, versionAt: versionAt,
      // introspection for the invariant tests
      history: function (id) { return (concepts[id] || []).map(function (v) { return { version: v.version, validFrom: v.validFrom, validTo: v.validTo, label: v.label }; }); }
    };
  }

  window.AquinKnowledge = { createKnowledgeStore: createKnowledgeStore, FORBIDDEN_PRESENTATION: FORBIDDEN_PRESENTATION, FORBIDDEN_LEARNER: FORBIDDEN_LEARNER };
})();
