/*
 * aquin-semantic.js — AES-000 Part II: Semantic Information. Shannon information
 * (aquin-information.js) measures SURPRISE in bits, blind to meaning or truth. But
 * education is about MEANING and TRUTH: "faster flow means lower pressure" and
 * "faster flow means higher pressure" carry the same Shannon bits yet opposite
 * educational worth. This engine implements SEMANTIC information — grounded, not
 * invented:
 *
 *   - BAR-HILLEL & CARNAP (1952): the semantic CONTENT of a statement = the
 *     fraction of possible worlds it EXCLUDES. cont(s) = 1 − (models where s holds
 *     / all models). A tautology excludes nothing (content 0); a precise claim
 *     excludes a lot (high content).
 *   - The BAR-HILLEL–CARNAP PARADOX: a contradiction excludes ALL worlds, so it has
 *     MAXIMAL content — absurd for "information". FLORIDI (2004) fixes this: strongly
 *     semantic information must be TRUE. A false statement is MISINFORMATION (it
 *     wrongly excludes the actual world), not information.
 *
 * Educationally: a correct explanation narrows the space of possible understandings
 * TOWARD the truth (positive semantic information); a misconception narrows it AWAY
 * from the truth — it excludes the correct world, which is why misconceptions are
 * actively harmful, not merely "less" knowledge. HONEST SCOPE: finite possible-world
 * semantics with predicate statements; richer model theory sits behind the same
 * space/predicate interface.
 */
(function () {
  function createSemanticSpace(models, actualWorldId) {
    // models: [{ id, props:{...} }] ; actualWorldId: the id of the true world
    var all = models.slice();
    var actual = actualWorldId;
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }
    function holds(pred, m) { try { return !!pred(m.props, m); } catch (e) { return false; } }

    var S = {
      provenance: provenance,
      models: function () { return all.map(function (m) { return m.id; }); },

      // Bar-Hillel–Carnap content: fraction of worlds EXCLUDED by the statement
      content: function (pred) {
        var trueIn = all.filter(function (m) { return holds(pred, m); }).length;
        var content = all.length ? 1 - trueIn / all.length : 0;
        return { trueInModels: trueIn, totalModels: all.length, content: +content.toFixed(4), tautology: trueIn === all.length, contradiction: trueIn === 0 };
      },

      // Floridi truth gate: is this statement genuine semantic INFORMATION,
      // misinformation, or vacuous?
      classify: function (pred) {
        var c = this.content(pred);
        var actualModel = all.filter(function (m) { return m.id === actual; })[0];
        var trueInActual = actualModel ? holds(pred, actualModel) : null;
        var kind;
        if (c.contradiction) kind = 'contradiction (excludes all worlds — not information, Floridi)';
        else if (c.tautology) kind = 'tautology (vacuous — content 0)';
        else if (trueInActual === false) kind = 'MISINFORMATION (excludes the actual world)';
        else if (trueInActual === true) kind = 'semantic-information';
        else kind = 'contingent (truth in actual world unknown)';
        rec('classify', { kind: kind, content: c.content });
        return { kind: kind, content: c.content, trueInActualWorld: trueInActual, isInformation: kind === 'semantic-information' };
      },

      // learn a TRUE fact: narrow the space to worlds where it holds; return info gained
      assert: function (pred) {
        var cls = this.classify(pred);
        if (!cls.isInformation) { rec('assert-rejected', { kind: cls.kind }); return { accepted: false, reason: cls.kind, spaceSize: all.length }; }
        var before = all.length;
        all = all.filter(function (m) { return holds(pred, m); });
        var infoGainBits = before > 0 && all.length > 0 ? +(Math.log(before / all.length) / Math.LN2).toFixed(4) : 0;
        rec('assert', { before: before, after: all.length });
        return { accepted: true, spaceBefore: before, spaceAfter: all.length, semanticInfoGainBits: infoGainBits, excludedFraction: +(1 - all.length / before).toFixed(4) };
      },

      // evaluate a learner's belief: does it exclude the truth? (misconception detector)
      evaluateBelief: function (pred) {
        var actualModel = all.filter(function (m) { return m.id === actual; })[0];
        if (!actualModel) return { verdict: 'actual world not in space' };
        var keepsTruth = holds(pred, actualModel);
        return {
          verdict: keepsTruth ? 'consistent-with-truth' : 'MISCONCEPTION — belief excludes the correct world',
          harmful: !keepsTruth,
          note: keepsTruth ? 'belief still admits the truth' : 'this belief must be corrected: it rules out reality'
        };
      }
    };
    return S;
  }
  window.AquinSemantic = { createSemanticSpace: createSemanticSpace };
})();
