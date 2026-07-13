/*
 * aquin-ethics.js — Educational Value & Ethics Intelligence Engine (AES-100,
 * Vol II, Ch 62). The DELIBERATIVE layer that sits ABOVE the Constitutional
 * Runtime. The Constitution (Ch 58) answers "is this action PERMITTED?"; this
 * engine answers "among the permitted actions, which one best serves the learner
 * and the educational mission?"
 *
 * It does NOT replace laws, institutional policy, or human judgement. It provides a
 * transparent, explainable computational framework for weighing educational
 * trade-offs when multiple permissible alternatives exist.
 *
 * Engineered guarantees (proven in the tests):
 *  - PERMITTED-ONLY: it deliberates ONLY over constitutionally-permitted actions;
 *    a non-permitted option is never recommended, whatever its value score.
 *  - MULTI-VALUE, NO DOMINANT VALUE: options are scored across many educational
 *    values (learning quality, equity, dignity, autonomy, long-term growth, …);
 *    no single value dominates every situation.
 *  - LONG-TERM OVER SHORT-TERM: an option that raises short-term engagement but
 *    lowers long-term learning loses to one that builds durable understanding
 *    (consistent with the Impact engine, Ch 49: usage != learning).
 *  - DIGNITY IS A HARD CONSTRAINT: an option involving humiliating feedback,
 *    unnecessary comparison, or manipulative motivation is REJECTED, not merely
 *    down-weighted.
 *  - FAIRNESS != IDENTICAL TREATMENT: appropriate opportunity per need is scored
 *    as MORE fair than uniform treatment that ignores need.
 *  - HUMAN OVERSIGHT: high-stakes decisions, near-ties, and unresolved value
 *    conflicts are ESCALATED to human review — the engine assists, never replaces.
 *  - FULL EXPLAINABILITY + ETHICAL PROVENANCE: every recommendation states which
 *    values, which stakeholders, the trade-offs, why this option, and the
 *    alternatives.
 *
 * HONEST SCOPE: transparent value scoring + deliberation over supplied,
 * already-permitted options. It never authorizes a forbidden action; the
 * Constitution remains the gate above it.
 */
(function () {
  var DEFAULT_VALUES = ['learningQuality', 'scientificIntegrity', 'equity', 'dignity', 'autonomy', 'longTermGrowth', 'safety', 'transparency'];
  var DIGNITY_FLAGS = ['humiliating', 'public-comparison', 'manipulative', 'discriminatory', 'shaming'];

  function createEthicsEngine(cfg) {
    cfg = cfg || {};
    var weights = Object.assign({ learningQuality: 1, scientificIntegrity: 1, equity: 1, dignity: 1, autonomy: 0.8, longTermGrowth: 1.2, safety: 1, transparency: 0.7 }, cfg.weights || {});
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // score one option across educational values. option.values: { valueName: 0..1 }
    function scoreOption(option) {
      var v = option.values || {};
      var dignityViolation = (option.flags || []).some(function (f) { return DIGNITY_FLAGS.indexOf(f) >= 0; });
      // long-term vs short-term: reward durable learning, discount pure engagement
      var longTerm = v.longTermGrowth != null ? v.longTermGrowth : 0.5;
      var shortTermEngagement = option.shortTermEngagement != null ? option.shortTermEngagement : null;
      var total = 0, considered = [];
      DEFAULT_VALUES.forEach(function (name) {
        if (v[name] != null) { total += v[name] * (weights[name] || 1); considered.push(name); }
      });
      // if it trades long-term learning for engagement, penalize explicitly
      var tradeoffNote = null;
      if (shortTermEngagement != null && shortTermEngagement > longTerm + 0.2) { total -= 0.5; tradeoffNote = 'raises short-term engagement above long-term learning (usage != learning)'; }
      return { option: option.id, rawScore: +total.toFixed(3), consideredValues: considered, dignityViolation: dignityViolation, tradeoffNote: tradeoffNote };
    }

    // fairness evaluation: appropriate-to-need beats uniform-ignoring-need
    function fairness(option) {
      if (option.appropriateToNeed === true) return { fair: true, note: 'provides opportunity appropriate to learner need (fairness != identical treatment)' };
      if (option.uniformIgnoringNeed === true) return { fair: false, note: 'identical treatment that ignores differing needs is not fairness' };
      return { fair: true, note: 'no fairness concern flagged' };
    }

    var E = {
      VALUES: DEFAULT_VALUES, provenance: provenance,

      // deliberate among options. context.highStakes triggers human review.
      deliberate: function (options, context) {
        context = context || {};
        options = options || [];
        // PERMITTED-ONLY: never deliberate over a non-permitted action
        var permitted = options.filter(function (o) { return o.permitted !== false; });
        var excluded = options.filter(function (o) { return o.permitted === false; }).map(function (o) { return o.id; });

        var scored = permitted.map(function (o) {
          var s = scoreOption(o);
          var f = fairness(o);
          // dignity is a HARD constraint — rejected, not down-weighted
          var eligible = !s.dignityViolation;
          if (!f.fair) s.rawScore -= 0.4;    // unfair-to-need is a strong penalty
          return { id: o.id, score: s.rawScore, eligible: eligible, dignityViolation: s.dignityViolation, fairness: f, consideredValues: s.consideredValues, tradeoffNote: s.tradeoffNote, stakeholders: o.stakeholders || [] };
        });
        var eligible = scored.filter(function (s) { return s.eligible; }).sort(function (a, b) { return b.score - a.score; });
        var rejected = scored.filter(function (s) { return !s.eligible; });

        var top = eligible[0] || null;
        var runnerUp = eligible[1] || null;
        // escalate to human review: high-stakes, a near-tie, or everything rejected
        var nearTie = top && runnerUp && Math.abs(top.score - runnerUp.score) < 0.1;
        var needsHuman = !!context.highStakes || nearTie || eligible.length === 0;

        rec('deliberate', { options: options.length, permitted: permitted.length, recommend: top && top.id, needsHuman: needsHuman });
        return {
          recommendation: needsHuman ? null : (top && top.id),
          requiresHumanReview: needsHuman,
          humanReviewReason: needsHuman ? (context.highStakes ? 'high-stakes decision' : nearTie ? 'near-tie between options — deliberate human choice' : 'no ethically eligible option — human judgement required') : null,
          ranked: eligible,
          rejectedForDignity: rejected.filter(function (r) { return r.dignityViolation; }).map(function (r) { return r.id; }),
          excludedAsNotPermitted: excluded,
          explanation: {
            valuesConsidered: DEFAULT_VALUES,
            chosen: top && top.id,
            why: top ? ('highest value-weighted score (' + top.score + ') among permitted, dignity-respecting options' + (top.tradeoffNote ? '; note: ' + top.tradeoffNote : '')) : 'no eligible option',
            alternatives: eligible.slice(1).map(function (r) { return { id: r.id, score: r.score }; }),
            stakeholdersAffected: top ? top.stakeholders : [],
            humanOversight: needsHuman ? (context.highStakes ? 'required (high-stakes)' : 'recommended') : 'not required for this routine decision'
          },
          disclaimer: 'assists human judgement; does not replace laws, institutional policy, or educators'
        };
      },
      scoreOption: scoreOption, fairness: fairness
    };
    return E;
  }

  window.AquinEthics = { VALUES: DEFAULT_VALUES, createEthicsEngine: createEthicsEngine };
})();
