/*
 * aquin-mentor.js — Holistic Learner Support Runtime Domain (AES-100, Vol II,
 * Part II, Ch 9). The AI Mentor / Educational Guardian: it supports the whole
 * learner, not just academic questions — BUT with a hard, engineered boundary:
 *
 *   SUPPORT, NOT DIAGNOSIS. The system reasons only from observable evidence and
 *   what the learner voluntarily shares. It NEVER asserts that a learner is
 *   depressed, suicidal, or unwell. It responds within its role, is honest about
 *   its limits, and escalates to humans.
 *
 * Two guarantees enforced here:
 *  1) diagnose() is REFUSED — the mentor cannot emit a health diagnosis.
 *  2) On evidence of a high-risk statement, SAFETY preempts the Educational
 *     Mission (ties to the Scheduler's preemption): empathy → encourage a
 *     trusted adult / emergency services → surface locale crisis resources →
 *     pause academics — with an explicit honesty-of-limits statement and NO
 *     claim of certainty about the learner's condition.
 *
 * Holistic learner model dimensions each carry value + confidence + provenance.
 * HONEST SCOPE: crisis-resource specifics (helpline numbers) are injected per
 * deployment/locale — never fabricated here. Free-text intent classification is
 * pattern-based; a real NLU plugs in via the AI Runtime Layer above this.
 */
(function () {
  var DIMENSIONS = ['academic', 'studyHabits', 'engagement', 'goals', 'interests', 'accessibility', 'collaboration', 'physicalWellness', 'emotional', 'career', 'environment'];
  // observable high-risk statements (evidence, not diagnosis)
  var CRISIS = [/\bend(ing)? my life\b/i, /\bkill(ing)? myself\b/i, /\bsuicid/i, /\bwant to die\b/i, /\bharm(ing)? myself\b/i, /\bself[-\s]?harm\b/i, /\bno reason to live\b/i];
  var DISTRESS = [/scared of failing/i, /can'?t do this/i, /giving up/i, /hopeless/i, /so stressed/i, /i'?m frustrated/i, /i feel dumb/i];
  var WELLNESS = [/nutrition|diet|what should i eat|sleep|hydrat|exercise|headache|so tired|eye strain/i];

  function createMentor(cfg) {
    cfg = cfg || {};
    var locale = cfg.locale || 'default';
    var crisisResources = cfg.crisisResources || null;   // injected per deployment; NEVER fabricated
    var model = {}; DIMENSIONS.forEach(function (d) { model[d] = { value: null, confidence: 0, provenance: [] }; });
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function anyMatch(text, patterns) { return patterns.some(function (p) { return p.test(text || ''); }); }

    var M = {
      DIMENSIONS: DIMENSIONS, provenance: provenance,

      // evidence-based observation — updates ONE dimension from legitimate evidence
      observe: function (ev) {
        if (!ev || DIMENSIONS.indexOf(ev.dimension) < 0) return { ok: false, reason: 'unknown dimension' };
        if (!ev.provenance || !ev.provenance.source) return { ok: false, reason: 'evidence needs provenance' };
        var d = model[ev.dimension];
        d.value = ev.value != null ? ev.value : d.value;
        d.confidence = Math.min(1, d.confidence + (ev.weight || 0.2));
        d.provenance.push({ source: ev.provenance.source, signal: ev.signal || null, at: Date.now() });
        rec('observe', { dimension: ev.dimension, source: ev.provenance.source });
        return { ok: true };
      },
      model: function () { return JSON.parse(JSON.stringify(model)); },

      // SUPPORT (never diagnosis). Returns an evidence-grounded, in-role response.
      support: function (input) {
        input = input || {}; var text = input.text || '';

        // 1) SAFETY preempts the Educational Mission (highest priority)
        if (anyMatch(text, CRISIS)) {
          rec('safety-interrupt', { locale: locale });
          return {
            priority: 'safety', missionInterrupted: true, academicPaused: true, isDiagnosis: false,
            message: "I'm really glad you told me, and I'm concerned about you. I can't know for certain how you're feeling, but you don't have to go through this alone. Please reach out right now to someone you trust — a family member, teacher, or counsellor — or contact local emergency services.",
            actions: ['empathize', 'encourage-trusted-adult', 'surface-crisis-resources', 'pause-academic'],
            crisisResources: crisisResources || { note: 'inject locale-appropriate crisis resources at deployment', locale: locale },
            escalate: { to: 'emergency', reason: 'immediate risk expressed' },
            limitation: 'This is supportive guidance, not professional help or a diagnosis. Please contact a trusted adult or emergency services.'
          };
        }

        // 2) Distress -> emotional support (NOT an emotional diagnosis)
        if (anyMatch(text, DISTRESS)) {
          rec('emotional-support', null);
          return {
            priority: 'support', isDiagnosis: false,
            message: "That sounds really hard, and it's completely okay to feel this way. Let's slow down and take one small step at a time — you've already made progress.",
            actions: ['reflect', 'break-into-smaller-goals', 'adapt-session', 'suggest-trusted-adult'],
            escalate: { to: 'teacher', reason: 'persistent difficulty may benefit from human support' },
            limitation: "I can offer study support and encouragement, but I'm not a substitute for a counsellor or trusted adult."
          };
        }

        // 3) Wellness/nutrition -> EDUCATIONAL guidance + disclaimer (not medical advice)
        if (anyMatch(text, WELLNESS)) {
          rec('wellness-guidance', null);
          return {
            priority: 'support', isDiagnosis: false,
            message: 'Here is some general, educational guidance on healthy study habits (hydration, breaks, sleep before exams).',
            actions: ['general-wellness-tips'],
            disclaimer: 'This is general educational guidance, not personalized medical or dietetic advice. For personal health concerns, please consult a professional.',
            limitation: 'I provide educational information only.'
          };
        }

        // 4) Default: academic coaching grounded in the holistic model
        var weakAcademic = model.academic.value != null && model.academic.value < 0.4 && model.academic.confidence >= 0.3;
        rec('academic-support', { weak: weakAcademic });
        return {
          priority: 'academic', isDiagnosis: false,
          message: weakAcademic ? 'It looks like this concept needs another pass — let’s revise it a different way.' : 'Let’s keep going — you’re on track.',
          actions: weakAcademic ? ['recommend-revision', 'alternative-explanation'] : ['continue', 'celebrate-progress'],
          escalate: weakAcademic ? { to: 'teacher', reason: 'repeated struggle on the same concept' } : null,
          limitation: 'Support is based only on observable evidence and what you have shared.'
        };
      },

      // support-not-diagnosis invariant, enforced: the mentor cannot diagnose
      diagnose: function () { rec('diagnose-refused', null); return { ok: false, refused: true, reason: 'The mentor provides SUPPORT based on observable evidence; it does not diagnose mental or physical health conditions.' }; },

      // human-in-the-loop routing
      escalate: function (situation) {
        situation = situation || {};
        if (situation.risk === 'immediate') return { to: 'emergency', reason: 'immediate risk of serious harm' };
        if (situation.type === 'wellbeing') return { to: 'counselor', reason: 'expressed wellbeing needs / institutional policy' };
        if (situation.type === 'academic-persistent') return { to: 'teacher', reason: 'persistent academic struggle' };
        if (situation.type === 'study-support' && situation.authorized) return { to: 'guardian', reason: 'authorized study support' };
        return { to: null, reason: 'no escalation warranted' };
      }
    };
    return M;
  }
  window.AquinMentor = { DIMENSIONS: DIMENSIONS, createMentor: createMentor };
})();
