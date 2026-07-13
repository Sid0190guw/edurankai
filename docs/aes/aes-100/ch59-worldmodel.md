# AES-100 · Vol II · Part XV · Ch 59 — Educational World Model Engine

**Status:** specified + reference implementation (`public/aquin-worldmodel.js`,
Node-tested, 6 cases). The situational-awareness layer — the single authoritative
answer to "what is happening RIGHT NOW?" (the way Windows keeps system state and
aircraft keep flight state).

## Requirements (normative)
- **WORLD-001** ONE authoritative reality: no Runtime Domain builds its own version
  of the world; every domain reads the same World Model.
- **WORLD-002** Present / past / future / simulation strictly separated. Only the
  present is active reality; projections and history never mutate it. *(test 2)*
- **WORLD-003** Event-driven: a meaningful educational event immediately updates
  present state AND notifies dependent domains (no polling). *(test 1)*
- **WORLD-004** Consistency validation detects conflicting states, duplicate
  identities, and stale Digital Twins. *(test 4)*
- **WORLD-005** Immutable snapshots enable rollback, audit, reproducible
  simulation. *(test 3)*
- **WORLD-006** Multi-scale (learner → classroom → institution → … → civilization);
  each scale has its own state and rolls up. *(test 5)*
- **WORLD-007** Complete provenance of every world change. *(test 6)*

## Interface
```
WorldModel: upsert(obj) · current(id) · at(id) · subscribe(eventType,handler)
  event({type,subject,apply,payload}) · project(id,projector) · recordedHistory(subject)
  validate() · snapshot(label) · rollback(label) · scaleView(scale)
```
Reference: `public/aquin-worldmodel.js`. Harness: `world_test.js` (6/6). HONEST
SCOPE: in-memory single-node authoritative state + event bus; distributed
replication, fault-tolerant consensus, and billion-object indexing are the
substrates behind the same interface. Every engine (Tutor, Prediction, Safety,
Mission, Collective) reads present reality here rather than reconstructing it.
