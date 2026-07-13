/*
 * aquin-education.js — AES-000 Ch 1: "What is Education?" as CODE, and Ch 10:
 * "What is Educational Intelligence?" The two remaining definitional foundation
 * chapters, made executable: instead of prose that defines the terms, VALIDATORS
 * and MEASURES that decide whether a given process actually IS education, and how
 * much educational intelligence a system exhibits.
 *
 * Ch 1 — Education is the GOVERNED TRANSFORMATION of a learner's understanding via
 * VALID EVIDENCE toward a genuine objective, auditable back to that evidence. Four
 * necessary conditions (the master invariant, as a predicate):
 *   E1 transforms understanding (before != after, in the intended direction)
 *   E2 driven by validated evidence with provenance (not fiat / not fabricated)
 *   E3 auditable — every change traces to its evidence
 *   E4 serves a genuine educational objective (not engagement/manipulation)
 * A process failing any of these is content-delivery, gaming, or manipulation —
 * NOT education. This is the constitutional line, checkable in code.
 *
 * Ch 10 — Educational Intelligence is the capacity to achieve educational
 * objectives across VARIED contexts by composing the faculties (perceive, reason,
 * learn, adapt, decide, self-correct). Measured as a capability profile, not an IQ:
 * breadth (how many faculties), transfer (does it work across contexts), and
 * correction (does it improve from error).
 *
 * HONEST SCOPE: definitional predicates/measures over supplied process traces; they
 * formalize the boundary the whole architecture defends, and are consumed by
 * governance (is this activity legitimately educational?).
 */
(function () {
  var FACULTIES = ['perceive', 'reason', 'learn', 'adapt', 'decide', 'self-correct'];

  // Ch 1 — is this process education? trace = { understandingBefore, understandingAfter,
  //   evidence:[{provenance, validated}], objective, changesAuditable:bool, intent }
  function isEducation(trace) {
    trace = trace || {};
    var reasons = [], pass = true;
    // E1 transforms understanding in the intended direction
    var before = trace.understandingBefore != null ? trace.understandingBefore : null;
    var after = trace.understandingAfter != null ? trace.understandingAfter : null;
    if (before == null || after == null || after === before) { pass = false; reasons.push('E1 fail: no understanding transformation'); }
    // E2 driven by validated evidence with provenance
    var ev = trace.evidence || [];
    var validEvidence = ev.filter(function (e) { return e && e.validated && e.provenance && e.provenance.source; });
    if (!validEvidence.length) { pass = false; reasons.push('E2 fail: no validated, provenance-stamped evidence (change by fiat)'); }
    // E3 auditable
    if (!trace.changesAuditable) { pass = false; reasons.push('E3 fail: changes not auditable to evidence'); }
    // E4 serves a genuine educational objective, not engagement/manipulation
    if (!trace.objective || trace.intent === 'engagement' || trace.intent === 'manipulation') { pass = false; reasons.push('E4 fail: no genuine educational objective (engagement/manipulation is not education)'); }
    return {
      isEducation: pass,
      conditions: { E1_transforms: !(before == null || after == null || after === before), E2_evidence: validEvidence.length > 0, E3_auditable: !!trace.changesAuditable, E4_objective: !!trace.objective && trace.intent !== 'engagement' && trace.intent !== 'manipulation' },
      verdict: pass ? 'education' : (trace.intent === 'manipulation' ? 'manipulation (not education)' : trace.intent === 'engagement' ? 'engagement-farming (not education)' : 'content-delivery/incomplete (not education)'),
      reasons: reasons
    };
  }

  // Ch 10 — measure educational intelligence from a capability trace
  //   trace = { faculties:[names exercised], contexts:[distinct contexts succeeded in],
  //             recoveredFromError:bool }
  function intelligenceProfile(trace) {
    trace = trace || {};
    var used = (trace.faculties || []).filter(function (f) { return FACULTIES.indexOf(f) >= 0; });
    var breadth = used.length / FACULTIES.length;                     // how many faculties
    var contexts = (trace.contexts || []).length;
    var transfer = Math.min(1, contexts / (trace.expectedContexts || 3)); // works across contexts
    var correction = trace.recoveredFromError ? 1 : 0;                // improves from error
    var score = +(0.4 * breadth + 0.4 * transfer + 0.2 * correction).toFixed(3);
    return {
      faculties: used, breadth: +breadth.toFixed(3), transfer: +transfer.toFixed(3), correction: correction,
      intelligence: score,
      note: 'a capability profile (breadth x transfer x self-correction), not an IQ; intelligence is achieving objectives across VARIED contexts, not one clever trick'
    };
  }

  window.AquinEducation = { FACULTIES: FACULTIES, isEducation: isEducation, intelligenceProfile: intelligenceProfile };
})();
