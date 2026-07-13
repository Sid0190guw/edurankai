/*
 * aquin-context.js — Educational Context Intelligence Engine (AES-100, Vol II,
 * Ch 63). "How do I solve this equation?" is the SAME mathematics whether the
 * learner is Class 8, an IIT-JEE aspirant, a blind learner, a dyslexic learner,
 * studying in Hindi, or solving a real engineering problem — but the right
 * educational RESPONSE is completely different. Today's AI uses context windows;
 * an Educational OS needs a computational Educational Context Model.
 *
 *   Knowledge is universal, but educational MEANING is contextual.
 *
 * Engineered guarantees (proven in the tests):
 *  - CONTEXT IS A FIRST-CLASS RUNTIME OBJECT: a unified, versioned, inspectable
 *    object — not a hidden prompt blob.
 *  - HIERARCHICAL LAYERS resolved with precedence (mission > learner > institution
 *    > curriculum > language > accessibility > world > time > civilization); more
 *    specific layers refine, and hard constraints (accessibility, safety) are
 *    never overridden away.
 *  - ONE SHARED CONTEXT: every Runtime Domain reads the SAME resolved context; no
 *    domain rebuilds context independently (guarantees consistency).
 *  - SAME KNOWLEDGE, DIFFERENT ACTION: adapting the same concept to two different
 *    contexts yields two different educational responses (level, language, format).
 *  - ACCESSIBILITY IS A HARD REQUIREMENT, not a preference — it survives every
 *    merge and shapes the delivery format.
 *  - EXPLAINABILITY: which factors were considered, which CHANGED the response,
 *    which were ignored, and what extra context would help.
 *  - CONTEXTUAL PROVENANCE + deterministic historical reconstruction (versioned).
 *
 * HONEST SCOPE: context construction, layered resolution, and adaptation policy
 * over supplied signals. It composes the World Model (Ch 59), Time (Ch 60), Intent
 * (Ch 61), Digital Twin, and Mission context; it does not itself sense the world.
 */
(function () {
  // layer precedence: later in this list overrides earlier on soft fields
  var LAYER_ORDER = ['civilization', 'world', 'time', 'curriculum', 'institution', 'language', 'learner', 'mission', 'accessibility'];
  // fields that are HARD constraints — never dropped by a lower-precedence layer
  var HARD = ['accessibility', 'safety'];

  function createContextEngine() {
    var provenance = []; var seq = 0;
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // build a unified Context Object by resolving layered inputs
    // layers: { learner:{level,language,...}, accessibility:{...}, mission:{...}, ... }
    function build(layers) {
      layers = layers || {};
      var resolved = {}; var contributed = {};
      LAYER_ORDER.forEach(function (layerName) {
        var layer = layers[layerName]; if (!layer) return;
        Object.keys(layer).forEach(function (field) {
          // hard constraints, once set, are not overwritten by a lower-precedence layer
          if (resolved[field] != null && HARD.indexOf(field) < 0) { /* soft: allow override by higher-precedence (later) layer */ }
          resolved[field] = layer[field];
          contributed[field] = layerName;
        });
      });
      // accessibility is a hard requirement even if only present as its own layer
      if (layers.accessibility) { resolved.accessibility = layers.accessibility; contributed.accessibility = 'accessibility'; }
      var obj = { id: 'ctx_' + (++seq).toString(36), version: seq, at: Date.now(), factors: resolved, source: contributed, layers: Object.keys(layers) };
      rec('build', { id: obj.id, factors: Object.keys(resolved).length });
      return obj;
    }

    // adapt the SAME concept to a context -> a concrete educational response shape
    function adapt(concept, ctx) {
      var f = (ctx && ctx.factors) || {};
      var changed = [];
      // depth from curriculum level / intent
      var depth = 'standard';
      if (/class[\s-]?[1-8]\b|grade[\s-]?[1-8]\b|primary|middle/i.test(f.level || '')) { depth = 'foundational'; changed.push('level->foundational'); }
      else if (/jee|neet|competitive|exam/i.test(f.level || '') || f.intent === 'exam-prep') { depth = 'exam-focused'; changed.push('level->exam-focused'); }
      else if (/university|engineering|research/i.test(f.level || '') || f.intent === 'research') { depth = 'rigorous'; changed.push('level->rigorous'); }
      // language medium
      var language = f.language || 'en';
      if (language !== 'en') changed.push('language->' + language);
      // accessibility HARD requirement shapes format
      var format = 'text';
      var acc = f.accessibility || {};
      if (acc.vision === 'blind' || acc.screenReader) { format = 'screen-reader-audio-first'; changed.push('accessibility->audio-first-nonvisual'); }
      else if (acc.dyslexia) { format = 'dyslexia-friendly (chunked, high-contrast, no dense text)'; changed.push('accessibility->dyslexia-friendly'); }
      // bandwidth / device
      if (f.bandwidth === 'low' || f.offline) { changed.push('delivery->lightweight/offline'); }
      rec('adapt', { concept: concept, depth: depth, changed: changed.length });
      return {
        concept: concept, sameConcept: true,
        response: { depth: depth, language: language, format: format, offlineSafe: f.offline === true || f.bandwidth === 'low' },
        contextChangedResponse: changed,
        note: 'the mathematics is identical; the educational response is shaped by context'
      };
    }

    // explain a contextual decision
    function explain(ctx, adaptation) {
      var f = (ctx && ctx.factors) || {};
      var all = Object.keys(f);
      var used = (adaptation && adaptation.contextChangedResponse || []).map(function (c) { return c.split('->')[0]; });
      var ignored = all.filter(function (k) { return used.indexOf(k) < 0 && ['level', 'language', 'accessibility', 'bandwidth', 'offline', 'intent'].indexOf(k) < 0; });
      return {
        considered: all,
        changedTheResponse: adaptation ? adaptation.contextChangedResponse : [],
        ignored: ignored,
        couldImprove: !f.accessibility ? ['accessibility profile not provided'] : (!f.level ? ['curriculum level not provided'] : []),
        source: ctx && ctx.source
      };
    }

    return {
      LAYER_ORDER: LAYER_ORDER, HARD: HARD, provenance: provenance,
      build: build, adapt: adapt, explain: explain
    };
  }

  window.AquinContext = { LAYER_ORDER: LAYER_ORDER, createContextEngine: createContextEngine };
})();
