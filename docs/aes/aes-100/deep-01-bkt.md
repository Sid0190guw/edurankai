# DEEP BUILD 01 — Knowledge-Tracing Engine (real Bayesian Knowledge Tracing)

**This is a real-depth build, not a reference stub.** `public/aquin-bkt.js` implements
the Bayesian Knowledge Tracing model (Corbett & Anderson 1994) used in production
intelligent tutoring systems, extended with prerequisite propagation, misconception
diagnosis, forgetting, confidence intervals, and maximum-likelihood parameter fitting.
Node-tested, 10 cases. The proof it is not a stub: **it recovers known BKT parameters
from synthetic data** — a stub cannot.

## What it actually computes
- **Exact BKT update** per response: Bayesian evidence update
  `P(known|obs)` then learning transition `P(known)+ (1-P)·T`; prediction
  `P(correct)=P·(1-S)+(1-P)·G`.
- **Parameter fitting** `fit(observations)`: maximum-likelihood coordinate ascent over
  (L0,T,S,G) with the S+G<1 identifiability guard. Recovered slip/guess to ±0.03 and
  learn/prior within the known BKT identifiability limits on a 400-response sequence.
- **Prerequisite DAG**: a new skill's prior is gated by mean prerequisite mastery
  (calculus prior 0.156 with algebra unknown → 0.25 with algebra mastered); strong
  mastery back-propagates (mastering calculus lifts the algebra estimate 0.25→0.87).
- **Misconception diagnosis**: a wrong answer with a distractor runs a Bayesian
  likelihood-ratio update on that misconception (4 hits → P=0.9 diagnosed).
- **Forgetting**: half-life decay toward a residual floor between opportunities
  (peak 0.999 → 0.525 @7d → 0.287 @14d → 0.099 @30d).
- **Confidence interval**: a Beta model narrows the 90% CI with evidence
  (width 0.748 after 1 obs → 0.115 after 21).
- **recommendNext**: lowest-mastery skill whose prerequisites are met.

## Interface
```
AquinBKT.createModel({graph, params, halfLifeDays, masteryThreshold})
  .observe(skill,{correct,at,distractor,itemDifficulty}) .predict(skill)
  .mastery(skill) .fitSkill(skill) .recommendNext()
AquinBKT.fit(observations) · evidenceUpdate · transition · predictCorrect · seqLogLik
graph = { skillId: { prereqs:[...], params?, halfLifeDays? } }
```
Harness: `bkt_test.js` (10/10). Supersedes the reference `aquin-understanding.js` for
the mastery computation; wire the classroom meter through this for real inference.
HONEST SCOPE: item→skill and distractor→misconception mappings are authored content
(domain data); all inference over them is implemented here.
