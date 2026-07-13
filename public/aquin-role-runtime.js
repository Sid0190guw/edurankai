/*
 * aquin-role-runtime.js — AES Part V: the Teacher Runtime and Student Runtime — the
 * top of the operating system, where humans meet the machine. Two persistent,
 * role-scoped runtime services with a hard boundary between them:
 *
 *   STUDENT RUNTIME — a learner's "process". Holds the active session (current
 *   concept, understanding, context, working set). Its ONE mutation path is
 *   submitEvidence(): a learner model changes ONLY through validated evidence, never
 *   by direct assignment. It exposes read state + the next recommended step.
 *
 *   TEACHER RUNTIME — a teacher's service. Sees a roster of students as READ-ONLY
 *   aggregate views (mastery %, flags), NOT raw internals. A teacher may INTERVENE,
 *   but an intervention is a governed proposal routed to the student runtime as
 *   evidence/among options — a teacher can never reach in and set a learner's
 *   mastery directly. This encodes the constitutional consequence: no subsystem (or
 *   person) mutates a learner model except through the evidence pipeline.
 *
 * HONEST SCOPE: the session + role boundary logic is real; the understanding update
 * delegates to an injected model (BKT/understanding). This proves the OS's human-
 * facing boundary, not a full multi-tenant server.
 */
(function () {
  // ---- Student Runtime ----
  function createStudentRuntime(cfg) {
    cfg = cfg || {};
    var learnerId = cfg.learnerId;
    var model = cfg.model;                 // injected BKT model (aquin-bkt) — the mastery source of truth
    var session = { activeConcept: null, context: null, workingSet: [] };
    var evidenceLog = [];
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    return {
      learnerId: learnerId, provenance: provenance,
      focus: function (conceptId, context) { session.activeConcept = conceptId; session.context = context || null; return session; },
      session: function () { return { activeConcept: session.activeConcept, context: session.context, workingSet: session.workingSet.slice() }; },

      // THE ONLY mutation path: validated evidence updates the learner model
      submitEvidence: function (evidence) {
        if (!evidence || !evidence.provenance || !evidence.provenance.source) return { ok: false, reason: 'evidence requires provenance' };
        if (!evidence.conceptId) return { ok: false, reason: 'evidence must target a concept' };
        evidenceLog.push(evidence);
        var mastery = null;
        if (model && typeof model.observe === 'function') mastery = model.observe(evidence.conceptId, { correct: evidence.correct, distractor: evidence.distractor });
        rec('evidence', { concept: evidence.conceptId, source: evidence.provenance.source });
        return { ok: true, mastery: mastery };
      },
      // direct mutation is IMPOSSIBLE — there is no setMastery(); reads only
      mastery: function (conceptId) { return model && model.mastery ? model.mastery(conceptId) : null; },
      recommendNext: function () { return model && model.recommendNext ? model.recommendNext() : null; },
      evidenceCount: function () { return evidenceLog.length; }
    };
  }

  // ---- Teacher Runtime ----
  function createTeacherRuntime(cfg) {
    cfg = cfg || {};
    var teacherId = cfg.teacherId;
    var students = {};                      // learnerId -> studentRuntime
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    return {
      teacherId: teacherId, provenance: provenance,
      enroll: function (studentRuntime) { students[studentRuntime.learnerId] = studentRuntime; return this; },
      roster: function () { return Object.keys(students); },

      // READ-ONLY aggregate view of a student (mastery %, not raw internals)
      view: function (learnerId, conceptIds) {
        var s = students[learnerId]; if (!s) return null;
        var summary = (conceptIds || []).map(function (c) { var m = s.mastery(c); return { concept: c, mastery: m ? m.pKnown : null, mastered: m ? m.mastered : null }; });
        return { learner: learnerId, concepts: summary, next: s.recommendNext() };
      },

      // INTERVENE — governed: routed to the student as EVIDENCE, never a direct write
      intervene: function (learnerId, conceptId, kind) {
        var s = students[learnerId]; if (!s) return { ok: false, reason: 'not on roster' };
        // a teacher intervention becomes provenance-stamped evidence, subject to the same gate
        var res = s.submitEvidence({ conceptId: conceptId, correct: kind === 'affirm-correct', provenance: { source: 'teacher:' + teacherId, activity: 'intervention:' + kind } });
        rec('intervene', { learner: learnerId, concept: conceptId, kind: kind, applied: res.ok });
        return res;
      },
      // there is deliberately NO setMastery(studentId, ...) — teachers cannot reach in
      canDirectlySetMastery: false
    };
  }

  window.AquinRoleRuntime = { createStudentRuntime: createStudentRuntime, createTeacherRuntime: createTeacherRuntime };
})();
