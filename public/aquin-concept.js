/*
 * aquin-concept.js — AquinTutor Educational Knowledge Model (AES-000, Ch 2).
 * "What is a Concept?" — the computational DNA every future subsystem shares.
 *
 * A Concept is the smallest independently-understandable semantic unit. It has
 *   - an IMMUTABLE computational identity (never a display name), and separable
 *     human-readable representations per language;
 *   - SEVEN dimensions (semantic, mathematical, visual, experimental,
 *     dependency, misconception, application) describing its full educational
 *     existence — meaning, not presentation;
 *   - NO rendering instructions, UI, timelines or device assets. The visual and
 *     experimental dimensions hold *descriptors that point to* the renderer /
 *     lab runtime (scene ids, routes), never duplicated graphics.
 * Concepts live in a semantic graph of TYPED relationships (each carrying
 * direction, confidence, provenance, temporal validity, educational importance,
 * version). Reasoning subsystems traverse this graph; the model itself assumes
 * no browser, AI model, or rendering engine — only stable semantic interfaces.
 *
 * Dual-exported: window.AquinConcept (browser) and module.exports (Node tests).
 */
(function () {
  var RELATION_TYPES = ['prerequisite', 'dependency', 'composition', 'specialization',
    'analogy', 'contradiction', 'causality', 'mathematical-derivation', 'experimental-validation',
    'historical-evolution', 'interdisciplinary-association', 'practical-application'];
  // edges that constrain learning order (A depends on / requires B → learn B first)
  var PREREQUISITE_TYPES = { prerequisite: 1, dependency: 1 };
  // keys a visual descriptor may carry — anything asset/UI-like is rejected, to
  // enforce "a Concept contains no rendering instructions or device assets".
  var VISUAL_ALLOWED = { kind: 1, sceneId: 1, route: 1, caption: 1, params: 1 };
  var VISUAL_FORBIDDEN = { timeline: 1, assetUrl: 1, css: 1, cssClass: 1, html: 1, width: 1, height: 1, fps: 1 };

  function isStr(x) { return typeof x === 'string' && x.length > 0; }
  function clamp01(x, d) { return typeof x === 'number' ? Math.max(0, Math.min(1, x)) : d; }

  // ---- Concept validation (structure of meaning, not presentation) ------
  function validateConcept(c) {
    var errs = [];
    if (!c || typeof c !== 'object') return ['concept must be an object'];
    if (!isStr(c.id)) errs.push('concept.id is required and must be a stable non-empty string (never a display name)');
    if (!c.representations || typeof c.representations !== 'object' || !Object.keys(c.representations).length)
      errs.push('concept.representations must contain at least one language representation');
    else if (!c.representations.en || !isStr(c.representations.en.name))
      errs.push('concept.representations.en.name is required as the canonical readable label');
    var d = c.dimensions || {};
    if (!d.semantic || !isStr(d.semantic.definition))
      errs.push('concept.dimensions.semantic.definition is required — a Concept must define its meaning');
    // enforce the separation rule: visual descriptors carry no rendering assets
    if (d.visual && Array.isArray(d.visual.descriptors)) {
      d.visual.descriptors.forEach(function (v, i) {
        Object.keys(v || {}).forEach(function (k) {
          if (VISUAL_FORBIDDEN[k]) errs.push('visual.descriptors[' + i + '] contains forbidden rendering key "' + k + '" — visuals are descriptors, not assets');
          else if (!VISUAL_ALLOWED[k]) errs.push('visual.descriptors[' + i + '] has unknown key "' + k + '"');
        });
      });
    }
    return errs;
  }

  function freezeConcept(c) {
    var out = JSON.parse(JSON.stringify(c));               // detach from caller
    out.meta = out.meta || {}; out.meta.version = out.meta.version || 1; out.meta.createdAt = out.meta.createdAt || Date.now();
    return deepFreeze(out);
  }
  function deepFreeze(o) { if (o && typeof o === 'object') { Object.getOwnPropertyNames(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); } return o; }

  // ---- the semantic graph -----------------------------------------------
  function ConceptGraph() { this.nodes = {}; this.edges = []; }
  ConceptGraph.prototype.addConcept = function (c) {
    var errs = validateConcept(c);
    if (errs.length) throw { code: 'INVALID_CONCEPT', concept: c && c.id, errors: errs, message: 'Invalid concept "' + (c && c.id) + '": ' + errs[0] };
    if (this.nodes[c.id]) throw { code: 'DUPLICATE_CONCEPT', message: 'Concept id "' + c.id + '" already exists' };
    this.nodes[c.id] = freezeConcept(c);
    return this;
  };
  ConceptGraph.prototype.addRelation = function (r) {
    if (!r || RELATION_TYPES.indexOf(r.type) < 0) throw { code: 'INVALID_RELATION', message: 'Relation type must be one of: ' + RELATION_TYPES.join(', ') };
    if (!this.nodes[r.from]) throw { code: 'DANGLING_RELATION', message: 'Relation source "' + r.from + '" is not a known concept' };
    if (!this.nodes[r.to]) throw { code: 'DANGLING_RELATION', message: 'Relation target "' + r.to + '" is not a known concept' };
    this.edges.push(Object.freeze({
      from: r.from, to: r.to, type: r.type,
      direction: r.direction || 'directed',
      confidence: clamp01(r.confidence, 1),
      provenance: r.provenance || 'authored',
      temporalValidity: r.temporalValidity || { from: null, to: null },
      importance: clamp01(r.importance, 0.5),
      version: r.version || 1
    }));
    return this;
  };
  ConceptGraph.prototype.get = function (id) { return this.nodes[id]; };
  ConceptGraph.prototype.relations = function (id, opts) {
    opts = opts || {};
    return this.edges.filter(function (e) {
      var match = (e.from === id) || (opts.incoming && e.to === id) || (e.direction === 'bidirectional' && e.to === id);
      if (!match) return false;
      if (opts.type && e.type !== opts.type) return false;
      return true;
    });
  };

  // ---- reasoning: prerequisite closure in learnable order ---------------
  // Follows prerequisite/dependency edges (A → B means "A requires B"), returns
  // B's before A's (post-order topo). Cycle-guarded (never loops forever).
  ConceptGraph.prototype.prerequisites = function (id) {
    var self = this, order = [], visited = {}, onStack = {}, cycles = [];
    function reqOf(x) { return self.edges.filter(function (e) { return e.from === x && PREREQUISITE_TYPES[e.type]; }).map(function (e) { return e.to; }); }
    function dfs(x) {
      if (visited[x]) return; onStack[x] = true;
      reqOf(x).forEach(function (dep) {
        if (onStack[dep]) { cycles.push(x + ' → ' + dep); return; }
        dfs(dep);
      });
      onStack[x] = false; visited[x] = true;
      if (x !== id) order.push(x);                          // exclude the target itself
    }
    if (!this.nodes[id]) throw { code: 'UNKNOWN_CONCEPT', message: 'No concept "' + id + '"' };
    dfs(id);
    return { target: id, order: order, cycles: cycles };
  };
  // A concrete learning pathway = prerequisites, then the target.
  ConceptGraph.prototype.learningPathway = function (id) { var p = this.prerequisites(id); return p.order.concat([id]); };

  ConceptGraph.prototype.misconceptions = function (id) {
    var c = this.nodes[id]; return (c && c.dimensions && c.dimensions.misconception && c.dimensions.misconception.items) || [];
  };
  ConceptGraph.prototype.representation = function (id, lang) {
    var c = this.nodes[id]; if (!c) return null;
    var r = c.representations; return (r[lang] || r.en || r[Object.keys(r)[0]]);
  };
  ConceptGraph.prototype.representationsOfKind = function (id, dimension) {
    var c = this.nodes[id]; if (!c || !c.dimensions) return [];
    if (dimension === 'visual') return (c.dimensions.visual && c.dimensions.visual.descriptors) || [];
    if (dimension === 'experimental') return c.dimensions.experimental ? [c.dimensions.experimental] : [];
    if (dimension === 'mathematical') return c.dimensions.mathematical ? [c.dimensions.mathematical] : [];
    return [];
  };
  // whole-graph diagnostics (non-terminating): dangling refs, prerequisite cycles.
  ConceptGraph.prototype.validate = function () {
    var self = this, diags = [];
    this.edges.forEach(function (e) {
      if (!self.nodes[e.from]) diags.push({ severity: 'error', rule: 'dangling-source', detail: e.from });
      if (!self.nodes[e.to]) diags.push({ severity: 'error', rule: 'dangling-target', detail: e.to });
    });
    Object.keys(this.nodes).forEach(function (id) {
      var p = self.prerequisites(id);
      p.cycles.forEach(function (c) { diags.push({ severity: 'error', rule: 'prerequisite-cycle', detail: c }); });
    });
    // de-dup cycle diagnostics
    var seen = {}; diags = diags.filter(function (d) { var k = d.rule + ':' + d.detail; if (seen[k]) return false; seen[k] = true; return true; });
    return { ok: diags.filter(function (d) { return d.severity === 'error'; }).length === 0, diagnostics: diags };
  };

  // ---- a real seed: the fluid-mechanics concept cluster -----------------
  // Ties the model to what already ships: visual→animation/lab routes,
  // experimental→the Venturi & Airfoil labs, representations→22-lang registry,
  // misconception→the exact error the classroom already teaches against.
  function seedFluidMechanics() {
    var g = new ConceptGraph();
    function C(id, en, hi, def, extra) {
      var c = { id: id, representations: { en: { name: en } }, dimensions: { semantic: { definition: def } } };
      if (hi) c.representations.hi = { name: hi };
      if (extra) for (var k in extra) c.dimensions[k] = extra[k];
      return c;
    }
    g.addConcept(C('cpt_pressure', 'Pressure', 'दाब', 'Force exerted per unit area by a fluid or solid on a surface.', { mathematical: { equations: [{ plain: 'P = F / A', meaning: 'pressure is force over area' }], symbols: [{ sym: 'P', meaning: 'pressure', unit: 'Pa' }] } }));
    g.addConcept(C('cpt_velocity', 'Velocity', 'वेग', 'Rate of change of position with time; speed with a direction.', { visual: { descriptors: [{ kind: 'animation', sceneId: 'waves', caption: 'wavefronts moving at a speed' }] } }));
    g.addConcept(C('cpt_density', 'Density', 'घनत्व', 'Mass per unit volume of a substance.', { mathematical: { equations: [{ plain: 'ρ = m / V', meaning: 'density is mass over volume' }], symbols: [{ sym: 'ρ', meaning: 'density', unit: 'kg/m³' }] } }));
    g.addConcept(C('cpt_energy_conservation', 'Energy Conservation', 'ऊर्जा संरक्षण', 'Total energy of an isolated system remains constant; it only transforms.'));
    g.addConcept(C('cpt_continuity', 'Continuity (Conservation of Mass)', 'सातत्य', 'For an incompressible fluid the volume flow rate is constant along a pipe.', {
      mathematical: { equations: [{ plain: 'A₁v₁ = A₂v₂', meaning: 'area times velocity is constant' }] },
      experimental: { observables: ['flow speed'], controllables: ['pipe area'], measurables: ['velocity'], expectedBehaviours: ['narrower pipe → faster flow'], safety: [], objectives: ['see mass conservation'], labRoute: '/aquintutor/lab/venturi' }
    }));
    g.addConcept({
      id: 'cpt_bernoulli',
      representations: { en: { name: "Bernoulli's Principle" }, hi: { name: 'बर्नौली का सिद्धांत' }, mr: { name: 'बर्नुलीचे तत्त्व' } },
      dimensions: {
        semantic: { definition: 'Along a streamline of an ideal fluid, faster flow corresponds to lower pressure, because total mechanical energy is conserved.', distinguishesFrom: ['cpt_continuity'] },
        mathematical: { equations: [{ plain: 'P + ½ρv² + ρgh = constant', meaning: 'pressure + kinetic + potential energy per volume is constant' }], symbols: [{ sym: 'P', meaning: 'pressure', unit: 'Pa' }, { sym: 'ρ', meaning: 'density', unit: 'kg/m³' }, { sym: 'v', meaning: 'velocity', unit: 'm/s' }] },
        visual: { descriptors: [{ kind: 'simulation', route: '/aquintutor/lab/venturi', caption: 'Venturi flow — pressure drops where the pipe narrows' }, { kind: 'simulation', route: '/aquintutor/lab/airfoil', caption: 'Airfoil — faster air over the top gives lift' }] },
        experimental: { observables: ['throat pressure', 'flow speed'], controllables: ['inlet velocity', 'throat ratio', 'inlet pressure'], measurables: ['pressure drop', 'flow rate'], expectedBehaviours: ['narrower throat → faster flow → lower pressure'], safety: ['cavitation if pressure nears vapour pressure'], objectives: ['relate speed and pressure'], labRoute: '/aquintutor/lab/venturi' },
        misconception: { items: [
          { id: 'mc_faster_higher_pressure', belief: 'Faster-moving fluid pushes harder, so it must have higher pressure.', similarityToCorrect: 0.5, indicators: ['predicts high pressure at the throat'], causes: ['everyday intuition that "fast = forceful"'], intervention: 'Show the manometer at the throat reading LOW while speed is HIGH; tie it to energy conservation.', assessment: 'Ask what happens to pressure when a pipe narrows.' },
          { id: 'mc_velocity_acceleration', belief: 'Velocity and acceleration are the same thing.', similarityToCorrect: 0.3, indicators: ['confuses steady fast flow with speeding up'], causes: ['loose everyday language'], intervention: 'Contrast constant velocity vs changing velocity explicitly.', assessment: 'Give a constant-speed scenario and ask for the acceleration.' }
        ] },
        application: { engineering: ['aircraft wing lift', 'carburettor', 'Venturi flow meter'], interdisciplinary: ['arterial blood flow'], societal: ['spinning-ball sports (Magnus effect)'], historical: ['Daniel Bernoulli, Hydrodynamica, 1738'] }
      }
    });
    // typed semantic relationships (prerequisite/dependency drive learning order)
    ['cpt_pressure', 'cpt_velocity', 'cpt_density', 'cpt_energy_conservation', 'cpt_continuity'].forEach(function (dep) {
      g.addRelation({ from: 'cpt_bernoulli', to: dep, type: 'prerequisite', importance: 0.9, provenance: 'authored' });
    });
    g.addRelation({ from: 'cpt_continuity', to: 'cpt_density', type: 'dependency', importance: 0.7 });
    g.addRelation({ from: 'cpt_continuity', to: 'cpt_velocity', type: 'dependency', importance: 0.7 });
    g.addRelation({ from: 'cpt_bernoulli', to: 'cpt_continuity', type: 'mathematical-derivation', importance: 0.8, provenance: 'authored' });
    g.addRelation({ from: 'cpt_bernoulli', to: 'cpt_pressure', type: 'practical-application', importance: 0.6 });
    return g;
  }

  var API = {
    RELATION_TYPES: RELATION_TYPES,
    ConceptGraph: ConceptGraph,
    validateConcept: validateConcept,
    seedFluidMechanics: seedFluidMechanics
  };
  if (typeof window !== 'undefined') window.AquinConcept = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
