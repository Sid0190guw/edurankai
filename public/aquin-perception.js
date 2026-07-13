/*
 * aquin-perception.js — Educational Multimodal Perception Engine (AES-001, Ch17).
 * The constitutional sensory system: it transforms raw signals into governed
 * Educational Observations — it does NOT interpret educational meaning (that is
 * cognition). Raw perception never directly influences Educational Reality:
 *
 *   signal -> Observation Normalization -> Observation Object (uncertainty +
 *   provenance) -> Cross-Modal Fusion -> (interpretation) -> Evidence -> Learner
 *
 * Domains: visual · auditory · textual · interactive · environmental · cognitive.
 * Properties proven in the tests: observations preserve confidence + alternative
 * interpretations (uncertainty never collapsed); privacy-bounded (unauthorized
 * private signals are dropped); cross-modal fusion of agreeing modalities raises
 * confidence with modality provenance retained; and the Observation -> Evidence
 * bridge feeds the Learner Core, closing the full perception->cognition loop.
 *
 * HONEST SCOPE: real vision/speech/OCR models are the pluggable sensors that
 * PRODUCE raw signals; this engine is the governed normalization + fusion +
 * evidence bridge on top — the constitutional part, testable without a model.
 */
(function () {
  var DOMAINS = ['visual', 'auditory', 'textual', 'interactive', 'environmental', 'cognitive'];
  var DSET = {}; DOMAINS.forEach(function (d) { DSET[d] = 1; });
  function freeze(o) { if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { freeze(o[k]); }); Object.freeze(o); } return o; }

  function createPerception(cfg) {
    cfg = cfg || {};
    var provenance = [];
    var seq = 0;
    function id() { seq++; return 'obs_' + seq.toString(36); }

    var P = {
      DOMAINS: DOMAINS, provenance: provenance,

      // Observation Normalization: raw signal -> governed Observation Object.
      // Privacy-aware: a private signal without consent is dropped, not observed.
      observe: function (signal, ctx) {
        ctx = ctx || {}; var oid = id();
        if (!DSET[signal.modality]) { provenance.push(freeze({ oid: oid, status: 'rejected', reason: 'unknown modality', modality: signal.modality })); return freeze({ dropped: true, reason: 'unknown modality "' + signal.modality + '"' }); }
        if (signal.private && !ctx.consent) { provenance.push(freeze({ oid: oid, status: 'dropped-privacy', modality: signal.modality })); return freeze({ dropped: true, reason: 'private signal without constitutional consent' }); }
        var obs = freeze({
          id: oid, modality: signal.modality,
          content: signal.raw,
          confidence: typeof signal.confidence === 'number' ? signal.confidence : 0.7,
          alternatives: signal.alternatives || [],            // uncertainty is preserved, never collapsed
          provenance: { sensor: signal.sensor || signal.modality, mission: ctx.mission || null, learner: signal.learner || null },
          time: signal.time || Date.now()
        });
        provenance.push(freeze({ oid: oid, status: 'observed', modality: signal.modality, confidence: obs.confidence }));
        return obs;
      },

      // Cross-Modal Fusion: integrate observations of one phenomenon; agreement
      // raises confidence, modality provenance is retained.
      fuse: function (observations, ctx) {
        var valid = observations.filter(function (o) { return o && !o.dropped; });
        if (!valid.length) return freeze({ dropped: true, reason: 'no valid observations' });
        var agree = valid.every(function (o) { return JSON.stringify(o.content) === JSON.stringify(valid[0].content); });
        // combine confidence: agreement -> boosted (noisy-OR-ish); disagreement -> lowered + alternatives surfaced
        var conf;
        if (agree) { conf = 1 - valid.reduce(function (p, o) { return p * (1 - o.confidence); }, 1); }
        else { conf = Math.min.apply(null, valid.map(function (o) { return o.confidence; })) * 0.6; }
        var fused = freeze({
          id: id(), modality: 'fused', content: valid[0].content, agree: agree,
          confidence: +conf.toFixed(3),
          modalities: valid.map(function (o) { return { modality: o.modality, confidence: o.confidence }; }),
          alternatives: agree ? [] : valid.map(function (o) { return o.content; }),
          provenance: { fusedFrom: valid.map(function (o) { return o.id; }), mission: (ctx && ctx.mission) || null }
        });
        provenance.push(freeze({ oid: fused.id, status: 'fused', agree: agree, confidence: fused.confidence, from: valid.length }));
        return fused;
      },

      // Observation -> Evidence bridge. Perception supplies the observation; the
      // caller supplies the educational MAPPING (interpretation stays outside
      // perception). Output is a valid Evidence spec for the Learner Core.
      toEvidence: function (observation, mapping) {
        if (!observation || observation.dropped) return null;
        return {
          conceptId: mapping.conceptId,
          context: mapping.context,
          provenance: { source: 'perception:' + observation.modality, activity: mapping.activity || 'observation', timestamp: observation.time },
          obsConfidence: observation.confidence,          // observation uncertainty -> evidence confidence
          quality: mapping.quality || { conceptualRichness: 0.6, independence: 0.6, reproducibility: 0.6 },
          targets: mapping.targets || {},
          misconceptionTargets: mapping.misconceptionTargets || {}
        };
      },

      // Temporal Observation Stream
      stream: function (signals, ctx) { var self = this; return signals.map(function (s) { return self.observe(s, ctx); }); }
    };
    return P;
  }
  window.AquinPerception = { DOMAINS: DOMAINS, createPerception: createPerception };
})();
