/*
 * aquin-planetary-edu.js — AES-100 Vol III Part III Ch 11: Planetary Educational
 * Intelligence Network (PEINF). A FEDERATED (not centralized) global education
 * ecosystem: sovereign institutions interoperate without a world authority. The
 * generic federation/identity/credential plumbing already exists
 * (aquin-civilization.js, aquin-identity.js), so this builds the distinct education
 * cores — real and tested:
 *
 *  - SOVEREIGN CREDENTIAL RECOGNITION: a credential issued by institution A is
 *    recognised by institution B ONLY if B has chosen to recognise A (a recognition
 *    agreement, or a shared accreditation body). Federation NEVER forces recognition
 *    — each institution's policy decides (educational sovereignty).
 *  - CROSS-SYSTEM EQUIVALENCE: grades and credits are normalised through a common
 *    quality scale, so a GPA-4.0 record maps to percentage / ECTS, and US credit
 *    hours map to ECTS — enabling honest credit transfer between different systems.
 *  - LEARNING MOBILITY: a learner moving A→B transfers only the credentials B
 *    recognises, with grades/credits converted to B's system.
 *
 * HONEST SCOPE: recognition policy, equivalence math, and mobility logic are real
 * and tested; cryptographic credential signing (aquin-identity.js), and real
 * inter-governmental accreditation treaties are declared substrates.
 */
(function () {
  // grade systems -> normalise a grade to a 0..1 quality, and render quality in a system
  var GRADE = {
    gpa4: { toQuality: function (g) { return g / 4; }, fromQuality: function (q) { return +(q * 4).toFixed(2); } },
    percent: { toQuality: function (g) { return g / 100; }, fromQuality: function (q) { return Math.round(q * 100); } },
    ects100: { toQuality: function (g) { return g / 100; }, fromQuality: function (q) { return Math.round(q * 100); } }
  };
  // credit systems -> canonical "learning hours" factor
  var CREDIT = { us: 1, ects: 0.5, uk: 0.1 };   // 1 US credit ≈ 2 ECTS ≈ 10 UK credits (illustrative canonical)

  function createNetwork() {
    var insts = {};       // id -> { country, accreditation, gradeSystem, creditSystem, recognizes:Set }
    var credentials = {}; // id -> { issuer, learner, type, credits, grade }
    var seq = 0, provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var N = {
      provenance: provenance,
      institution: function (id, spec) { insts[id] = { id: id, country: spec.country || null, accreditation: spec.accreditation || null, gradeSystem: spec.gradeSystem || 'gpa4', creditSystem: spec.creditSystem || 'us', recognizes: {} }; return this; },
      // sovereignty: an institution explicitly chooses whom to recognise
      recognize: function (byInst, ofInst) { if (insts[byInst]) insts[byInst].recognizes[ofInst] = true; rec('recognize', { by: byInst, of: ofInst }); return this; },

      issueCredential: function (issuer, learner, spec) { var id = 'cred_' + (++seq); credentials[id] = { id: id, issuer: issuer, learner: learner, type: spec.type || 'course', credits: spec.credits || 0, grade: spec.grade != null ? spec.grade : null }; rec('issue', { id: id, issuer: issuer }); return credentials[id]; },

      // is a credential recognised by an institution? (agreement OR shared accreditation)
      recognizedBy: function (credId, byInst) {
        var c = credentials[credId], b = insts[byInst], a = c && insts[c.issuer]; if (!c || !b || !a) return { recognized: false, reason: 'unknown institution/credential' };
        if (c.issuer === byInst) return { recognized: true, reason: 'own credential' };
        if (b.recognizes[c.issuer]) return { recognized: true, reason: 'recognition agreement' };
        if (a.accreditation && a.accreditation === b.accreditation) return { recognized: true, reason: 'shared accreditation body "' + a.accreditation + '"' };
        return { recognized: false, reason: 'institution "' + byInst + '" does not recognise "' + c.issuer + '" (sovereign choice)' };
      },

      // convert a credential's grade + credits into a target institution's systems
      equivalence: function (credId, toInst) {
        var c = credentials[credId], from = insts[c.issuer], to = insts[toInst]; if (!c || !from || !to) return null;
        var q = c.grade != null ? GRADE[from.gradeSystem].toQuality(c.grade) : null;
        var grade = q != null ? GRADE[to.gradeSystem].fromQuality(q) : null;
        var credits = +(c.credits * CREDIT[from.creditSystem] / CREDIT[to.creditSystem]).toFixed(2);
        return { fromGrade: c.grade, fromSystem: from.gradeSystem, toGrade: grade, toSystem: to.gradeSystem, fromCredits: c.credits + ' ' + from.creditSystem, toCredits: credits + ' ' + to.creditSystem };
      },

      // learner mobility A -> B: transfer only recognised credentials, converted
      mobility: function (learner, toInst) {
        var mine = Object.keys(credentials).map(function (k) { return credentials[k]; }).filter(function (c) { return c.learner === learner; });
        var transferred = [], rejected = [];
        mine.forEach(function (c) { var r = N.recognizedBy(c.id, toInst); if (r.recognized) transferred.push({ credential: c.id, from: c.issuer, converted: N.equivalence(c.id, toInst), via: r.reason }); else rejected.push({ credential: c.id, from: c.issuer, reason: r.reason }); });
        rec('mobility', { learner: learner, to: toInst, transferred: transferred.length });
        return { learner: learner, to: toInst, transferred: transferred, notRecognized: rejected };
      }
    };
    return N;
  }
  window.AquinPlanetaryEdu = { createNetwork: createNetwork, GRADE: GRADE, CREDIT: CREDIT };
})();
