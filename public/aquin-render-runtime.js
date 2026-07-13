/*
 * aquin-render-runtime.js — AES Part V: the Rendering Runtime. Knowledge (Ch 1) is
 * presentation-free by law; SOMETHING must decide how to present it. This runtime
 * chooses the representation — text / static-diagram / animation / interactive-
 * simulation / hands-on-lab — for a concept given the learner's CONTEXT (Ch 63),
 * grounded in Mayer's Cognitive Theory of Multimedia Learning, with accessibility
 * as a HARD constraint. No invented CS.
 *
 * Principles encoded:
 *   - MULTIMEDIA / spatial-contiguity (Mayer): concepts with spatial or DYNAMIC
 *     structure are better shown than told — prefer diagram/animation/simulation.
 *   - COHERENCE / cognitive-load: don't pick a high-load representation for a low
 *     bandwidth/device or an overloaded learner — degrade gracefully to lighter media.
 *   - ACCESSIBILITY FIRST (hard, never traded away): a blind / screen-reader learner
 *     NEVER gets a silent visual; they get a non-visual (structured text/audio)
 *     representation. Dyslexia → chunked + diagram-supported, low text density.
 *
 * It returns the chosen representation, an ordered fallback chain, and the reason —
 * so the choice is explainable. HONEST SCOPE: the SELECTION is real; the renderers
 * themselves (AquinAnimator, simulation engine, lab runtime) are the substrates it
 * selects among and hands a descriptor to.
 */
(function () {
  // representation catalogue with cognitive/technical properties
  var REPR = {
    'lab': { visual: true, interactivity: 1.0, load: 0.9, bandwidth: 0.6, needs: 'equipment' },
    'simulation': { visual: true, interactivity: 0.9, load: 0.7, bandwidth: 0.7 },
    'animation': { visual: true, interactivity: 0.3, load: 0.5, bandwidth: 0.6 },
    'diagram': { visual: true, interactivity: 0.1, load: 0.3, bandwidth: 0.2 },
    'text': { visual: false, interactivity: 0.0, load: 0.2, bandwidth: 0.05 },
    'audio-narration': { visual: false, interactivity: 0.0, load: 0.25, bandwidth: 0.3 },
    'structured-nonvisual': { visual: false, interactivity: 0.2, load: 0.3, bandwidth: 0.1 }
  };

  function createRenderRuntime(cfg) {
    cfg = cfg || {};
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // concept: { dynamic:bool, spatial:bool, hazardous:bool }
    // context: { accessibility:{vision,screenReader,dyslexia}, bandwidth:'low'|'high', device, cognitiveLoad:0..1 }
    function select(concept, context) {
      concept = concept || {}; context = context || {};
      var acc = context.accessibility || {};
      var reasons = [];

      // 1) ACCESSIBILITY FIRST — hard constraint, cannot be traded for richness
      if (acc.vision === 'blind' || acc.screenReader) {
        rec('select', { concept: concept.id, chosen: 'structured-nonvisual', reason: 'accessibility' });
        return { representation: 'structured-nonvisual', fallbacks: ['audio-narration', 'text'], hardConstraint: true, reason: 'non-visual learner — a visual (silent animation/diagram) is never acceptable; deliver structured non-visual + audio' };
      }

      // 2) candidate set by pedagogy: dynamic/spatial concepts want to be SHOWN
      var candidates;
      if (concept.hazardous && !context.physicalLabAvailable) candidates = ['simulation', 'animation', 'diagram']; // don't send them to a dangerous real lab
      else if (concept.dynamic) candidates = ['simulation', 'animation', 'diagram', 'text'];
      else if (concept.spatial) candidates = ['diagram', 'animation', 'text'];
      else candidates = ['text', 'diagram'];
      if (concept.hazardous && context.physicalLabAvailable) candidates = ['lab'].concat(candidates);
      if (concept.dynamic) reasons.push('dynamic concept → prefer showing (Mayer multimedia)');

      // 3) COGNITIVE LOAD + bandwidth/device: degrade gracefully to lighter media
      var maxLoad = 1 - (context.cognitiveLoad != null ? context.cognitiveLoad : 0) * 0.6;
      var maxBw = context.bandwidth === 'low' || context.offline ? 0.35 : 1;
      if (context.bandwidth === 'low' || context.offline) reasons.push('low bandwidth/offline → lighter media only');
      if (context.cognitiveLoad >= 0.6) reasons.push('high cognitive load → reduce interactivity');

      var ordered = candidates.filter(function (r) { return REPR[r]; });
      var viable = ordered.filter(function (r) { return REPR[r].load <= maxLoad && REPR[r].bandwidth <= maxBw; });
      var chosen = viable[0] || ordered[ordered.length - 1] || 'text';

      // dyslexia: keep visual support but chunk + low text density (annotate the choice)
      var adaptations = [];
      if (acc.dyslexia) { adaptations.push('chunked, low-text-density, diagram-supported'); if (chosen === 'text') { chosen = 'diagram'; reasons.push('dyslexia → diagram-supported over dense text'); } }

      rec('select', { concept: concept.id, chosen: chosen });
      return { representation: chosen, fallbacks: ordered.filter(function (r) { return r !== chosen; }), adaptations: adaptations, reason: reasons.join('; ') || 'default representation for this concept type', properties: REPR[chosen] };
    }

    return { REPR: REPR, provenance: provenance, select: select };
  }
  window.AquinRenderRuntime = { createRenderRuntime: createRenderRuntime };
})();
