# AES-100 · Vol II · Part IX · Ch 46 — Educational Life Graph Engine

**Status:** specified + reference implementation (`public/aquin-lifegraph.js`,
Node-tested, 7 cases). Normative: SHALL/SHOULD/MAY.

## Purpose
Remember a learner as an evolving **causal narrative**, not a timeline of records.
Education is an evolving causal network — the long-term semantic memory the
Mentor (Ch 9), Prediction (Ch 45), Research, and Career engines read from.

## Requirements (normative)
- **LIFE-G-001** Nodes SHALL be typed (event/concept/mission/person/interest/
  reflection/misconception/achievement); relationships SHALL be **typed causal
  edges** (inspired/led-to/strengthened/corrected/mentored/recurred/…), each with
  confidence + provenance. *(test 7)*
- **LIFE-G-002** The engine SHALL answer "why/what-changed" via **graph
  traversal**, not keyword search: `narrative()` (forward causal chain),
  `what-inspired` (root-cause back-trace), `influencers`, `recurring-
  misconceptions`, `improved-confidence`. *(tests 1–5)*
- **LIFE-G-003** It SHALL generate an educational **biography** from graph
  reasoning (curiosity development, concept evolution, turning points, challenges,
  influencers). *(test 6)*
- **LIFE-G-004** Every relationship SHALL carry provenance + confidence.

## Interface
```
LifeGraph: addNode({type,label,provenance}) · link(from,to,rel,{confidence,provenance})
  narrative(startId) · query('what-inspired'|'influencers'|'recurring-misconceptions'|'improved-confidence', arg)
  biography() · node(id) · nodes()
```

## Reference implementation
`public/aquin-lifegraph.js` — `window.AquinLifeGraph.createLifeGraph(learnerId)`.
Harness: `scratchpad/lifegraph_test.js` (7/7) — builds and reasons over the
birds→aerodynamics→Bernoulli→drone→aerospace narrative.

## Ch 52 note (Mission Orchestration)
Already implemented as `public/aquin-mission.js` (Vol I Ch 16): hierarchical
missions (nested sub-missions), phased execution, adaptive spawning for
prerequisites/misconceptions, and provenance. Ch 52's deeper concerns
(multi-domain runtime coordination, adaptive replanning across long horizons)
extend it behind the same Mission interface.
