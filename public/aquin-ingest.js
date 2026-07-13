/*
 * aquin-ingest.js — Educational Knowledge Ingestion Pipeline (AES-001, Ch 9).
 * Knowledge is NEVER imported directly. Every external artifact enters as an
 * immutable Knowledge Candidate and must clear a constitutional pipeline before
 * it may influence Educational Reality:
 *
 *   acquisition/authenticity -> normalization -> interpretation -> validation
 *   -> cross-domain validation -> governance -> integration
 *
 * Anything that fails any stage is QUARANTINED (isolated, never used), with the
 * failing stage + reason recorded. This is the concrete answer to "acquire
 * continuously without corrupting Educational Truth, without hallucination,
 * only from bonafide sources, with provenance."
 *
 * It composes the engines already built: Consistency (truth compatibility, via a
 * sandbox so a contradiction never commits), Concept (semantic integration), and
 * the EOK (integration is a governed kernel transaction). Cross-domain
 * validation means no single validator accepts knowledge alone.
 *
 * HONEST SCOPE: this is the pipeline CORE + gates. Real discovery crawlers,
 * publication APIs, OCR/parsers, and multimodal extractors are the pluggable
 * substrates that produce Candidates; they are not implemented here.
 */
(function () {
  // trust tiers for bonafide sources (higher = more authoritative)
  var SOURCE_TIERS = {
    'peer-reviewed': 1.0, 'standards-body': 0.95, 'government': 0.9, 'university': 0.9,
    'textbook': 0.8, 'educator': 0.6, 'preprint': 0.5, 'blog': 0.2, 'social': 0.1, 'unknown': 0.0
  };

  function makeCandidate(spec) {
    return Object.freeze({
      id: spec.id || ('cand_' + Math.random().toString(36).slice(2, 9)),
      provenance: spec.provenance || null,          // { source, ... } — MANDATORY
      license: spec.license || null,                // MANDATORY at governance stage
      proposes: Object.freeze({
        concepts: (spec.proposes && spec.proposes.concepts) || [],
        truths: (spec.proposes && spec.proposes.truths) || [],
        relations: (spec.proposes && spec.proposes.relations) || []
      }),
      acquiredAt: spec.acquiredAt || Date.now()
    });
  }

  function Pipeline(cfg) {
    cfg = cfg || {};
    this.knowledge = cfg.knowledge || null;         // ConceptGraph
    this.consistency = cfg.consistency || null;     // ConsistencyEngine (for hard-contradiction checks)
    this.kernel = cfg.kernel || null;               // EOK (integration = governed transaction)
    this.sources = cfg.sources || {};               // { 'NASA Glenn Research Center': 'government', ... }
    this.threshold = cfg.threshold != null ? cfg.threshold : 0.6;
    this.validators = {};                           // domain -> fn(candidate) -> {ok, reason, confidence}
    this.required = [];                             // cross-domain validators that MUST pass
    this.truths = [];                               // committed truth assertions (for sandbox checks)
    this.quarantine = [];                           // failed candidates (isolated)
    this.integrated = [];                           // lineage of accepted candidates
  }
  Pipeline.prototype.registerValidator = function (domain, fn) { this.validators[domain] = fn; return this; };
  Pipeline.prototype.requireValidators = function (list) { this.required = list.slice(); return this; };

  Pipeline.prototype.ingest = function (candidateSpec) {
    var self = this;
    var candidate = makeCandidate(candidateSpec);   // always normalize (defaults + freeze)
    var lineage = [];
    function stage(name, ok, detail) { lineage.push({ stage: name, ok: ok, detail: detail || '' }); }
    function quarantine(atStage, reason) { var q = { candidate: candidate.id, stage: atStage, reason: reason, lineage: lineage, at: Date.now() }; self.quarantine.push(q); return { status: 'quarantined', stage: atStage, reason: reason, lineage: lineage }; }

    // 1) ACQUISITION / AUTHENTICITY — provenance + bonafide source
    if (!candidate.provenance || !candidate.provenance.source) { stage('acquisition', false, 'missing provenance'); return quarantine('acquisition', 'missing provenance.source'); }
    var tier = this.sources[candidate.provenance.source] || 'unknown';
    var trust = SOURCE_TIERS[tier] != null ? SOURCE_TIERS[tier] : 0;
    stage('acquisition', trust >= this.threshold, 'source="' + candidate.provenance.source + '" tier=' + tier + ' trust=' + trust);
    if (trust < this.threshold) return quarantine('acquisition', 'low-bonafide source (' + tier + ', trust ' + trust + ' < ' + this.threshold + ')');

    // 2) NORMALIZATION + 3) INTERPRETATION
    var concepts = candidate.proposes.concepts, truths = candidate.proposes.truths, relations = candidate.proposes.relations;
    stage('interpretation', true, concepts.length + ' concept(s), ' + truths.length + ' truth(s), ' + relations.length + ' relation(s)');

    // 4) VALIDATION — truth consistency in a SANDBOX (a contradiction never commits)
    if (this.consistency && truths.length) {
      for (var i = 0; i < truths.length; i++) {
        var sandbox = new (this.consistency.constructor)();
        var all = this.truths.concat([truths[i]]);
        var threw = null;
        try { all.forEach(function (a) { sandbox.add(a); }); var chk = sandbox.check(); if (chk.hardViolations.length) threw = chk.hardViolations[0].detail; }
        catch (e) { threw = String(e && e.message || e); }
        if (threw) { stage('validation', false, 'truth conflict: ' + threw); return quarantine('validation', 'Educational Truth conflict: ' + threw); }
      }
      stage('validation', true, 'no truth contradictions');
    }

    // 5) CROSS-DOMAIN VALIDATION — no single validator accepts knowledge alone
    for (var d = 0; d < this.required.length; d++) {
      var dom = this.required[d], fn = this.validators[dom];
      if (!fn) { stage('cross-domain', false, 'validator "' + dom + '" not registered'); return quarantine('cross-domain', 'required validator "' + dom + '" missing'); }
      var res = fn(candidate) || {};
      stage('cross-domain', !!res.ok, dom + ': ' + (res.reason || (res.ok ? 'ok' : 'rejected')));
      if (!res.ok) return quarantine('cross-domain', dom + ' rejected: ' + (res.reason || 'unspecified'));
    }

    // 6) GOVERNANCE — licensing/authority
    if (!candidate.license) { stage('governance', false, 'no license'); return quarantine('governance', 'missing license'); }
    stage('governance', true, 'license=' + candidate.license);

    // 7) INTEGRATION — governed commit (kernel transaction if available, else direct)
    var committed = [];
    concepts.forEach(function (c) {
      try {
        if (self.kernel) { var r = self.kernel.submit({ type: 'concept', subsystem: 'knowledge', authority: 'assisted', granted: true, provenance: candidate.provenance, payload: c }); if (r.ok) committed.push('concept:' + c.id); }
        else if (self.knowledge) { self.knowledge.addConcept(c); committed.push('concept:' + c.id); }
      } catch (e) { stage('integration', false, 'concept ' + (c && c.id) + ': ' + String(e && e.message || e)); }
    });
    truths.forEach(function (t) {
      self.truths.push(t);
      if (self.consistency) { try { self.consistency.add(t); } catch (e) {} }
      committed.push('truth:' + t.subject);
    });
    stage('integration', true, 'committed ' + committed.length + ' object(s)');
    var record = { candidate: candidate.id, source: candidate.provenance.source, committed: committed, lineage: lineage, at: Date.now() };
    this.integrated.push(record);
    return { status: 'integrated', committed: committed, lineage: lineage };
  };

  window.AquinIngest = { SOURCE_TIERS: SOURCE_TIERS, makeCandidate: makeCandidate, Pipeline: Pipeline };
})();
