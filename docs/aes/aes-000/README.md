# AES-000 — Educational Computational Foundations

**STATUS: architecture (specification only).** This volume contains **no
production code**. It is the Level-0 formal foundation of AquinTutor: the
computational definitions, mathematical models, invariants, and subsystem
contracts that every later runtime (AES-001+) is built on. It is written the way
Intel engineers electrons → gates → registers → ALU **before** "CPU": we define
*Knowledge, Concept, Understanding, Relationship, Learning, Evidence* as
computational objects **before** engineering any Knowledge Runtime or kernel.

## Method (applies to every chapter)

1. **Design Question first.** Each chapter opens with the first-principles
   question that drives the architecture (e.g. *"Before a computer can teach
   knowledge, how must knowledge exist inside the computer?"*).
2. **Engineering problem → alternatives → chosen abstraction.** We state the
   problem, evaluate candidate representations, and justify the choice.
3. **Formal model → invariants → algorithms → contract.** Only then do we
   specify the model precisely, its invariants, spec-level algorithms, and the
   stable interface later subsystems consume.
4. **No invented computer science.** Every primitive is grounded in established
   work — knowledge representation (semantic networks, RDF/property graphs,
   description logics), Bayesian Knowledge Tracing, Item Response Theory,
   Evidence-Centered Design, the spacing/forgetting literature, provenance
   (W3C PROV), bitemporal data, event sourcing. AquinTutor adds abstractions
   only where the education domain genuinely needs them, and says so.
5. **Specification, not implementation.** Pseudocode and math here define
   *behaviour and contracts*. Turning them into runtime code is a later,
   explicitly-declared implementation phase.

## The master invariant (the spine of the whole platform)

Every adaptive action in AquinTutor obeys one pipeline. Nothing shortcuts it.

```
Observation
   -> Educational Event        (interpreted, typed)
   -> Educational Evidence      (validated, provenance-stamped, Ch 6)
   -> Hypothesis Update         (Bayesian; Understanding, Ch 3)
   -> Concept State Transformation   (Learning, Ch 5)
   -> Learning                  (trajectory of understanding over time)
   -> Educational Adaptation    (tutor, rendering, labs, assessment, translation)
```

Two hard consequences, enforced by every chapter:
- **No subsystem mutates a learner model directly.** Only validated Evidence,
  through the pipeline, changes Understanding.
- **Every adaptive decision is auditable** back to the specific evidence that
  produced it. Explainability is a structural property, not a feature.

## Chapters

| Ch | Title | Design Question | Status |
|---:|-------|-----------------|--------|
| 1 | What is Knowledge? | How must knowledge exist inside the computer? | framing |
| 2 | What is a Concept? | How must a unit of meaning exist computationally? | spec |
| 3 | What is Understanding? | What does "a learner understands X" mean computationally? | spec |
| 4 | What is an Educational Relationship? | What is a connection between concepts, computationally? | spec |
| 5 | What is Learning? | What changes, computationally, when learning happens? | spec |
| 6 | What is Educational Evidence? | What may change a learner model, and how is it trusted? | spec |

## Formal objects introduced (glossary)

- **Concept** `⟨id, Repr, D⟩` — immutable identity, per-language representations,
  seven meaning dimensions. (Ch 2)
- **Relationship** `⟨rid, type, endpoints, dir, conf, prov, [t₀,t₁], ver⟩` —
  first-class, versioned, provenance-bearing semantic contract. (Ch 4)
- **Knowledge** `K = ⟨C, R⟩` — a typed, bitemporal, versioned property multigraph
  of Concepts and Relationships; presentation-free. (Ch 1)
- **Understanding** `U(l, c, ctx)` — a per-learner, per-concept, per-context
  vector of probabilistic beliefs over six dimensions, with confidence and
  temporal decay. (Ch 3)
- **Evidence** `e = ⟨id, obs, H, L, q, prov, conf, t⟩` — a validated observation
  with likelihoods over hypotheses, a quality vector, provenance, and
  observation confidence. The universal currency. (Ch 6)
- **Concept State Transformation (CST)** — a signed, confidence-weighted change
  in Understanding; the atomic unit of Learning. (Ch 5)

The separation is deliberate: **Concepts carry meaning, Relationships carry
reasoning, Evidence carries justification, Understanding carries the learner
hypothesis, Learning is the optimization objective.**
