# AES-000 — Educational Computational Foundations

**The Level-0 foundation of an Educational Intelligence Computing Platform (EICP).**

AquinTutor is **not** an LMS, an AI tutor, or a chatbot. It is an *operating
environment for education* in which AI models are **computational engines, not
the architecture**. This volume defines the theory, mathematics, and contracts
everything else is built on. It is a decades-scale program, engineered **one
subsystem at a time without losing coherence**: this document is the map; the
real, tested modules (see Build Status) are the bricks.

**STATUS: mostly architecture (spec). Two foundations already exist as real,
Node-tested code** — see Build Status — because they were bounded enough to
build and verify. Everything else is specification until it becomes an
explicitly-declared implementation phase.

## Structure (5 Parts)

AI appears only in Part IV — *after* the theory and mathematics, never before.

### Part I — Educational Theory  *(the "what", grounded in learning science)*
Chapters received so far. **[code]** = a real, Node-tested implementation exists.
1. What is Education?
2. What is Knowledge?
3. What is a Concept? **[code]**
4. What is an Educational Relationship? **[code]**
5. What is Understanding? **[code]**
6. What is Learning? **[code]**
7. What is Educational Evidence? **[code]**
8. What is Educational Memory?
9. What is Educational Reasoning?
10. What is Educational Intelligence?
11. What is an Educational Objective? **[code]**
12. What is Educational Adaptation? **[code]**
13. What is Educational Perception?
14. What is Educational Planning?  *(core in Mission runtime)*
15. What is Educational Orchestration?  *(core in Mission runtime)*
16. What is an Educational Mission? **[code]**
17. What is Educational Knowledge Acquisition?
18. What is Educational Truth? **[code]**
19. What is Educational Consistency? **[code]**
20. What is Educational Evolution?
21. What is Educational Governance?
22. What is an Educational Intelligence Society?
23. What is Collective Educational Cognition?
24. What is Educational Creativity? **[code]**
25. What is the Educational World Model?
26. What is Educational Prediction?
27. What is Educational Decision Making? **[code]**
28. What is Educational Execution? **[code]**
29. What is Educational Verification?  *(core in Execution)*
30. What is Educational Self-Improvement?
31. What is Educational Wisdom? **[code]**  ← **Part I milestone: Perception → Wisdom, now all real code**

> **AES-000 Part I milestone (Ch 31).** The constitutional theory is complete
> end-to-end. Next: Parts II–V move from *what Educational Intelligence is* to
> *how AquinTutor is engineered* (computational theory, mathematics, AI runtime,
> operating system). Six foundation chapters already run as real, tested code.

### Part II — Computational Theory  *(the "how it computes")*
Information → Educational Information → Semantic Information → Knowledge
Representation → Computational Memory → Computational Intelligence →
Computational Planning → Computational Learning → Autonomous Learning →
Autonomous Improvement → Distributed Educational Intelligence.

### Part III — Educational Mathematics  *(formalization, not invented math)*
A coherent framework composed from **existing** fields: graph theory,
probability, information theory, optimization, constraint satisfaction, decision
theory, knowledge representation, educational measurement (IRT, ECD), learning
sciences (BKT, spacing/forgetting, conceptual-change).

### Part IV — Educational Intelligence Architecture  *(now AI appears)*
Cognitive Runtime, Educational Planner, Curriculum Planner, Reasoning Engine,
Memory Engine, Learning Engine, Observation Engine, Evidence Engine, Hypothesis
Engine, Simulation Planner, Animation Planner.

### Part V — Operating System  *(AES-001+)*
Educational Kernel → Memory Runtime → Knowledge Runtime → Object Runtime →
Rendering Runtime → Distributed Runtime → Synchronization Runtime → AI Runtime →
Teacher Runtime → Student Runtime.

## The Educational Cognitive Society (Part IV target)

Not one AI, and not "agents" in the trendy sense — a society of **persistent,
specialized runtime services** with clear responsibilities and stable contracts:

| Service | Responsibility |
|---|---|
| **Educational Governor** | correctness, governance, institutional policy, accreditation, licensing, ethics |
| **Educational Planner** | teaching strategy, lesson sequencing, long-term learning plans |
| **Educational Reasoner** | builds and evaluates educational hypotheses (Ch 9) |
| **Educational Scientist** | validates concepts against governed sources before they become authoritative |
| **Visualization Intelligence** | chooses representation: diagram / animation / simulation / lab / XR |
| **Assessment Intelligence** | designs assessments that collect the *most informative evidence* (ECD) |
| **Language Intelligence** | preserves meaning across languages; local terminology, same concept |
| **Research Intelligence** | monitors governed sources, proposes knowledge updates with provenance |

## The master invariant (the spine)

```
Observation
   -> Educational Event         (interpreted, typed)
   -> Educational Evidence       (validated, provenance-stamped; Ch 7)
   -> Hypothesis Update          (Bayesian; Understanding, Ch 5)
   -> Concept State Transformation   (Learning, Ch 6)
   -> Learning                   (trajectory of understanding over time)
   -> Educational Adaptation     (tutor, rendering, labs, assessment, translation)
```

Consequences enforced everywhere: **no subsystem mutates a learner model
directly** (only validated evidence does, through the pipeline), and **every
adaptive decision is auditable** back to its evidence.

## Method (every chapter)

Design Question → engineering problem → alternatives evaluated → chosen
abstraction (**grounded in named prior art**) → formal model → invariants →
spec-level algorithms → subsystem contract. **No invented computer science.**

## Build Status (map vs bricks)

| Item | Kind | State |
|---|---|---|
| Ch 1 What is Education? | Part I spec | drafted (`ch01-what-is-education.md`) |
| Ch 2 What is Knowledge? | Part I spec | drafted (`ch02-knowledge.md`) |
| Ch 3 Concept · 4 Relationship | **real code** | `public/aquin-concept.js`, Node-tested (11) |
| Ch 5 Understanding · 6 Learning · 7 Evidence · 11 Objective · 12 Adaptation | **real code** | `public/aquin-understanding.js`, Node-tested (9) |
| Ch 16 Mission (+14 Planning/15 Orchestration core) | **real code** | `public/aquin-mission.js`, Node-tested (5) — drives Concept+Learner end-to-end |
| Ch 18 Truth · 19 Consistency | **real code** | `public/aquin-consistency.js`, Node-tested (6) — solves the Bernoulli/viscosity case |
| Ch 28 Execution (+29 verify core) | **real code** | `public/aquin-execution.js`, Node-tested (6) — decision->execute->verified transformation |
| Ch 8 Memory · 9 Reasoning · 13 Perception · 17 Acquisition · 25 World-Model · 26 Prediction | **real code** | aquin-{memory,reasoner,cognition,perception,ingest,worldmodel,prediction}.js |
| Ch 20 Evolution · 21 Governance · 22 Society · 23 Collective · 24 Creativity · 30 Self-Improve · 31 Wisdom | **real code** | aquin-{evolution,eok,agents,collective,creativity,wisdom}.js |
| Ch 2 Knowledge (KnowledgeStore) | **real code** | aquin-knowledge.js, Node-tested (11) + composed with Ch3 Concept |
| Parts II–V | architecture | queued |

**Closed loop now runs in code:** Objective -> Decision (Learner.adapt) ->
Execution Contract -> governed Action -> Evidence -> Understanding update ->
Verify (Concept State Transformation) — across `aquin-{concept,understanding,mission,execution}.js`.

**AES-001 systems layer begun:** `public/aquin-eok.js` — the Educational
Operating Kernel (Ch 1, +Runtime/Runtime-Domain core Ch 2/3). Every engine above
plugs into it as a constitutional **Runtime Domain**; the only way to change
educational reality is `submit(transaction)`, which runs the governance gate
(denies fabricated evidence / non-advisory proctoring / ungranted authority),
consistency-gates truth, returns an immutable Runtime Object, and appends to the
ledger. Node-tested (9). *(Distinct from the earlier boot prototype
`aquin-kernel.js`, which is the low-level runtime bootstrap.)*
| AES-001 kernel / resolver | Part V prototype | `public/aquin-kernel.js`, `aquin-resolver.js` (reference, unpushed) |

> Reference prototypes (kernel/resolver) predate the Part-ordering above; they
> are kept for reference and re-slotted into Part V when that phase is declared.
