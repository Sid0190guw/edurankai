# AES-100 · Vol II · Part VIII · Ch 45 — Future Prediction & Preventive Intelligence

**Status:** specified + reference implementation (`public/aquin-prediction.js`,
Node-tested, 7 cases). Normative: SHALL/SHOULD/MAY.

## Purpose
A good teacher anticipates. Estimate **plausible future educational trajectories**
from the learner's current state to enable early, preventive support — prevention
over reaction.

## Requirements (normative)
- **PRED-001** The engine SHALL produce **multiple** future scenarios (not one
  deterministic future), each with a probability and explicit assumptions. *(test 1)*
- **PRED-002** It SHALL NEVER claim certainty; output SHALL be marked `estimate`
  and probabilities SHALL sum to ~1. *(test 2)*
- **PRED-003** Prediction SHALL NOT modify Educational Reality: every projection
  runs on an **isolated clone** of the learner; the real learner is untouched.
  *(test 3)*
- **PRED-004** It SHALL identify **opportunities (strengths)** as actively as
  risks. *(test 6/7)*
- **PRED-005** It SHALL yield preventive recommendations and be fully explainable
  (what / why / evidence / assumptions / what-would-change). *(test 4/5)*
- **PRED-006** Predictions are hypotheses; other Runtime Domains (Intervention
  Ch 42, Mentor Ch 9) decide whether to act — the engine never acts itself.

## Interface
```
Predictor: predict(learner, conceptId, ctx?) -> {
  current, scenarios:[{id,label,assumption,projectedMastery,probability,outcome}],
  opportunities, risks, recommendations, certainty:'estimate', explain }
```

## Reference implementation
`public/aquin-prediction.js` — `window.AquinPrediction.createPredictor()`.
Composes the Learner Core (current state + isolated projection). Scenario
probabilities are heuristic (a real probabilistic/ML predictor plugs in behind
the same interface). Harness: `scratchpad/prediction_test.js` (7/7).

## Related chapters (queued)
- **Ch 46 Educational Life Graph** — causal lifelong narrative (typed causal
  edges: inspired/strengthened/corrected/…); a graph engine over the Concept +
  event history.
- **Ch 47 Collective Educational Intelligence** — population patterns, privacy-
  preserving; "one learner teaches the AI, millions improve education."
- **Ch 48 Educational Self-Evolution** — the system improves *implementation*
  (optimization/improvement) but SHALL NOT autonomously change *constitutional*
  principles (Truth/Governance/safety) — those require human governance;
  sandbox→verify→human-review→deploy→rollback. **This is the most important
  safety property of the self-improving platform.**
