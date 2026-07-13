# DEEP BUILD 03 — Runtime Orchestrator (real end-to-end integration)

**Real-depth build: the whole constitutional spine executes as ONE system.** Until
now each engine was proven in isolation; `public/aquin-orchestrator.js` composes the
ACTUAL engine objects into a single executable pipeline with a replayable audit
trail. Node-tested, 5 cases, loading all 9 real engines together.

## The pipeline (each stage can HALT with a reason)
```
self-model -> intent -> context -> constitution -> agents -> ethics -> world -> bkt -> respond
   1            2         3           4               5         6         7      7
```
1. **self-model** — can the system do this? else escalate to a human
2. **intent** — why is the learner asking → teaching pathway
3. **context** — unified context object → response adaptation (level/language/format)
4. **constitution** — permitted? (identity/authz/truth/safety/governance/policy)
5. **agents** — specialists produce the answer (knowledge → tutor → verify)
6. **ethics** — among permitted candidates, which best serves the learner?
7. **world + bkt** — commit to shared reality + update mastery with real BKT

## Verified behaviour
- **End-to-end success**: request "…for my Class-8 exam tomorrow" → intent inferred
  `exam-prep`, context depth `foundational`, mastery updated to 0.71 via real BKT,
  full 9-step audit.
- **Every gate halts correctly**: unsafe → halted at `constitution` (safety stage);
  unknown capability → halted at `self-model` (escalate to human); high-stakes →
  halted at `ethics` (human review).
- **Determinism**: identical inputs → byte-identical audit trace (auditable as a unit).

## Interface
```
AquinOrchestrator.createOrchestrator({selfModel,intent,context,constitution,agents,ethics,world,bkt})
  .handle(request) -> { ok, response|null, haltedAt?, reason?, audit:[...] }
```
Harness: `orch_test.js` (5/5). HONEST SCOPE: this is the real control/data flow
between engines; the intelligence inside each is exactly what that engine implements
(BKT is real math; the tutor's natural language is a declared model substrate). This
is the object the live classroom should call.
