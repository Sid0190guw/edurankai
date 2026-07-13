# AES-100 · Vol II · Part VIII · Ch 41–42 — Trust, Privacy & Intervention Governance

**Status:** specified + reference implementation (`public/aquin-intervention.js`,
Node-tested, 7 cases). Covers Ch 42 (Intervention Decision) + Ch 41's graduated
consent / data-minimization core. Normative: SHALL/SHOULD/MAY.

## Ch 42 — Educational Trust & Intervention Decision Engine

**Principle:** the AI does not act because it is intelligent; it acts only when
the OS decides intervention is **justified, proportionate, authorized, and
beneficial**. Observation NEVER auto-produces action. Reasoning is separated from
authority.

### Five constitutional requirements (all SHALL hold, else delay/reduce/cancel)
- **INT-001 Educational Benefit** — no benefit ⇒ no intervention. *(test 1)*
- **INT-002 Sufficient Evidence** — aggregate confidence SHALL meet the level's
  threshold (`REQ_CONF`). *(test 2)*
- **INT-003 Appropriate Authority** — level-4 human notification is consent-gated;
  without consent it SHALL reduce to coaching. *(test 4)*
- **INT-004 Proportional Response** — the level SHALL be reduced to what the
  evidence supports. *(test 2)*
- **INT-005 Explainability** — every decision SHALL explain why / evidence /
  confidence / alternatives / authority / mission. *(test 7)*

### Graduated intervention levels
`0 observe · 1 gentle-suggestion · 2 adaptive-support · 3 coaching ·
4 human-collaboration (consent-gated) · 5 safety-escalation`. **Level 5 requires
explicit crisis evidence** (never inferred), pauses the mission, and routes to a
human/emergency. *(test 5)*

## Ch 41 — Trust, Privacy & Cybersecurity (core implemented here)
- **SEC-001 Educational Benefit + Data Minimization** — the platform uses only
  data the learner consented to *and* that the chosen capability needs;
  unconsented data is **withheld, never used**. *(test 6 — `mood` withheld, `sleep`
  used after consent)*
- **SEC-002 Learner Control** — granular `grantConsent`/`revokeConsent` (not
  all-or-nothing); graduated trust levels 1–5 unlock capabilities in exchange for
  a clear, documented educational benefit.
- **SEC-003 Auditability** — every consent change + decision is recorded. *(test 7)*
- **SEC-004** Zero-trust transport, encryption-at-rest, secure AI-runtime
  isolation, threat detection, and incident response (Ch 41 §3–11) are the
  security **substrate** — deployment concerns declared here, enforced at the
  infrastructure layer (not faked in this engine).

## Public interface
```
InterventionEngine: grantConsent(p) · revokeConsent(p) · consented(p)
  decide({ evidence:[{signal,type?,confidence}], proposedLevel, benefit,
           requiresData?, notifyPermission?, mission? }) -> Decision
Decision: { intervene, level, action, why, confidence, alternatives, authority,
            dataUsed, dataWithheld, escalate, requirementsFailed, explainable }
```

## Reference implementation
`public/aquin-intervention.js` — `window.AquinIntervention.createInterventionEngine()`.
Composes with the Mentor (Ch 9) for safety and the Scheduler (Ch 3) for
mission-preemption. Harness: `scratchpad/intervention_test.js` (7/7).
