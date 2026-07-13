# DEEP BUILD 05 — Symbolic Reasoning & Constraint Propagation

**Real symbolic AI, no LLM.** `public/aquin-reasoner.js` = two complementary, fully
implemented engines. Node-tested (inference 5 + CSP 4).

## A) Inference engine (first-order Horn clauses)
- Unification with occurs-check (pure).
- Forward chaining to a deductive fixpoint (transitive closure verified).
- Backward chaining returning a machine-checkable **proof tree** + bindings.
- All-solutions query; contradiction detection over a conflict relation.
- Educational: derives `ready(learner, concept)` from prerequisite facts; proves
  non-readiness by absence of a proof.

## B) Constraint propagation (finite-domain CSP)
- **AC-3 arc consistency** — prunes values with no support before search
  (X∈{1,2,3}, X>1 → {2,3}); detects unsatisfiability early (triangle/2-colors → UNSAT).
- **Backtracking search with MRV** (minimum-remaining-values) heuristic.
- Educational: solves prerequisite-ordering / scheduling with strict-before
  constraints (arith<algebra<calculus, algebra<stats).

## Interface
```
AquinReasoner.createReasoner()  .fact(a) .rule(head,body) .conflict(a,b)
   .forwardChain() .prove(goal) .query(goal,var) .contradictions()
AquinReasoner.createCSP()  .variable(name,values) .constrain(x,y,ok)
   .ac3() -> {consistent,domains,prunings|unsatisfiable}  .solve() -> {solved,assignment}
terms: V('X') variable · atom('pred',...args) · constants are strings/numbers
```
Harness: `reasoner2_test.js`. HONEST SCOPE: definite clauses + finite-domain CSPs;
full first-order resolution with function symbols and probabilistic/modal reasoning
are extensions behind the same term model. This is the deductive counterpart to the
statistical BKT engine — together they cover "what follows logically" and "what does
the evidence say."

> NOTE: the user is providing a detailed reasoning/cognition specification (exact
> algorithms + aspects). This engine is the constraint-propagation foundation; the
> full cognition layer will be aligned to that spec as it is shared.
