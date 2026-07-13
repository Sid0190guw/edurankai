/*
 * aquin-mission.js — AquinTutor Educational Mission Runtime (AES-000, Ch 16;
 * also embodies Ch 11 Objective, Ch 14 Planning-core, Ch 15 Orchestration-core).
 *
 * A Mission is the highest executable unit of educational computation. It is a
 * governed execution context that drives the master invariant end-to-end over
 * the REAL engines already built:
 *     Concept graph (aquin-concept.js)  +  Learner Intelligence Core (aquin-understanding.js)
 *
 * Lifecycle phases:  init -> explore -> instruct -> evaluate -> adapt -> complete
 * It ingests Evidence (the Perception/Evidence boundary), evaluates Understanding,
 * plans the next Action via the learner's objective-gated Adaptation, spawns
 * nested Missions for unmet prerequisites or active misconceptions, tracks
 * Mission Health, and records complete provenance. Nothing mutates the learner
 * model except validated evidence flowing through ingest().
 *
 * HONEST SCOPE: this is the Mission *runtime core*. Distribution across devices,
 * cross-session persistence, XR, and institutional governance policy engines are
 * declared Mission participants in the spec but are not implemented here.
 */
(function () {
  var PHASES = ['init', 'explore', 'instruct', 'evaluate', 'adapt', 'complete'];

  function createMission(spec) {
    if (!spec || !spec.learner || !spec.knowledge) throw new Error('createMission needs {learner (LearnerModel), knowledge (ConceptGraph), objectives:[...]}');
    var minConf = spec.minConfidence != null ? spec.minConfidence : 0.4;
    var context = spec.context || 'default';
    var M = {
      id: spec.id || ('mission_' + Math.random().toString(36).slice(2, 9)),
      kind: spec.kind || 'instructional',
      objectives: (spec.objectives || []).map(function (o) { return { conceptId: o.conceptId, target: o.targetMastery != null ? o.targetMastery : 0.75, met: false }; }),
      learner: spec.learner, knowledge: spec.knowledge, context: context, parent: spec.parent || null,
      phase: 'init', children: [], provenance: [], done: false
    };
    function rec(event, detail) { M.provenance.push({ t: Date.now(), phase: M.phase, event: event, detail: detail || null }); }

    function maxMc(u) { var b = 0, id = null; Object.keys(u.misconceptions).forEach(function (k) { if (u.misconceptions[k].belief > b) { b = u.misconceptions[k].belief; id = k; } }); return { belief: b, id: id }; }
    function evalObjectives() {
      return M.objectives.map(function (o) {
        var u = M.learner.understanding(o.conceptId, context);
        var mc = maxMc(u);
        var met = u.overall.mastery >= o.target && u.overall.confidence >= minConf && mc.belief < 0.55;
        o.met = met;
        return { conceptId: o.conceptId, target: o.target, mastery: u.overall.mastery, confidence: u.overall.confidence, misconception: mc, met: met };
      });
    }
    function health() {
      var ev = evalObjectives(); if (!ev.length) return 100;
      var prog = 0, conf = 0, mcPen = 0;
      ev.forEach(function (e) { prog += Math.min(1, e.mastery / e.target); conf += e.confidence; mcPen = Math.max(mcPen, e.misconception.belief); });
      prog /= ev.length; conf /= ev.length;
      return Math.round(Math.max(0, Math.min(100, 100 * (0.6 * prog + 0.4 * conf) * (1 - 0.4 * mcPen))));
    }

    // the Perception/Evidence boundary: evidence enters the Mission here only.
    M.ingest = function (evidenceSpec) {
      var es = evidenceSpec || {}; if (es.context == null) es.context = context;
      var r = M.learner.observe(es);
      rec('evidence', { accepted: r.accepted, reasons: r.reasons, csts: (r.csts || []).map(function (c) { return c.kind; }) });
      return r;
    };

    M.spawn = function (subSpec) {
      var child = createMission({ id: M.id + '/' + (M.children.length + 1), kind: subSpec.kind || 'revision', objectives: subSpec.objectives, learner: M.learner, knowledge: M.knowledge, context: context, parent: M.id, minConfidence: minConf });
      M.children.push(child); rec('spawn', { child: child.id, kind: child.kind, objectives: subSpec.objectives });
      return child;
    };

    // advance one phase-cycle; returns a decision record
    M.step = function () {
      if (M.phase === 'complete') return { phase: 'complete', done: true, health: health() };
      var decision = null, ev;
      switch (M.phase) {
        case 'init':
          M.objectives.forEach(function (o) { if (!M.knowledge.get(o.conceptId)) throw { code: 'UNKNOWN_CONCEPT', message: 'Mission objective concept "' + o.conceptId + '" not in knowledge graph' }; });
          rec('init', { objectives: M.objectives.map(function (o) { return o.conceptId; }) }); M.phase = 'explore'; decision = 'assembled'; break;
        case 'explore':
          ev = evalObjectives();
          if (ev.every(function (e) { return e.confidence < minConf; })) { decision = 'assess'; rec('explore', { need: 'evidence', decision: decision }); }
          else { M.phase = 'instruct'; decision = 'explored'; rec('explore', { decision: decision }); }
          break;
        case 'instruct':
          ev = evalObjectives();
          var focus = ev.find(function (e) { return !e.met; });
          if (!focus) { M.phase = 'evaluate'; decision = 'all-addressed'; rec('instruct', { decision: decision }); break; }
          var plan = M.learner.adapt({ conceptId: focus.conceptId, targetMastery: focus.target, context: context });
          decision = plan.action;
          if (plan.action === 'reconstruct') {
            M.spawn({ kind: 'revision', objectives: [{ conceptId: focus.conceptId, targetMastery: focus.target }] });
          } else if (plan.action === 'revise-prerequisite') {
            var pre = M.knowledge.prerequisites(focus.conceptId).order;
            var weakest = null;
            pre.forEach(function (pid) { var pu = M.learner.understanding(pid, context); if (!weakest || pu.overall.mastery < weakest.m) weakest = { id: pid, m: pu.overall.mastery }; });
            if (weakest) M.spawn({ kind: 'prerequisite', objectives: [{ conceptId: weakest.id, targetMastery: 0.6 }] });
          }
          rec('instruct', { focus: focus.conceptId, action: plan.action, visualization: plan.visualization, rationale: plan.rationale });
          M.phase = 'evaluate';
          break;
        case 'evaluate':
          ev = evalObjectives();
          if (ev.every(function (e) { return e.met; })) { M.phase = 'complete'; M.done = true; decision = 'complete'; rec('evaluate', { decision: 'objectives-met' }); }
          else { M.phase = 'adapt'; decision = 'continue'; rec('evaluate', { decision: 'not-yet', unmet: ev.filter(function (e) { return !e.met; }).map(function (e) { return e.conceptId; }) }); }
          break;
        case 'adapt':
          M.phase = 'instruct'; decision = 'replanned'; rec('adapt', { decision: decision }); break;
      }
      return { phase: M.phase, decision: decision, health: health(), done: M.done };
    };

    // run the mission to completion (or a step cap), pulling evidence from a
    // provider each cycle — the provider stands in for the Perception runtime.
    M.run = function (maxSteps, evidenceProvider) {
      var trace = [];
      for (var i = 0; i < (maxSteps || 50) && !M.done; i++) {
        if (evidenceProvider) { var e = evidenceProvider(M, i); if (e) M.ingest(e); }
        trace.push(M.step());
      }
      return { done: M.done, steps: trace.length, health: health(), trace: trace };
    };

    M.status = function () {
      return { id: M.id, kind: M.kind, phase: M.phase, done: M.done, health: health(), objectives: evalObjectives(), children: M.children.map(function (c) { return c.id; }), provenanceEntries: M.provenance.length };
    };
    return M;
  }

  window.AquinMission = { PHASES: PHASES, createMission: createMission };
})();
