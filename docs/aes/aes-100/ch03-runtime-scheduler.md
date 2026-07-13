# AES-100 · Vol II · Part I · Chapter 3 — Runtime Scheduler Engine

**Status:** specified + reference implementation (`public/aquin-scheduler.js`,
Node-tested, 7 cases). Normative: SHALL/SHOULD/MAY.

## 1. Purpose
Coordinate execution: decide **what runs next, when, and whether to preempt** —
allocating *educational opportunity*, not merely processor time. Only Runtime
Domains in `Running` (Ch 2) submit work.

## 2. The Runtime Work Unit (RWU)
Smallest schedulable entity: `{ id, queue, resources, submittedAt, deadline?,
educationalImportance?, learnerImpact?, governanceCriticality?, retryPolicy }`.
RWU lifecycle: `Created → Queued → Running → Completed` (+ `Preempted → Queued`,
`Failed → Retry → Queued`).

## 3. Requirements (normative)
- **SCHED-001** Priority SHALL be a **vector**, not a scalar: educational
  importance + learner impact + deadline urgency + governance criticality +
  starvation compensation + dependency pressure → an execution score. *(test 1/2)*
- **SCHED-002** Seven specialized queues SHALL exist with latency targets:
  immediate(<50ms) · interactive(<150) · mission(<500) · simulation · sync ·
  background · research.
- **SCHED-003** Dispatch SHALL pick the highest-score `Queued` RWU whose required
  resources fit current availability; otherwise defer (no unsafe
  oversubscription). *(test 4)*
- **SCHED-004** No RWU SHALL be postponed indefinitely: waiting time SHALL raise
  the score (starvation compensation). *(test 3 — score 20→320)*
- **SCHED-005** Urgent higher-score work SHALL preempt a running lower-score RWU
  (checkpoint → back to `Queued`), then dispatch. *(test 5)*
- **SCHED-006** Failure SHALL retry per policy then move to `Failed`; completion
  SHALL release resources. *(test 6)*
- **SCHED-007** Scheduling SHALL be deterministic in the logical clock `now` and
  fully provenance-logged (submit/dispatch/preempt/retry/complete/fail). *(test 7)*

## 4. Public interface
```
Scheduler: submit(rwu) · next(now) -> RWU|null · complete(id) · fail(id)
           scoreOf(id, now) · state(id) · stats() · capacity() · provenance
```

## 5. Non-goals
Does not implement AI/retrieval/rendering/simulation logic or lifecycle
transitions — it coordinates execution only.

## 6. Reference implementation
`public/aquin-scheduler.js` — `window.AquinScheduler.createScheduler()`.
Harness: `scratchpad/scheduler_test.js` (7/7). Distributed placement /
migration (SCHED across Runtime Nodes) is the next increment.
