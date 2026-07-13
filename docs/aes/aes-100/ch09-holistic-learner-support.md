# AES-100 · Vol II · Part II · Chapter 9 — Holistic Learner Support Runtime Domain

**Status:** specified + reference implementation (`public/aquin-mentor.js`,
Node-tested, 8 cases). Normative: SHALL/SHOULD/MAY.

## 1. Philosophy
Model the learner as a whole person (academic, habits, engagement, wellbeing,
goals, environment) — but with a hard boundary: **SUPPORT, NOT DIAGNOSIS.** The
system reasons only from observable evidence and what the learner voluntarily
shares; it never claims to *know* a health/emotional state. (Consistent with the
platform's advisory-only, human-decides principle.)

## 2. Requirements (normative)
- **MENT-001** The mentor SHALL NOT emit a health/mental diagnosis; `diagnose()`
  SHALL be refused, and every support response SHALL carry `isDiagnosis:false`.
  *(test 4)*
- **MENT-002** On observable evidence of a high-risk statement, **safety SHALL
  preempt the Educational Mission** (pause academics), respond with empathy,
  encourage a trusted adult / emergency services, surface **locale-injected**
  crisis resources, and state its limits — with NO claim of certainty. *(test 1)*
- **MENT-003** Distress statements SHALL yield in-role emotional *support*
  (reflect, smaller goals, adapt, suggest a trusted adult) + escalate to a
  teacher — not an emotional diagnosis. *(test 2)*
- **MENT-004** Wellness/nutrition topics SHALL be answered as **educational
  guidance** with a *not personalized medical/dietetic advice* disclaimer. *(test 3)*
- **MENT-005** Every learner-model observation SHALL carry provenance; evidence
  without a source SHALL be rejected (no fabricated inference). *(test 8)*
- **MENT-006** Academic support SHALL be grounded only in observed evidence
  (e.g., repeated-wrong → recommend revision + optional teacher escalation). *(test 5)*
- **MENT-007** Human-in-the-loop: escalate immediate-risk→emergency,
  wellbeing→counsellor, persistent-academic→teacher, authorized study-support→
  guardian. The AI augments human support; it does not replace it. *(test 6)*

## 3. Holistic learner model
11 dimensions (academic, studyHabits, engagement, goals, interests, accessibility,
collaboration, physicalWellness, emotional, career, environment), each with
`{ value, confidence, provenance[] }`; wellbeing dimensions are learner-shared.

## 4. Public interface
```
Mentor: observe(evidence) · support({text, learnerId}) -> role-appropriate response
        diagnose() -> refused · escalate(situation) · model() · provenance
```

## 5. Reference implementation
`public/aquin-mentor.js` — `window.AquinMentor.createMentor({locale, crisisResources})`.
Crisis-resource specifics are injected per deployment (never fabricated). Harness:
`scratchpad/mentor_test.js` (8/8). Safety-priority ties to the Scheduler (Ch 3)
preemption; support draws on the Learner Core evidence model.
