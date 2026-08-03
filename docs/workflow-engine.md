# Phase 4 — The workflow engine (Layer 3)

**Status: shipped inactive.** The code is deployed, the tables self-bootstrap, and nothing starts an
approval by itself. Production execution — the backfill, the validation, any rollback — is the
founder's, and every command is written out at the end of this file.

---

## 1. Where this sits

| Layer | Question | Owned by |
|---|---|---|
| 1 · Organization | Who is responsible for whom? | `src/lib/org-graph.ts` — per **row**, from relationships |
| 2 · Authorization | What may this user do? | `src/lib/auth/permissions.ts` — per **user**, dotted lowercase capabilities |
| 3 · Workflow | How does work move? | `src/lib/workflow.ts` — **this phase** |

These never merge. Reporting manager, department head, team lead, functional manager, project
manager, mentor, reviewer, approval chain, delegation chain and executive assignment are
**relationships** — never capabilities and never role names.

**There is no new authorization system here.** This phase adds no capability, no grant, no permission
matrix and no second place that decides access. `mayAct()` asks `holdsCapability()` — the existing
Layer 2 entry point — and asks the org graph for the relationship. Two engines deciding access is the
defect, not the feature.

---

## 2. The two questions, asked in this order

Every approval is decided by asking two separate questions of two different systems:

1. **Routing** — *"who approves this request, for this person, right now?"*
   Answered by the org graph. Per row. From relationships. Never from a role name.
2. **Authorization** — *"may this signed-in user approve at all?"*
   Answered by capabilities plus the routing answer from step 1.

One answer must never serve both. If routing decided authorization, being named as an approver would
*be* the permission and the capability system would be decoration. If authorization decided routing,
holding `leave.approve` would make you the approver of everybody's leave — the per-user grant that
Phase 1 spent its whole budget removing.

---

## 3. When the graph cannot name an approver, the workflow halts

This is the single most important behaviour in the phase.

```
no approver could be resolved: organization graph not yet initialized
no approver could be resolved: no reporting manager is recorded for Priya Nair
no approver could be resolved: no department head is recorded for Priya Nair's department
no approver could be resolved: this request needs executive approval and no executive sponsor is recorded for it
```

The instance is written in state `halted`, carrying the sentence. It is **not** approved, **not**
pending on nobody, and **not** routed to whoever happens to hold a capability. There is no role-name
fallback on any branch.

`isInitialized()` is checked **first and separately**, before any resolver runs, because *"the graph
has no rows at all"* and *"this person has no manager"* are different facts and need different
sentences. Showing the second when the first is true tells every employee they report to nobody.

Auto-approving because routing failed is the worst outcome available to this system: it would grant
every request nobody could be found for, and it would look exactly like the system working.

**Halting is a pause with a stated cause, not a dead end.** Record the missing relationship, press
Resume, and the request carries on from where it stopped (`resumeWorkflow()`). If the graph still
cannot name anybody, it stays halted with the updated reason — it is never nudged into `approved` to
get it moving.

---

## 4. What is on disk

| File | What it is |
|---|---|
| `src/lib/workflow-schema.ts` | Self-bootstrapping DDL for the two tables. Creates nothing else. |
| `src/lib/workflow.ts` | The engine: routing, authorization, state machine, notification and audit hooks. |
| `db/workflow-schema.sql` | The same DDL as a standalone file, for reading and for applying ahead of time. |
| `db/workflow-backfill-leave.sql` | Puts already-pending leave requests into the engine. Guarded — runs nothing until edited. |
| `db/workflow-validate.sql` | Read-only. Nine fault reports plus reconciliation counts. |
| `db/workflow-rollback.sql` | Three stages of increasing finality. Each guarded by a `FALSE` boolean. |
| `src/pages/admin/hr/leave/workflow.astro` | The reachable surface. |
| `src/pages/admin/hr/leave/index.astro` | **One paragraph added** — a link to the above. Nothing else on that page changed. |

`src/lib/hr-leave.ts`, `src/lib/hr-wallet.ts`, `src/lib/auth/permissions.ts` and
`src/lib/org-graph.ts` are **untouched**.

---

## 5. The data model

Two tables. An instance is a **row with an explicit state**; each approval owed is a **row**.

### `workflow_instances`

One row per request moving through an approval.

- `domain` — `leave` | `attendance` | `expenses` | `procurement` | `recruitment` | `travel`
- `record_id` — the id in that domain's own table. **TEXT, not uuid**: the six domains do not agree
  on an id type.
- `state` — `draft` | `pending` | `approved` | `rejected` | `cancelled` | `halted`
- `halt_reason` — the sentence, rendered verbatim
- `current_step` — which step number is live

**Unique on `(domain, record_id)`.** This is the idempotency backstop: two clicks on "Send for
approval", or a retried POST, cannot produce two live approvals of one request routed to two
different people.

### `workflow_steps`

One row per approval decision that is owed.

- `step_no` — position in the chain. **Rows sharing a step number are parallel** and all must
  approve. Distinct step numbers are sequential and run in ascending order. The step number *is* the
  mechanism; there is no separate parallel flag that could get out of step with the rows.
- `via` — which org relationship resolved this approver. **Recorded, never consulted.** It is a value
  of `org_relationships.type`, not a role name; nothing compares it to `users.role`.
- `acted_via` — how the person who decided was entitled: `routed`, `delegate` or `capability`.
  Written *after* the check, never read to make one.
- `approver_employee_id` (`hr_employees.id`) **and** `approver_user_id` (`users.id`) — both, because
  the graph answers in employee ids and notifications and session checks happen in user ids.
  Resolving one from the other per read would be a query per row on somebody's phone.

**Partial unique index on `(instance_id, step_no, approver)` where `decision = 'pending'`** — one
person cannot owe two pending decisions on one rung.

### There is deliberately no third table

No `workflow_events`. `audit_log` (`src/lib/audit.ts`) is this codebase's audit log and every
transition writes to it. A parallel events table would be a **second audit log** that drifts from the
first, consulted by different screens, disagreeing about the same approval. The instance timeline is
fully reconstructable without one: each step carries its decision, decider, timestamp and note; an
escalation is a step pointing at the step it escalated from.

No notification table either. `src/lib/push.ts` already writes `notifications`. One notifier.

---

## 6. The state machine

An invalid transition is **refused with a sentence**, not silently ignored.

```
draft    -> pending, halted, cancelled
pending  -> approved, rejected, cancelled, halted
halted   -> pending, cancelled
approved -> (terminal)
rejected -> (terminal)
cancelled-> (terminal)
```

Read the absences; they are deliberate.

- **Nothing leaves `approved`, `rejected` or `cancelled`.** A settled approval is evidence. Reopening
  one would rewrite the record of a decision somebody made, so a changed mind is a *new* request
  against a new record — which is also how `hr_leave_request` already behaves.
- **`halted -> pending` exists**, and it is what makes halting safe to do (section 3).
- **There is no edge to `approved` from anything but `pending`.** An instance can only be approved by
  walking its steps. No path in the engine writes `approved` as a way of getting unstuck.

`canTransition(from, to)` returns an **object**, not a boolean — `if (canTransition(a, b))` is always
true and would wave every move through. Test `.ok`, or use `isAllowedTransition()`. This is the same
shape and the same warning as `src/lib/employee-tasks.ts`, deliberately, so that reading one teaches
the other.

---

## 7. The approval chains

Each chain is the **shape** of an approval, not a claim about who fills it. Every rung is resolved
per request, per person, from the graph, at the moment the chain starts.

| Domain | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| `leave` | Reporting manager | Approval owner *(optional)* | — |
| `attendance` | Reporting manager | — | — |
| `expenses` | Reporting manager | Approval owner *(optional)* | Executive sponsor, at/above 100,000 |
| `procurement` | Reporting manager | Department head **and** approval owner *(parallel)* | Executive sponsor, at/above 500,000 |
| `recruitment` | Department head | Approval owner *(optional)* | — |
| `travel` | Reporting manager | Approval owner *(optional)* | Executive sponsor, at/above 200,000 |

- **Optional** means: resolves nobody, rung is skipped, chain is still complete. An organisation that
  has not named a leave approval owner has a valid one-rung chain.
- **Required** means: resolves nobody, the instance halts.
- The **threshold rungs are not optional.** If an amount is large enough to need an executive and no
  executive sponsor is recorded, the correct outcome is a halt, not a skip.
- `recruitment` starts at the department head rather than the requester's own manager, because the
  requester is usually the manager.
- `procurement` step 2 is the only genuinely parallel rung: one person answers "does this team need
  it", the other "may we buy it this way", and neither answer substitutes for the other.

### De-duplication

One person can legitimately satisfy two rungs — a small company's department head is often also
somebody's reporting manager. They are kept at their **first** appearance and dropped from later
rungs: asking one human to approve the same request twice is not two approvals, it is one approval
and a confused person.

**The subject is dropped from every rung.** Nobody approves their own request. A chain that allowed
it would make every manager's own leave self-approving, and `db/workflow-validate.sql` section 7
looks for exactly that.

### Executive approval — a stated adaptation

`src/lib/org-graph.ts` exposes `getManager`, `getDepartmentHead`, `getApprovalOwner`, `getDelegates`
and `getReportingChain`. It has **no executive-sponsor resolver**. Writing one here would mean a
second module querying `org_relationships`, which is precisely the drift the org graph exists to
prevent. So executive approval is expressed as an **approval-owner edge scoped to
`'<domain>.executive'`** — `getApprovalOwner()`'s `domain` argument is a free string held in
`scope_id`, as its own docblock states. The founder records one edge per domain that needs it.

---

## 8. Who may act — three arms, in order of narrowness

`mayAct(user, domain, step)`:

1. **Routed.** They *are* the approver this step was routed to. A relationship to one request,
   entitling them to this step and nothing else. Same shape as the arm `hr-wallet.ts approverRole()`
   already has — an employee's own reporting manager may decide *that* employee's request without
   holding any capability. That arm is correct and is left exactly as it is.
2. **Delegate.** They hold an in-force `temporary_delegate` edge over the routed approver. **One hop
   only** — chained delegation would let A delegate to B who delegates to C, quietly reaching further
   than anybody approved. Time-boxed by the edge itself; there is no "is delegated" flag anyone has
   to remember to switch off when they get back.
3. **Standing capability.** They hold the domain's Layer 2 approval capability.

If none fires, the answer is no. **There is no role-name arm.** Fails closed on any error.

### Why only `leave` has a capability

`DomainDefinition.capability` is `'leave.approve'` for leave and **`null` for the other five**.

`leave.approve` already exists in `src/lib/auth/permissions.ts` and already means exactly "may decide
any leave request", so using it changes nothing about who holds it. Mapping expenses or procurement
onto `payouts.approve` would silently hand every holder of that key standing authority over a kind of
request they have never been granted anything about — **this engine must not invent policy.**

`null` is the narrow, fail-closed reading: for those five domains, only the person the graph actually
routed to (or their in-force delegate) may act. Adding a capability later is a one-line, reviewable
decision in `permissions.ts`. It is not this engine's to make. **Listed as an open follow-up in
section 12.**

---

## 9. Idempotency — approving twice must not approve twice

Three guards, because a retried POST from a phone with one bar of signal is the normal case:

1. `startWorkflow()` reads first, and the **unique index** rejects a concurrent second insert the
   read could not have seen. A race is reported as "already started", with `changed: false` — not as
   a failure, because the caller's intent was satisfied.
2. `decideStep()` writes `WHERE decision = 'pending'`, so a second identical approval updates **zero
   rows** and is reported as `{ ok: true, changed: false }`. Telling somebody their approval failed
   when it already succeeded sends them looking for a problem that does not exist. A *different*
   decision, or a different person, is refused and told what the step already is.
3. `advanceInstance()` **re-derives** `current_step` from the step rows rather than incrementing a
   counter, so a double-fire cannot skip a rung and two parallel approvers landing at the same moment
   cannot advance it twice.

The read and the write cannot disagree: every UPDATE repeats the precondition it was validated
against, so a colleague who decided a second earlier wins the race and this write is reported as a
concurrent change rather than overwriting their decision.

---

## 10. Escalation

`escalateStep(stepId, user)` adds the next person **up the subject's reporting line** (from
`getReportingChain()`, falling back to the department head) as an **additional** approver at the same
rung.

- **The original approver is left pending.** Escalation adds somebody who *can* act; it does not take
  the decision away from the person whose decision it is — they may well be one day back from leave.
  Either of them approving completes the rung.
- **Once per step.** Escalating repeatedly would keep widening the circle every time somebody pressed
  the button, which is how a private leave request ends up on six people's screens.
- **Never to the subject, and never to somebody already on the instance.**
- **When the graph names nobody above them, the step stays exactly as it is** and the refusal says
  so. Never auto-approved, never handed to a capability holder, never handed to a role.

`due_at` (per-domain, 48–96 hours) marks when a step becomes *eligible*. **There is no cron and no
automatic sweep in this phase**: escalation changes who a request is waiting on, and a background job
doing that on a graph the founder has not yet populated would produce escalations to nobody at 3am.
`stepsAwaitingEscalation()` is a **read** that lists what a sweep would do.

---

## 11. Notification and audit — the existing ones

- **Notifications:** `sendPushToUser()` (`src/lib/push.ts`), which writes the in-app `notifications`
  row *and* sends the browser push, and already de-duplicates identical messages inside two minutes —
  exactly the retried-POST case. Approvers are notified only when their rung goes live; telling step
  3's approver at the start would train them to ignore it by the time it is their turn. **No second
  notifier.**
- **Audit:** `logAudit()` (`src/lib/audit.ts`), one row per transition, action `workflow.*`, entity
  `workflow_instance`: `start`, `halt`, `step.approve`, `step.reject`, `advance`, `approved`,
  `rejected`, `escalate`, `resume`, `cancelled`, `settle.leave`. **No second audit log.**

Neither ever blocks the decision it records. An approval recorded but not announced is a person who
has to look at a page; an approval refused because a push endpoint was stale is a person who cannot
work.

---

## 12. The leave wiring, exactly

**`src/lib/hr-leave.ts` is untouched.** `decideLeave()` still enforces through `approverRole()`, and
its reporting-manager arm — a per-row relationship, and already correct — works exactly as it does
today. `/admin/hr/leave` still approves leave the way it always has. One paragraph was added to that
page linking to the workflow view; it is a **link, not a redirect**, precisely so neither path is
taken away from anybody who relies on it.

`/admin/hr/leave/workflow` is the new surface. It shows the org-graph status banner, the route each
pending request *would* take, the chains that exist with their step timelines, what is waiting on the
signed-in person, and the halted queue with its reasons. Its only writes go through the engine — the
page contains no SQL and no second authorization check.

**The settlement hook.** When a leave chain settles, `settleDomainRecord()` writes the decision back
to `hr_leave_request` — but **only to a row that is still `pending`**, so a request already decided
the ordinary way is left exactly as the person who decided it left it. The two paths cannot overwrite
each other, and `db/workflow-validate.sql` section 9 proves it. `decided_by_role` records `'workflow'`
rather than a role name, because no role decided it: a chain did, and the chain is on the step rows.
An approved leave still reaches attendance through the same `markLeaveAttendance()` the ordinary path
calls, so payroll cannot read an approved leave day as an absence.

---

## 13. Known limits, written down rather than assumed away

1. **Five domains have no standing approval capability** (section 8). Only routed approvers and their
   delegates can act on expenses, procurement, recruitment, travel and attendance. This is
   deliberate and narrow; it is also a decision the founder may want to revisit in
   `permissions.ts`.
2. **Only `leave` has a settlement hook.** The other five domains have no table to write back to yet
   — the workflow records the decision, and connecting it to a domain record is that domain's phase.
3. **Executive approval rides on `approval_owner`** scoped to `'<domain>.executive'` (section 7),
   because the org graph exposes no executive-sponsor resolver.
4. **Escalation is manual.** No cron (section 10).
5. **Routing is frozen at step creation.** A reorganisation does not move a pending approval — which
   is correct for audit, and means a step whose relationship has since ended shows up in validation
   section 6. Read that section's note before treating a row there as a defect.
6. **`db/workflow-backfill-leave.sql` hand-copies the in-force predicate** from
   `src/lib/org-graph.ts` because SQL cannot call TypeScript. That copy can drift; validation section
   6 re-checks every step it created against the graph. The alternative is to skip the backfill and
   press the button per request, which routes through the engine itself.
7. **No test suite in this phase.** Every runtime, responsive and data claim here is unverified —
   there was no browser and no database. What *is* verified: `npx astro check --minimumSeverity
   error` holds at the 194 baseline, and `npm run build` reaches "prerendering static routes" and
   prints "Complete!".

---

## 14. Commands — the founder's, not the agent's

Nothing below was run. Run them in this order, reading the output of each before the next.

```bash
# 1. Layer 1 first. Without the graph, every workflow halts — correctly, but pointlessly.
psql "$DATABASE_URL" -f db/org-graph-schema.sql
psql "$DATABASE_URL" -f db/org-graph-backfill.sql          # edit the confirm flag first
psql "$DATABASE_URL" -f db/org-graph-validate.sql          # read it

# 2. Layer 3 tables. Optional — the app creates them on first use.
psql "$DATABASE_URL" -f db/workflow-schema.sql

# 3. Put the existing pending leave backlog into the engine.
#    RUNS NOTHING until you change `confirm boolean := FALSE;` to TRUE inside the DO block.
psql "$DATABASE_URL" -f db/workflow-backfill-leave.sql

# 4. Prove it. Read-only, safe at any time, including mid-morning.
psql "$DATABASE_URL" -f db/workflow-validate.sql

# 5. If something is wrong. Pick ONE stage; each is guarded by its own FALSE boolean.
psql "$DATABASE_URL" -f db/workflow-rollback.sql
```

**Then open the surface and check it with your own eyes**, because a green message from a script
proves the script ran, not that it did the intended work:

- `/admin/hr/leave/workflow` — before the backfill this must say **"Organization Graph not yet
  initialized"** and offer nothing that pretends otherwise. That is the correct render, not a fault.
- `/admin/hr/leave` — must be unchanged except for one added paragraph, and must still approve leave.
