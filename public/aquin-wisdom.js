/*
 * aquin-wisdom.js — AES-000 Ch 31: "What is Educational Wisdom?" as CODE. The
 * Part-I capstone. Knowledge is knowing WHAT; intelligence is knowing HOW; wisdom
 * is knowing WHETHER and WHEN — sound judgment about the APPLICATION of knowledge,
 * especially under uncertainty and stakes.
 *
 * Grounded in the Berlin Wisdom Paradigm (Baltes & Staudinger): wisdom = rich
 * knowledge + lifespan contextualism + value tolerance + RECOGNITION AND
 * MANAGEMENT OF UNCERTAINTY. Encoded as judgment principles, not vibes:
 *
 *   W1 PRECAUTION — never act boldly when the decision is uncertain, high-stakes,
 *      AND irreversible. Under those conditions wisdom WAITS or defers.
 *   W2 REVERSIBILITY BIAS — when uncertain, prefer the option you can undo.
 *   W3 TEMPORAL — long-term educational benefit outranks short-term gain; a
 *      short-term win that harms long-term learning is UNWISE (usage != learning).
 *   W4 COMPETENCE HUMILITY — outside the system's competence, defer to a human;
 *      wisdom knows the limits of its own knowledge.
 *   W5 VALUE ALIGNMENT — a decision that violates learner dignity/values is not
 *      "efficient", it is unwise; refuse and route to human/ethics.
 *
 * It composes Meta-Cognition (confidence/limits, Ch 56) and Value/Ethics (Ch 62):
 * meta-cognition says how sure we are, ethics says what's permissible, wisdom says
 * whether to act NOW, WAIT for more evidence, choose the reversible path, or DEFER
 * to human judgement. HONEST SCOPE: a transparent judgment function over supplied
 * decision attributes; it never claims certainty it doesn't have — that restraint
 * is the point.
 */
(function () {
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  function createWisdom(cfg) {
    cfg = cfg || {};
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // judge a decision. attrs:
    //  certainty 0..1 · reversibility 0..1 · stakes 0..1 · withinCompetence bool
    //  alignsValues bool · longTermBenefit -1..1 · shortTermBenefit -1..1
    function judge(d) {
      d = d || {};
      var certainty = clamp01(d.certainty != null ? d.certainty : 0.5);
      var reversibility = clamp01(d.reversibility != null ? d.reversibility : 0.5);
      var stakes = clamp01(d.stakes != null ? d.stakes : 0.5);
      var withinCompetence = d.withinCompetence !== false;
      var alignsValues = d.alignsValues !== false;
      var longTerm = d.longTermBenefit != null ? d.longTermBenefit : 0;
      var shortTerm = d.shortTermBenefit != null ? d.shortTermBenefit : 0;
      var fired = [];

      // W5 value alignment — a hard stop
      if (!alignsValues) { rec('judge', { rec: 'defer-to-human', why: 'W5' }); return verdict('refuse', ['W5 value-alignment'], 'the decision violates learner dignity/values — not an efficiency question; route to human/ethics'); }

      // W4 competence humility — a hard stop
      if (!withinCompetence) { rec('judge', { rec: 'defer-to-human', why: 'W4' }); return verdict('defer-to-human', ['W4 competence-humility'], 'outside the system’s competence — wisdom knows its limits and defers'); }

      // W1 precaution — uncertain + high stakes + irreversible => do NOT act boldly
      var risk = (1 - certainty) * stakes * (1 - reversibility);
      if (risk >= (cfg.precautionThreshold || 0.25)) {
        fired.push('W1 precaution (risk=' + risk.toFixed(2) + ')');
        // W2 reversibility bias: if a reversible alternative exists, take it; else wait/defer
        if (d.hasReversibleAlternative) { fired.push('W2 reversibility-bias'); rec('judge', { rec: 'choose-reversible' }); return verdict('choose-reversible', fired, 'uncertain + high-stakes + irreversible — take the option you can undo'); }
        var out = stakes >= 0.8 ? 'defer-to-human' : 'wait-gather-evidence';
        rec('judge', { rec: out }); return verdict(out, fired, 'uncertain, high-stakes, irreversible — ' + (out === 'defer-to-human' ? 'defer to human judgement' : 'wait and gather more evidence before acting'));
      }

      // W3 temporal — short-term gain that harms long-term is unwise
      if (shortTerm > 0.2 && longTerm < -0.05) { fired.push('W3 temporal (short-term harms long-term)'); rec('judge', { rec: 'refuse' }); return verdict('refuse', fired, 'a short-term gain that lowers long-term learning is unwise (usage != learning)'); }

      // otherwise: act, with the appropriate confidence
      if (certainty >= (cfg.confidentThreshold || 0.65) && (reversibility >= 0.5 || stakes < 0.5)) { fired.push('W2 reversible/low-stakes ok'); rec('judge', { rec: 'act' }); return verdict('act', fired.length ? fired : ['sufficient certainty, acceptable risk'], 'certain enough and risk acceptable — proceed, favouring long-term benefit'); }

      fired.push('moderate uncertainty');
      rec('judge', { rec: 'proceed-with-caution' });
      return verdict('proceed-with-caution', fired, 'proceed but monitor and keep the path reversible; re-evaluate as evidence arrives');
    }

    function verdict(recommendation, principles, reasoning) {
      return {
        recommendation: recommendation,   // act | proceed-with-caution | choose-reversible | wait-gather-evidence | defer-to-human | refuse
        principles: principles,
        reasoning: reasoning,
        acknowledgesUncertainty: true,    // Berlin paradigm: wisdom always owns its uncertainty
        humility: recommendation === 'defer-to-human' || recommendation === 'wait-gather-evidence'
      };
    }

    return { provenance: provenance, judge: judge };
  }

  window.AquinWisdom = { createWisdom: createWisdom };
})();
