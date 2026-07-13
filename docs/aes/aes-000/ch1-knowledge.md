# AES-000 · Chapter 1 — What is Knowledge?

**STATUS: architecture (spec).** Framing chapter; the formal objects it names
are specified in Ch 2 (Concept) and Ch 4 (Relationship).

## Design Question

> Before a computer can *teach* knowledge, how must knowledge *exist inside the
> computer*?

Not "how is knowledge displayed," not "where is content stored" — how does
knowledge exist as a computational object a reasoning system can operate on.

## Engineering problem

Three incumbent answers, each insufficient for an Educational Intelligence OS:

| Representation | What it captures | Why it fails as *knowledge* |
|---|---|---|
| **Document store** (LMS) | files, courses, tags | meaning lives in prose; the machine cannot reason over prerequisites, misconceptions, or transfer. Retrieval ≠ understanding. |
| **Vector embeddings** (LLM/RAG) | statistical similarity | not interpretable, not auditable, not editable by an educator, no exact prerequisite/derivation semantics, drifts with the model. |
| **Prerequisite lists / foreign keys** | connectivity | an edge with no *meaning*: cannot tell "mathematical dependence" from "interdisciplinary application." |

## Chosen abstraction

**Knowledge is a typed, versioned, bitemporal property multigraph, free of
presentation, over which reasoning is performed — never the reasoning itself.**

```
K = ⟨ C, R ⟩
  C : set of Concepts        (Ch 2) — units of meaning
  R : set of Relationships   (Ch 4) — typed, first-class semantic contracts
```

Grounding (established work, not invented): semantic networks (Quillian 1968),
RDF / labelled property graphs, description logics / OWL for typed relations and
consistency, and the knowledge-graph tradition. AquinTutor's additions are
domain-specific: the seven Concept dimensions (Ch 2), the educational
relationship categories (Ch 4), and the strict separation of **meaning (K)**
from **learner state (Understanding, Ch 3)** and **presentation (runtimes)**.

### What is *not* in K

- **No learner state.** Understanding `U(l,c,ctx)` (Ch 3) is a per-learner
  *overlay* computed from Evidence; it is never stored inside a Concept. One K,
  many learners.
- **No presentation.** No layouts, timelines, assets, or device assumptions.
  Rendering/lab/translation runtimes *interpret* K; they do not live in it.
- **No raw documents.** Lectures, PDFs, and recordings are *Educational
  Storage* (Ch 8), which K may reference but is not composed of.

## Invariants

1. **Presentation independence.** No element of K contains rendering, UI, or
   device-specific data. (Testable: a K export contains none of the forbidden
   keys defined in Ch 2 §visual.)
2. **Identity stability.** A Concept's/Relationship's identity is immutable and
   language-independent; representations and edges may change, identity may not.
3. **Non-destructive evolution.** Edits produce new versions with lineage
   (Ch 4); historical K is reconstructable at any past time (bitemporal).
4. **Meaning/learner separation.** K is identical for all learners; only the
   Understanding overlay differs.
5. **Reasoning externality.** K stores structure; intelligence is the *reasoning
   over* K (Ch 7), not a property of K.

## Subsystem contract (read model, abstract)

```
KnowledgeStore:
  getConcept(id)                    -> Concept            (Ch 2)
  relations(id, {type?, dir?, at?}) -> Relationship[]     (Ch 4; `at` = valid-time)
  subgraph(seedIds, policy)         -> ContextGraph       (bounded; Ch 7 §context)
  versionAt(timestamp)              -> KnowledgeSnapshot   (bitemporal)
```

Every later runtime (Tutor, Assessment, Rendering, Labs, Translation, Research)
consumes `KnowledgeStore` through this stable interface, never a storage format.

## Downstream consumers

All of AES-000 Ch 2–8 and every AES-001+ runtime.

## Open engineering questions (deferred, tracked)

- Partitioning/sharding of K at 10⁸-learner scale (storage concern, not a
  semantics change) — deferred to the Knowledge Runtime volume.
- Global vs institutional K divergence (institutions localize confidence/edges
  without forking identities) — specified in Ch 4 §provenance; distribution
  mechanics deferred.

---

## NOW IMPLEMENTED AS CODE — `public/aquin-knowledge.js`

Chapter 1 is no longer only a spec: the `KnowledgeStore` implements and enforces
every clause, Node-tested (11 checks). Instruction → code → proof:

- **K = ⟨C,R⟩, typed property multigraph** — Concepts + first-class TYPED
  Relationships; multigraph verified (2 different typed edges between the same pair).
- **INV-1 Presentation independence** — `putConcept`/`relate` reject
  `FORBIDDEN_PRESENTATION` keys recursively (`color` rejected in test).
- **INV-2 Identity stability** — `id` immutable across edits; only representation
  changes (Bernoulli v1→v2, same id).
- **INV-3 Non-destructive, bitemporal** — edits close the prior valid interval and
  append a new version with lineage; `getConcept(id,{at})` and `versionAt(t)`
  reconstruct historical K (Mar="v1", Sep="v2").
- **INV-4 Meaning/learner separation** — `FORBIDDEN_LEARNER` keys rejected
  (`mastery` rejected).
- **INV-5 Reasoning externality** — the store has no `reason`/`infer`/`teach`;
  reasoning is a separate subsystem that consumes the read model.
- **Subsystem contract** — `getConcept · relations · subgraph · versionAt` all
  implemented with valid-time semantics.

Harness: `knowledge_test.js` (11/11). This is Chapter 1 built line by line, not
paraphrased into an engine.
