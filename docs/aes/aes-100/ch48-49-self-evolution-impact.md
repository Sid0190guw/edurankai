# AES-100 · Vol II · Part IX · Ch 48–49 — Self-Evolution + Impact Evaluation

**Status:** specified + reference implementation (`public/aquin-evolution.js`,
Node-tested, 7 cases). Normative: SHALL/SHOULD/MAY.

## Ch 48 — Educational Self-Evolution Engine
The platform improves its own implementation — under a hard authority boundary.

- **EVO-001** Changes SHALL be classified **optimization / improvement /
  constitutional**. A **constitutional** change (Truth, Governance, learner
  rights, safety, Educational Genome) is **out of this engine's authority** and
  SHALL be rejected — it requires explicit human governance. *(test 1)*
- **EVO-002** Only optimization/improvement proposals proceed. *(test 2)*
- **EVO-003** Every candidate SHALL be experimented in isolation, then evaluated
  (Ch 49) before it can be verified. *(test 3/4)*
- **EVO-004** Deployment SHALL require **human review** (AI proposes, humans
  approve); without approval it stays `awaiting-approval`. *(test 5/6)*
- **EVO-005** Deployment SHALL be progressive (research→developer→pilot→regional→
  global) with **rollback** always available. *(test 5/7)*
- **EVO-006** Full evolution provenance SHALL be recorded. *(test 7)*

## Ch 49 — Educational Impact Evaluation Engine
The decision criterion for EVO-003. **"Did this improve education?"** — the only
question. Educational outcomes dominate technical/usage metrics.

- **IMP-001** A change that **decreases concept mastery** SHALL be rejected —
  even if engagement rises ("usage ≠ learning"). *(test 4)*
- **IMP-002** A change that **increases misconception rate** SHALL be rejected.
- **IMP-003** A change that improves mastery SHALL be accepted; a change that
  preserves education and improves efficiency (latency) MAY be accepted. *(test 3)*
- **IMP-004** Impact is measured on educational-outcome dimensions
  (mastery / misconception / …), not clicks or session length.

## Interface
```
EvolutionEngine: propose(change) -> {category, status}
  experiment(id, {baseline, candidate}) -> impact evaluation
  deploy(id) -> human-review-gated progressive deploy · rollback(id) · status(id)
impact(baseline, candidate) -> { betterEducation, reason }
```

## Reference implementation
`public/aquin-evolution.js` — `window.AquinEvolution.createEvolutionEngine({approve})`.
Feeds/consumes the Research engine (Ch 50 / Vol I Ch 16 = `aquin-research.js`),
which already enforces verify-before-evolution + never-autonomously-declare-truth.
Harness: `scratchpad/evolution_test.js` (7/7).

## Ch 50 — Autonomous Educational Research (note)
The core research lifecycle (gap → hypothesis → experiment-via-simulation →
verify-before-evolution → integrate through the Consistency gate → meta-research)
is already implemented as `public/aquin-research.js` (Vol I Ch 16). Ch 50's deeper
concerns (literature intelligence, reproducibility profiles, cross-disciplinary
discovery, publication assistance) extend it behind the same interface; the
invariant — **assist discovery, never autonomously declare Educational Truth** —
already holds in code.
