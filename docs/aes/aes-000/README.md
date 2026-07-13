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
1. **What is Education?**  ← the root; every later definition depends on it
2. What is Knowledge?
3. What is a Concept?
4. What is an Educational Relationship?
5. What is Understanding?
6. What is Learning?
7. What is Educational Evidence?
8. What is Educational Memory?
9. What is Educational Reasoning?
10. What is Educational Intelligence?

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
| Ch 3 Concept · Ch 4 Relationship | Part I spec **+ real code** | `public/aquin-concept.js`, Node-tested (11) |
| Ch 5 Understanding · 6 Learning · 7 Evidence · 11 Objective · 12 Adaptation | Part I spec **+ real code** | `public/aquin-understanding.js`, Node-tested (9) |
| Ch 1 Education · 8 Memory · 9 Reasoning · 10 Intelligence · 13 Perception · 14 Planning · 15 Orchestration | Part I spec | queued (build one brick at a time) |
| Parts II–V | architecture | queued |
| AES-001 kernel / resolver | Part V prototype | `public/aquin-kernel.js`, `aquin-resolver.js` (reference, unpushed) |

> Reference prototypes (kernel/resolver) predate the Part-ordering above; they
> are kept for reference and re-slotted into Part V when that phase is declared.
