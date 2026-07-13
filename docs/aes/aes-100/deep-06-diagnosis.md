# DEEP BUILD 06 — Diagnostic & Planning Cognition Engine

**Composes the symbolic reasoner + statistical BKT into real educational cognition.**
`public/aquin-diagnosis.js`, Node-tested (7 cases), three real algorithms, no LLM.

## 1) Abductive diagnosis (inference to the best explanation)
Given observed errors + a misconception→error-signature KB, finds the misconception(s)
that best explain the errors, ranked by prior×likelihood (coverage+precision) and by
**parsimony**: a single hypothesis that explains everything beats two that don't;
otherwise a **greedy set-cover** returns the minimal explanation set.
- 2 fraction errors → single cause "adds-num-and-denom" (fully explains).
- fraction error + sign error → minimal set {adds-num-and-denom, sign-error}, none left over.

## 2) Adaptive path planning (Kahn topo-sort gated by real BKT mastery)
Topological order over the prerequisite DAG; a concept is "ready" only when its
prerequisites are actually mastered (`masteryFn` = real BKT `pKnown`); among ready
concepts, orders by the largest mastery gap.
- arithmetic mastered → recommends algebra; calculus/stats blocked by algebra.
- master algebra → calculus + stats unlock.

## 3) Curriculum consistency (DFS)
Cycle detection (`a→c→b→a` found exactly) + dangling-prerequisite detection.

## Interface
```
AquinDiagnosis.createCognition({masteryThreshold})
  .misconception(id,{explains,prior}) .diagnose(observedErrors)
  .planPath(graph, masteryFn) .checkConsistency(graph)
graph = { concept: { prereqs:[...] } }   masteryFn: concept -> 0..1 (BKT)
```
Harness: `diag_test.js` (7/7). This is the layer that answers "*why* is the student
stuck and *what* should they do next" — abduction + planning over the concept graph,
with BKT supplying mastery and the reasoner's algorithms supplying the logic. HONEST
SCOPE: misconception→error and prerequisite relations are authored content; all
inference over them is implemented and verified here.
