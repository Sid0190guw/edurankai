# AES-100 · Vol II · Part IX · Ch 47 — Collective Educational Intelligence

**Status:** specified + reference implementation (`public/aquin-collective.js`,
Node-tested, 6 cases). "One learner teaches the AI; millions improve education."

## Requirements (normative)
- **COL-001** The engine SHALL reason over **aggregates only**; an observation
  carrying individual identity SHALL be rejected. *(test 1)*
- **COL-002** k-ANONYMITY: any pattern from fewer than `minCohort` learners SHALL
  be **suppressed**, never reported. *(test 3 — xr-first n=3 suppressed)*
- **COL-003** It SHALL discover which teaching strategy yields better outcomes
  from population evidence (ranked by aggregate mastery + cohort). *(test 2)*
- **COL-004** It SHALL surface curriculum weaknesses (high misconception rate)
  across sufficient cohorts. *(test 4)*
- **COL-005** A collective finding becomes a **Genome candidate requiring human
  governance** (replication→verification→expert-review→approval); it is NEVER
  auto-applied. *(test 5)*

## Interface
```
Collective: ingest(aggregateObservation) · compareStrategies(concept)
  curriculumWeaknesses(threshold?) · proposeGenomeUpdate(finding) · provenance
```
Reference: `public/aquin-collective.js`. Harness: `collective_test.js` (6/6).
Differential privacy / federated learning / secure aggregation plug in behind
the same aggregate interface.
