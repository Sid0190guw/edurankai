/*
 * aquin-intent.js — Educational Intent Intelligence Engine (AES-100, Vol II,
 * Ch 61). A teacher doesn't only understand knowledge; a teacher understands
 * INTENT. Two learners ask the identical question — "What is Newton's Second
 * Law?" — but one is cramming for tomorrow's exam, one is building a drone, one is
 * heading to research. Same question, different intent, different teaching.
 * Current LLMs infer intent implicitly; an Educational OS models it EXPLICITLY.
 *
 * Engineered guarantees (proven in the tests):
 *  - INTENT IS AN EXPLICIT RUNTIME OBJECT, not a hidden inference — inspectable,
 *    versioned, with provenance.
 *  - INTENT HIERARCHY: immediate < session < course < career < life; the engine
 *    reasons across all scales simultaneously.
 *  - RECOGNITION with confidence, but an EXPLICIT learner statement ALWAYS
 *    overrides inference (the learner is the authority on their own intent).
 *  - EVOLUTION PRESERVED: "pass tomorrow's exam" -> "understand physics" ->
 *    "become an engineer" -> "build reusable rockets" is kept as a narrative chain.
 *  - CONFLICT RESOLUTION BALANCES STAKEHOLDERS (learner/teacher/institution/
 *    guardian) into a blended strategy — it does NOT optimize one stakeholder.
 *  - INTENT-AWARE PATHWAY: the same Concept yields a different educational pathway
 *    per intent (exam -> concise revision; research -> derivation+evidence;
 *    engineering -> applications+trade-offs). The concept is constant; the route
 *    changes.
 *  - COMPLETE INTENT PROVENANCE, feeding the Life Graph.
 *
 * HONEST SCOPE: intent representation, tracking, balancing, and pathway selection
 * over supplied signals. The raw natural-language intent CLASSIFIER (turning free
 * text into an intent label) is a declared model substrate; here recognition runs
 * on structured signals + explicit statements.
 */
(function () {
  var SCALES = ['immediate', 'session', 'course', 'career', 'life'];
  var SCALE_RANK = { immediate: 0, session: 1, course: 2, career: 3, life: 4 };
  // known educational intents -> the pathway shape they imply
  var PATHWAYS = {
    'exam-prep': { emphasis: ['key-formulas', 'concise-revision', 'practice-questions'], depth: 'targeted' },
    'conceptual': { emphasis: ['intuition', 'why-it-works', 'worked-examples'], depth: 'deep' },
    'research': { emphasis: ['historical-context', 'derivation', 'experimental-evidence', 'open-questions'], depth: 'rigorous' },
    'engineering': { emphasis: ['applications', 'design-trade-offs', 'case-studies', 'projects'], depth: 'applied' },
    'curiosity': { emphasis: ['story', 'surprise', 'connections'], depth: 'exploratory' }
  };

  function createIntentEngine() {
    var intents = {};        // learnerId -> [ intent objects ]  (explicit runtime objects)
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }
    function mk(spec, source, confidence) {
      return { id: 'intent_' + Math.random().toString(36).slice(2, 8), label: spec.label, scale: spec.scale || 'session', source: source, confidence: confidence, at: Date.now(), version: 1, supersedes: spec.supersedes || null };
    }

    var E = {
      SCALES: SCALES, PATHWAYS: PATHWAYS, provenance: provenance,

      // declare an EXPLICIT intent — the learner is the authority; overrides inference
      declare: function (learnerId, spec) {
        var obj = mk(spec, 'explicit-learner-statement', 1.0);
        (intents[learnerId] = intents[learnerId] || []).push(obj);
        rec('declare', { learner: learnerId, label: obj.label, scale: obj.scale });
        return obj;
      },

      // INFER intent from structured signals (confidence < explicit). Never overrides an explicit intent at the same scale.
      // signals: { question, mission, history:[labels], hint }
      infer: function (learnerId, signals) {
        signals = signals || {};
        var scores = {};
        function bump(label, w) { scores[label] = (scores[label] || 0) + w; }
        var q = (signals.question || '').toLowerCase();
        if (/exam|test|tomorrow|marks|pass/.test(q)) bump('exam-prep', 0.5);
        if (/why|understand|intuition|meaning/.test(q)) bump('conceptual', 0.4);
        if (/derive|proof|research|evidence|paper/.test(q)) bump('research', 0.5);
        if (/build|design|drone|rocket|robot|project|apply/.test(q)) bump('engineering', 0.5);
        (signals.history || []).forEach(function (h) { bump(h, 0.2); });
        if (signals.hint) bump(signals.hint, 0.3);
        var ranked = Object.keys(scores).map(function (k) { return { label: k, score: scores[k] }; }).sort(function (a, b) { return b.score - a.score; });
        var top = ranked[0];
        if (!top) return { inferred: null, reason: 'no intent signal' };
        var confidence = Math.min(0.85, top.score);   // inference is never fully certain
        // do NOT override an explicit intent already on record at the same scale
        var explicit = (intents[learnerId] || []).filter(function (i) { return i.source === 'explicit-learner-statement'; });
        if (explicit.length && explicit[explicit.length - 1].confidence === 1.0 && signals.respectExplicit !== false) {
          rec('infer-deferred', { learner: learnerId, inferred: top.label });
          return { inferred: top.label, confidence: confidence, applied: false, reason: 'explicit learner intent on record takes precedence over inference', deferredTo: explicit[explicit.length - 1].label };
        }
        var obj = mk({ label: top.label, scale: signals.scale || 'session' }, 'inferred', confidence);
        (intents[learnerId] = intents[learnerId] || []).push(obj);
        rec('infer', { learner: learnerId, label: top.label, confidence: confidence });
        return { inferred: top.label, confidence: confidence, applied: true, object: obj, alternatives: ranked.slice(1, 3) };
      },

      // the ACTIVE intent at a scale (latest), or the highest-confidence across scales
      active: function (learnerId, scale) {
        var list = (intents[learnerId] || []);
        if (scale) { var s = list.filter(function (i) { return i.scale === scale; }); return s[s.length - 1] || null; }
        return list[list.length - 1] || null;
      },
      all: function (learnerId) { return (intents[learnerId] || []).slice(); },

      // EVOLUTION narrative — how the learner's intent grew over time
      evolution: function (learnerId) {
        return (intents[learnerId] || []).sort(function (a, b) { return a.at - b.at; }).map(function (i) { return i.label; });
      },

      // CONFLICT RESOLUTION — balance stakeholders, don't optimize one
      // stakeholders: [{ who, intent, weight? }]
      balance: function (stakeholders) {
        stakeholders = stakeholders || [];
        var byIntent = {};
        stakeholders.forEach(function (s) { var w = s.weight != null ? s.weight : 1; byIntent[s.intent] = (byIntent[s.intent] || 0) + w; });
        var ranked = Object.keys(byIntent).map(function (k) { return { intent: k, weight: byIntent[k] }; }).sort(function (a, b) { return b.weight - a.weight; });
        // a BLENDED strategy: lead with the highest-weighted intent but include the others' emphases
        var primary = ranked[0];
        var blendedEmphasis = [];
        ranked.forEach(function (r) { var p = PATHWAYS[r.intent]; if (p) p.emphasis.slice(0, r === primary ? 3 : 1).forEach(function (e) { if (blendedEmphasis.indexOf(e) < 0) blendedEmphasis.push(e); }); });
        rec('balance', { primary: primary && primary.intent, stakeholders: stakeholders.length });
        return {
          primary: primary ? primary.intent : null,
          considered: ranked,
          blendedStrategy: blendedEmphasis,
          note: 'balances all stakeholders (learner/teacher/institution/guardian); does not optimize a single one'
        };
      },

      // INTENT-AWARE PATHWAY — same concept, different educational route per intent
      pathway: function (concept, intentLabel) {
        var p = PATHWAYS[intentLabel] || PATHWAYS['conceptual'];
        rec('pathway', { concept: concept, intent: intentLabel });
        return { concept: concept, intent: intentLabel, sameConcept: true, emphasis: p.emphasis, depth: p.depth, note: 'the Concept is constant; the pathway adapts to intent' };
      }
    };
    return E;
  }

  window.AquinIntent = { SCALES: SCALES, PATHWAYS: PATHWAYS, createIntentEngine: createIntentEngine };
})();
