/*
 * aquin-render.js — Educational Rendering Engine (AES-001, Ch 18).
 * The UI does not render widgets — it renders Educational Reality. One
 * Educational Runtime Object projects into many media (math / diagram /
 * simulation / narration / tactile / text / xr) WITHOUT changing the underlying
 * reality. Which medium is chosen is Adaptive Representation, driven by the
 * learner, device, accessibility, language, and objective — not hard-coded.
 *
 *   Runtime Object -> Rendering Context -> adaptive medium select -> Semantic
 *   Rendering (from the object's own dimensions) -> Rendering Verification
 *   (Educational Truth preserved?) -> Educational Experience
 *
 * Proven in tests: the SAME Bernoulli concept renders as math for an engineering
 * learner, simulation for an experiment objective, narration/tactile for
 * accessibility, and text on a low-end device — all carrying the identical
 * Educational Truth; a medium that loses truth is rejected and falls back to a
 * truth-preserving one; the concept object is never mutated (rendering
 * independence). Ties directly to the 7-dimension Concept model.
 *
 * HONEST SCOPE: media are pluggable projectors — real HTML/Canvas/WebGL/XR/speech
 * back-ends implement them; the reference media project the concept's dimensions
 * so the constitutional layer (adaptive select + verification) is testable.
 */
(function () {
  function createRenderer(cfg) {
    cfg = cfg || {};
    var media = {}, provenance = [], seq = 0;
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }
    function truthOf(obj) { return obj && obj.dimensions && obj.dimensions.semantic ? obj.dimensions.semantic.definition : (obj && obj.truth) || null; }

    // default media: each projects a DIFFERENT dimension of the SAME reality,
    // and every experience carries `truth` so verification can confirm it.
    function reg(name, fn) { media[name] = fn; }
    reg('math', function (c) { return { kind: 'math', equations: (c.dimensions && c.dimensions.mathematical && c.dimensions.mathematical.equations) || null, truth: truthOf(c) }; });
    reg('simulation', function (c) { var d = c.dimensions && c.dimensions.visual && c.dimensions.visual.descriptors; return { kind: 'simulation', route: (d && d[0] && d[0].route) || null, truth: truthOf(c) }; });
    reg('diagram', function (c) { return { kind: 'diagram', descriptors: (c.dimensions && c.dimensions.visual && c.dimensions.visual.descriptors) || [], truth: truthOf(c) }; });
    reg('narration', function (c) { return { kind: 'narration', speech: truthOf(c), truth: truthOf(c) }; });
    reg('tactile', function (c) { return { kind: 'tactile', braille: truthOf(c), truth: truthOf(c) }; });
    reg('text', function (c) { return { kind: 'text', text: truthOf(c), truth: truthOf(c) }; });

    // Adaptive Representation: choose the medium from the Rendering Context.
    function adaptiveSelect(obj, ctx) {
      ctx = ctx || {};
      if (ctx.accessibility && ctx.accessibility.visuallyImpaired) return ctx.accessibility.tactile ? 'tactile' : 'narration';
      if (ctx.device && ctx.device.tier === 'low') return 'text';                 // no sim/xr on low-end
      if (ctx.learner && ctx.learner.level === 'engineering') return 'math';
      if (ctx.objective === 'experiment') return 'simulation';
      return 'diagram';
    }

    var R = {
      provenance: provenance, media: function () { return Object.keys(media); },
      registerMedium: function (name, fn) { media[name] = fn; return this; },
      adaptiveSelect: adaptiveSelect,

      render: function (obj, ctx) {
        ctx = ctx || {}; seq++;
        var medium = ctx.medium || adaptiveSelect(obj, ctx);
        var fn = media[medium] || media.text;
        var exp = fn(obj, ctx);
        // Rendering Verification: Educational Truth must be preserved. If a medium
        // drops the truth, reject it and fall back to a truth-preserving medium.
        var truth = truthOf(obj);
        var verified = !!(exp && exp.truth && exp.truth === truth);
        var degraded = false;
        if (!verified && truth) { exp = media.text(obj, ctx); medium = 'text'; degraded = true; verified = true; rec('render', { fallback: true, reason: 'truth-not-preserved' }); }
        var experience = { id: 'exp_' + seq.toString(36), conceptId: obj.id, medium: medium, content: exp, truth: truth };
        rec('render', { conceptId: obj.id, medium: medium, verified: verified, degraded: degraded });
        return { experience: experience, medium: medium, verified: verified, degraded: degraded };
      }
    };
    return R;
  }
  window.AquinRender = { createRenderer: createRenderer };
})();
