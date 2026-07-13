# AES-100 — Engineering the Educational Operating System (Volume II)

**Runtime Engineering & Core Infrastructure.** Volume I (`docs/aes/aes-000/`,
`VOLUME-I-STATUS.md`) defined *what exists* — the constitution. Volume II defines
*how each subsystem is engineered, executed, recovered, and evolved*, at a level
an engineering team can implement from.

## How this manual is written (the standard)

Each chapter is an **RFC-style engineering specification** with:

- **Normative requirements** carrying stable IDs (e.g. `LIFE-003`). "SHALL" =
  mandatory, "SHOULD" = recommended, "MAY" = optional. Requirements are written
  to be **testable**.
- **Terminology**, **architecture** (internal managers), **state machines**,
  **algorithms**, **normative public interfaces**, **failure modes + recovery**,
  **performance targets**, **testing strategy**, **extension points**.
- A **Reference Implementation** section pointing at real, Node-tested code in
  `public/aquin-*.js`. **The spec and the code evolve together** — the code is
  the executable proof the spec is implementable; the spec is the contract the
  code must keep.

Requirement-ID prefixes: `BOOT-` (bootstrap), `LIFE-` (lifecycle),
`SCHED-` (scheduler), `CTX-` (context), `EVT-` (events), `SM-` (state machines),
`REC-` (recovery), `STOR-` (storage), `GRAPH-`, `RET-` (retrieval),
`COG-` (cognition), `RND-` (rendering), `DIST-` (distributed), `SEC-` (security).

## Structure (Parts)

- **Part I — Runtime Engineering:** Bootstrap · Lifecycle · Scheduler · Context ·
  Events · Messaging · State Machines · Recovery.
- **Part II — Storage Engineering:** Object/Temporal/Event/Graph/Blob/Vector/
  Memory/Search/Cache/Archive stores; compression, encryption, backup, recovery.
- **Part III — Graph Engineering** · **Part IV — Retrieval Engineering** ·
  **Part V — Cognitive Engineering** · **Part VI — Rendering Engineering** ·
  **Part VII — Distributed Engineering** · **Part VIII — Security Engineering** ·
  **Part IX — Developer Infrastructure**.

## Chapter status (spec + reference implementation)

| Ch | Title | Spec | Reference implementation | Tests |
|---:|-------|------|--------------------------|------:|
| I.1 | Runtime Bootstrap Engine | `ch01-runtime-bootstrap.md` | `public/aquin-kernel.js` + `aquin-resolver.js` | 15 |
| I.2 | Runtime Lifecycle Engine | `ch02-runtime-lifecycle.md` | `public/aquin-lifecycle.js` | 7 |
| I.3 | Runtime Scheduler Engine | `ch03-runtime-scheduler.md` | `public/aquin-scheduler.js` | 7 |
| I.4 | Runtime Domain Execution | *(embodied in Lifecycle + Scheduler + Command)* | — | — |
| I.5 | Runtime Event Bus | *(= Vol I Ch 4)* | `public/aquin-bus.js` | 5 |
| I.6 | Runtime Command Engine | `ch06-runtime-command.md` | `public/aquin-command.js` | 7 |
| I.7 | Multi-Tenant Educational Runtime | `ch07-shared-device-runtime.md` | `public/aquin-device.js` | 7 |
| II.9 | Holistic Learner Support (AI Mentor) | `ch09-holistic-learner-support.md` | `public/aquin-mentor.js` | 8 |
| VIII.42 | Trust, Privacy & Intervention Governance | `ch42-trust-intervention.md` | `public/aquin-intervention.js` | 7 |
| VIII.44 | Safety Intelligence & Guardian Alert | `ch44-safety-intelligence.md` | `public/aquin-safety.js` | 7 |
| VIII.45 | Future Prediction & Preventive Intelligence | `ch45-future-prediction.md` | `public/aquin-prediction.js` | 7 |

> Method note (from the Chief Architect): we do **not** attempt to write a
> 3,500-page manual in one pass. We engineer one chapter to production quality —
> spec **and** reference implementation together — before proceeding. This keeps
> terminology, interfaces, and requirement IDs internally consistent and always
> grounded in code that runs.
