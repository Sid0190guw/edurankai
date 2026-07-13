# AES-100 · Vol II · Part XV · Ch 61 — Educational Intent Intelligence Engine

**Status:** specified + reference implementation (`public/aquin-intent.js`,
Node-tested, 7 cases). The same question means different teaching depending on WHY
it is asked. LLMs infer intent implicitly; an Educational OS models it EXPLICITLY.

## Requirements (normative)
- **INTENT-001** Intent is an explicit, inspectable, versioned Runtime Object with
  provenance — not a hidden inference. *(test 6)*
- **INTENT-002** Intent hierarchy (immediate < session < course < career < life);
  the engine reasons across scales simultaneously.
- **INTENT-003** Recognition carries confidence, but an EXPLICIT learner statement
  ALWAYS overrides inference (the learner is the authority on their intent). *(test 3)*
- **INTENT-004** Evolution preserved as a narrative chain. *(test 4)*
- **INTENT-005** Conflict resolution BALANCES stakeholders into a blended strategy;
  it does not optimize a single stakeholder. *(test 5)*
- **INTENT-006** Intent-aware pathway: the same Concept yields a different pathway
  per intent (exam→concise revision; research→derivation+evidence; engineering→
  applications+trade-offs) — concept constant, route changes. *(tests 1,2)*
- **INTENT-007** Complete intent provenance, feeding the Life Graph (Ch 46). *(test 7)*

## Interface
```
IntentEngine: declare(learner,{label,scale}) · infer(learner,signals) · active(learner,scale)
  all(learner) · evolution(learner) · balance(stakeholders) · pathway(concept,intent)
```
Reference: `public/aquin-intent.js`. Harness: `intent_test.js` (7/7). HONEST SCOPE:
intent representation/tracking/balancing/pathway-selection over structured signals;
the raw natural-language intent classifier (free text → intent label) is a declared
model substrate. Consumed by the Tutor Agent (Ch 57), Mission Orchestrator, and Life
Graph.
