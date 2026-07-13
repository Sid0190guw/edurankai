/*
 * aquin-observation.js — AES Part IV: the Observation Engine — the FRONT of the
 * master invariant:
 *
 *   Observation → Educational Event (typed) → Educational Evidence (validated,
 *   provenance-stamped) → [Hypothesis update → Understanding → Adaptation]
 *
 * Its whole job is a constitutional guarantee the rest of the system depends on:
 * a RAW observation may never mutate a learner model. It must first be interpreted
 * into a TYPED educational event, then VALIDATED into evidence carrying provenance
 * and a quality score. Anything without provenance, or that looks fabricated, is
 * rejected here — at the boundary — so nothing downstream has to trust raw input.
 *
 * Two stages:
 *   1) classify(raw) -> a typed Educational Event (answer / hesitation / help-
 *      request / revisit / off-task / …) with interpreted attributes.
 *   2) toEvidence(event, context) -> validated Evidence {conceptId, targets,
 *      provenance, quality, obsConfidence} OR a rejection with a reason.
 *
 * HONEST SCOPE: interpretation + validation over supplied raw signals; the sensors
 * (clickstream, speech, camera) are declared substrates. The output Evidence is the
 * exact shape aquin-understanding.observe() consumes, so this is the real intake.
 */
(function () {
  // typed educational event vocabulary
  var EVENT_TYPES = ['answer', 'hesitation', 'help-request', 'revisit', 'off-task', 'self-explanation', 'time-on-task'];

  function createObservationEngine(cfg) {
    cfg = cfg || {};
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // 1) interpret a raw signal into a typed Educational Event
    function classify(raw) {
      raw = raw || {};
      var ev = { type: null, at: raw.at || Date.now(), attrs: {} };
      if (raw.kind === 'answer' || raw.correct != null) { ev.type = 'answer'; ev.attrs = { correct: !!raw.correct, latencyMs: raw.latencyMs || null, distractor: raw.distractor || null }; }
      else if (raw.kind === 'help' || raw.helpRequested) { ev.type = 'help-request'; ev.attrs = { topic: raw.topic || null }; }
      else if (raw.idleMs != null && raw.idleMs > (cfg.offTaskMs || 120000)) { ev.type = 'off-task'; ev.attrs = { idleMs: raw.idleMs }; }
      else if (raw.latencyMs != null && raw.latencyMs > (cfg.hesitationMs || 15000)) { ev.type = 'hesitation'; ev.attrs = { latencyMs: raw.latencyMs }; }
      else if (raw.kind === 'revisit') { ev.type = 'revisit'; ev.attrs = { conceptId: raw.conceptId }; }
      else if (raw.kind === 'explanation') { ev.type = 'self-explanation'; ev.attrs = { text: raw.text || '' }; }
      else ev.type = 'time-on-task', ev.attrs = { ms: raw.ms || 0 };
      ev.conceptId = raw.conceptId || null;
      ev.provenance = raw.provenance || null;         // where the signal came from
      rec('classify', { type: ev.type, concept: ev.conceptId });
      return ev;
    }

    // 2) validate a typed event into provenance-stamped Evidence (or reject it)
    function toEvidence(event, context) {
      context = context || {};
      if (!event || !event.type) return { ok: false, reason: 'not a typed event' };
      // CONSTITUTIONAL GATE: no evidence without provenance
      var prov = event.provenance || context.provenance;
      if (!prov || !prov.source) return { ok: false, reason: 'rejected: evidence requires provenance (source)' };
      if (!event.conceptId && !context.conceptId) return { ok: false, reason: 'rejected: evidence must attach to a concept' };
      // anti-fabrication: an "answer" with impossible latency, etc.
      if (event.type === 'answer' && event.attrs.latencyMs != null && event.attrs.latencyMs < 0) return { ok: false, reason: 'rejected: impossible latency (fabricated)' };

      // quality of the evidence (how much it should count)
      var quality = eventQuality(event);
      // only some event types carry a signed mastery signal; others are contextual
      var targets = null, misconceptionTargets = null;
      if (event.type === 'answer') {
        targets = event.attrs.correct ? { conceptual: 1, procedural: 1 } : { conceptual: -1 };
        if (!event.attrs.correct && event.attrs.distractor) misconceptionTargets = {}, misconceptionTargets[event.attrs.distractor] = 1;
      }
      var evidence = {
        conceptId: event.conceptId || context.conceptId,
        eventType: event.type,
        targets: targets, misconceptionTargets: misconceptionTargets,
        obsConfidence: quality.obsConfidence,
        quality: quality.dims,
        provenance: { source: prov.source, activity: prov.activity || null, at: event.at }
      };
      rec('to-evidence', { concept: evidence.conceptId, type: event.type, accepted: true });
      return { ok: true, evidence: evidence, carriesMasterySignal: targets != null };
    }

    function eventQuality(event) {
      // richer, independent, reproducible events count more (ties to Evidence-Centered Design)
      var base = { answer: 0.85, 'self-explanation': 0.7, hesitation: 0.4, 'help-request': 0.5, revisit: 0.4, 'off-task': 0.3, 'time-on-task': 0.3 }[event.type] || 0.4;
      return { obsConfidence: base, dims: { conceptualRichness: base, independence: 0.7, reproducibility: 0.7 } };
    }

    // convenience: raw -> event -> evidence in one call
    function intake(raw, context) { var ev = classify(raw); return toEvidence(ev, context); }

    return { EVENT_TYPES: EVENT_TYPES, provenance: provenance, classify: classify, toEvidence: toEvidence, intake: intake };
  }
  window.AquinObservation = { EVENT_TYPES: EVENT_TYPES, createObservationEngine: createObservationEngine };
})();
