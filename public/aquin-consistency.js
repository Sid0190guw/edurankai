/*
 * aquin-consistency.js — AquinTutor Educational Truth + Consistency Engine
 * (AES-000, Ch 18 Truth + Ch 19 Consistency).
 *
 * Truth (Ch 18) is not "a stored fact" — it is the highest-confidence claim
 * supported by governed evidence, WITH an explicit validity domain, provenance,
 * confidence, and version. Consistency (Ch 19) checks whether many individually
 * correct truths remain mutually compatible, and — crucially — distinguishes a
 * genuine contradiction from legitimate *contextual specialization* (different
 * validity domains). This is exactly the "Bernoulli works in all fluids" vs
 * "Bernoulli neglects viscosity" problem.
 *
 * Model: a TruthAssertion is about a `subject` (e.g. "bernoulli.applies"), takes
 * a `value` (mutually-exclusive label within a subject), and holds only within a
 * `domain` (a set of region tags; the tag "all" spans the universe). Two
 * assertions on the same subject with different values CONTRADICT iff their
 * domains overlap; if their domains are disjoint they are a valid specialization.
 *
 * HONEST SCOPE: the domain model is a tag-based region algebra (overlap = shared
 * tag, or the universal tag "all"), not a full first-order theory. It captures
 * the applicability/validity-domain class of contradictions precisely; richer
 * logical/mathematical consistency (unit algebra, theorem proving) is declared
 * future work, not faked.
 */
(function () {
  function makeAssertion(spec) {
    return {
      id: spec.id || ('truth_' + Math.random().toString(36).slice(2, 9)),
      conceptId: spec.conceptId || null,
      subject: spec.subject,                 // what the claim is about
      value: spec.value,                     // mutually-exclusive label within subject
      domain: (spec.domain && spec.domain.length) ? spec.domain.slice() : ['all'],
      hard: spec.hard !== false,             // hard constraint by default
      confidence: typeof spec.confidence === 'number' ? spec.confidence : 0.9,
      provenance: spec.provenance || null,   // MANDATORY (Ch 18: truth is inseparable from provenance)
      version: spec.version || 1,
      supersedes: spec.supersedes || null,   // id of an assertion this one replaces
      note: spec.note || ''
    };
  }

  // region algebra: overlap if either domain is universal, or they share a tag
  function regionOverlap(a, b) {
    if (a.indexOf('all') >= 0 || b.indexOf('all') >= 0) return true;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) return true;
    return false;
  }
  function regionIntersection(a, b) {
    if (a.indexOf('all') >= 0) return b.slice();
    if (b.indexOf('all') >= 0) return a.slice();
    return a.filter(function (t) { return b.indexOf(t) >= 0; });
  }

  function ConsistencyEngine() { this.assertions = []; this._superseded = {}; }
  ConsistencyEngine.prototype.add = function (spec) {
    var a = makeAssertion(spec);
    if (!a.subject || !a.value) throw { code: 'INVALID_TRUTH', message: 'assertion needs subject and value' };
    if (!a.provenance || !a.provenance.source) throw { code: 'MISSING_PROVENANCE', message: 'Educational Truth requires provenance.source (truth is inseparable from provenance)' };
    if (a.supersedes) this._superseded[a.supersedes] = a.id;
    this.assertions.push(a);
    return this;
  };
  // check every same-subject pair; classify contradiction vs specialization vs evolution
  ConsistencyEngine.prototype.check = function () {
    var self = this, hard = [], soft = [], specializations = [], evolutions = [];
    var A = this.assertions.filter(function (x) { return !self._superseded[x.id]; }); // drop replaced versions
    for (var i = 0; i < A.length; i++) {
      for (var j = i + 1; j < A.length; j++) {
        var x = A[i], y = A[j];
        if (x.subject !== y.subject) continue;
        if (x.supersedes === y.id || y.supersedes === x.id) { evolutions.push({ subject: x.subject, from: (x.supersedes ? y.id : x.id), to: (x.supersedes ? x.id : y.id) }); continue; }
        if (x.value === y.value) continue;                        // agree
        var over = regionOverlap(x.domain, y.domain);
        if (over) {
          var region = regionIntersection(x.domain, y.domain);
          var v = { id: 'viol_' + x.id + '_' + y.id, subject: x.subject, a: { id: x.id, value: x.value, domain: x.domain, source: x.provenance.source }, b: { id: y.id, value: y.value, domain: y.domain, source: y.provenance.source }, overlapRegion: region, detail: 'Same subject "' + x.subject + '" asserts "' + x.value + '" (' + x.domain.join('|') + ') and "' + y.value + '" (' + y.domain.join('|') + ') over the overlapping region [' + region.join('|') + '].' };
          if (x.hard && y.hard) hard.push(v); else soft.push(v);
        } else {
          specializations.push({ subject: x.subject, a: { value: x.value, domain: x.domain }, b: { value: y.value, domain: y.domain }, detail: 'Legitimate contextual specialization: different validity domains (' + x.domain.join('|') + ' vs ' + y.domain.join('|') + ').' });
        }
      }
    }
    return { ok: hard.length === 0, hardViolations: hard, softViolations: soft, contextualSpecializations: specializations, evolutions: evolutions };
  };
  ConsistencyEngine.prototype.explain = function (violId) {
    var r = this.check();
    return r.hardViolations.concat(r.softViolations).filter(function (v) { return v.id === violId; })[0] || null;
  };

  window.AquinConsistency = { makeAssertion: makeAssertion, regionOverlap: regionOverlap, ConsistencyEngine: ConsistencyEngine };
})();
