# AES Volume I — Constitutional Architecture — Build Status

**Volume I ontology is complete (21 constitutional chapters).** This file maps
each constitutional subsystem to its **running, Node-tested reference
implementation** in `public/aquin-*.js`. These are real, dependency-free engines
that compose — not prose. Where a subsystem is spec-only so far, it says so.

> Rule held throughout: build the browser-real core of each subsystem and
> **declare** the parts that need native/distributed/model infrastructure rather
> than fake them. Every engine is proven by a re-runnable harness.

## The engines (18 constitutional + 2 boot prototypes)

| Constitutional subsystem | Engine | Tests |
|---|---|---|
| Concept · Relationship · Knowledge Graph Engine | `aquin-concept.js` | 11 |
| Understanding · Learning · Evidence · Objective · Adaptation | `aquin-understanding.js` | 9 |
| Educational Mission | `aquin-mission.js` | 5 |
| Educational Truth · Consistency | `aquin-consistency.js` | 6 |
| Educational Execution · Verification | `aquin-execution.js` | 6 |
| **Educational Operating Kernel** (Runtime · Runtime Domains · Runtime Objects) | `aquin-eok.js` | 9 |
| Educational Interaction Bus | `aquin-bus.js` | 5 |
| Educational Knowledge Ingestion Pipeline | `aquin-ingest.js` | 7 |
| Educational Persistence | `aquin-persistence.js` | 6 |
| Educational Memory Hierarchy | `aquin-memory.js` | 7 |
| Educational Cognitive Execution Engine | `aquin-cognition.js` | 7 |
| Educational Simulation Engine | `aquin-simulation.js` | 6 |
| Educational AI Runtime Layer | `aquin-airuntime.js` | 7 |
| Autonomous Educational Research Engine | `aquin-research.js` | 7 |
| Educational Multimodal Perception Engine | `aquin-perception.js` | 5 |
| Educational Rendering Engine | `aquin-render.js` | 6 |
| Human–EI Interaction Engine | `aquin-interaction.js` | 8 |
| Educational World Runtime | `aquin-world.js` | 6 |
| Runtime Bootstrap · Dependency Resolution (boot) | `aquin-kernel.js` · `aquin-resolver.js` | 15 |

**~150 test cases**, all re-runnable headless.

## Spec-only so far (constitutional, not yet coded)
- **Educational Retrieval** (Ch 7) — Persistence + constitutional indexes exist; the
  retrieval-assembly + contextual-ranking engine is the next natural brick.
- **Educational Synchronization** (Ch 14) — offline-first + semantic conflict
  resolution; the Bus/EOK/Persistence provide the substrate.
- **Educational Digital Twin Framework** (Ch 21) — Learner/World twins are
  effectively the `understanding`/`world` engines; the unifying twin framework
  is unbuilt.
- **Knowledge Infrastructure federation** (Ch 8) — distribution/sovereignty is
  declared, not implemented.

## How they compose (the spine actually runs)

```
Perception → Observation → Evidence ─┐
Ingestion (bonafide-gated) → Concept/Truth ─┤→ Persistence → Memory (activate)
                                             │        ↓
                                       Cognition (7-phase, multi-modality)
                                        ├─ AI Runtime (verified, model-independent)
                                        └─ Simulation (isolated parallel futures)
                                             ↓  Decision + Verification Contract
     Interaction (authority-gated) ⇄ Kernel (governed txns) ⇄ Bus ⇄ Execution (verify)
                                             ↓
                                     Rendering (adaptive) → Learner experience
                                             ↓
                                 World Runtime (persistent, versioned, nested)
```

Enforced in code, not just documented: nothing changes reality except validated
evidence through governed transactions; AI is swappable and its output is
verified before use; truth contradictions are rejected; simulations can't
corrupt reality; authority is intrinsic; every step is provenance-logged.

## Next (Volume II — AES-100, engineering the subsystems)
Volume I defines *what exists*; Volume II specifies *how each is built* down to
algorithms/data structures/protocols. The highest-value real work now is either
(a) deepen a chosen engine toward AES-100 depth, or (b) **wire the spine into the
live product** (classroom/labs) so the constitutional engines power the actual
app — turning a tested library into a working Educational OS.
