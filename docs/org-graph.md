# Phase 3B — Organization Graph infrastructure

Layer 1 of the permanent three-layer rule. **Built complete. Shipped inactive. Not executed against
any database.**

---

## What shipped

| File | What it is |
| --- | --- |
| `src/lib/org-graph-schema.ts` | Self-bootstrapping DDL for the four Layer 1 tables |
| `src/lib/org-graph.ts` | The service. The only place relationships resolve |
| `db/org-graph-schema.sql` | Readable mirror of the DDL, runnable by hand |
| `db/org-graph-backfill.sql` | Seeds the graph from `hr_employees.reporting_manager_id` |
| `db/org-graph-backfill-department-heads.sql` | Optional, separate, deliberate one-time migration |
| `db/org-graph-validate.sql` | Read-only. Counts, orphans, cycles, overlaps, drift |
| `db/org-graph-rollback.sql` | Three stages, each behind a `confirm := FALSE` flag |
| `docs/org-graph.md` | This file |

Nothing imports `src/lib/org-graph.ts`. No page, no API route, no existing service. Deploying this
changes no behaviour anywhere, and the tables are not created until something calls into the module.

---

## The three layers

```
Layer 1  ORGANIZATION    who is responsible for whom    org_relationships, resolved per ROW
Layer 2  AUTHORIZATION   what a user may do             src/lib/auth/permissions.ts, per USER
Layer 3  WORKFLOW        how work moves                 elsewhere
```

They never merge. Reporting manager, department head, team lead, functional manager, project
manager, mentor, reviewer, approval owner, delegation and executive sponsorship are **relationships**
— rows in a table, with two endpoints and a lifetime. They are never capabilities and never role
names.

**There is no new authorization system here.** `src/lib/org-graph.ts` grants nothing and denies
nothing. It answers "is this person the manager of that person" and hands the answer back; what may
then be *done* is still Layer 2's question, answered by capabilities in `permissions.ts`. Two engines
deciding access is the defect this architecture exists to avoid — so if this module ever starts
returning "may approve" instead of "is the manager of", the boundary has broken.

---

## The problem this replaces

`hr_employees.reporting_manager_id` (`db/hr-schema.sql:118`) is a single column on a row that is
**mutated in place**. Change someone's manager and the previous value is overwritten and gone.

* *"Who was Ravi's manager on 12 March, when this leave was approved?"* — unanswerable.
* Every past approval is therefore unauditable. We can show who approved; we cannot show that they
  were entitled to.
* There is exactly one reporting line per person, so mentor, reviewer, project manager and
  functional manager have nowhere to live at all.
* `departments` carries no head column in **either** schema file — not in
  `src/lib/db/schema.ts:80-90`, not in `db/hr-schema.sql:31-38`. There is no department-head data in
  the product at all.

**The adopted idea, from the reviewed reference HRMS: the edge is its own row with its own lifetime.**
Adding a manager inserts a row. Changing a manager *closes* the old row and inserts a new one.
Nothing is ever deleted, so the question above becomes a `SELECT` with a date in it.

### What was deliberately not adopted

Full bitemporality. The reference implementation uses `btree_gist`, `EXCLUDE` constraints over
`tstzrange`, a `NOLOGIN` owner role and `SECURITY DEFINER` functions. **None of those are available
here** — this project bootstraps its own DDL over a Supabase *transaction pooler* connection, which
cannot create extensions or roles and does not guarantee a session for `SET LOCAL`.

What replaced them, and what that costs:

| Wanted | Built instead | The gap |
| --- | --- | --- |
| `EXCLUDE` over `tstzrange` | **Partial unique indexes** on the open rows | Prevents two edges being *open* at once. Does **not** prevent two *closed* rows overlapping in the past. |
| `SECURITY DEFINER` write functions | Plain writes in `org-graph.ts` | Any code with a DB handle could write a bad row. |
| Extension-backed integrity | `db/org-graph-validate.sql` sections 4–5 | Detection after the fact, run by a person, not enforcement by the planner. |

That gap is stated rather than assumed away. Section 5 of the validation file is the honest
replacement for the constraint that could not be built.

---

## Schema

### `org_relationships` — the edge table

Read every row as this sentence, which is fixed and never re-derived:

> **`<subject>` is the `<type>` of `<object>`, within `<scope>`, from `<effective_from>` to `<effective_to>`**

* `subject_employee_id` — the person who **holds** the responsibility (manager, head, mentor, delegate)
* `object_employee_id` — the person it is **about** (the report, the mentee). `NULL` when the
  responsibility is to a *scope*: a department head heads a department, not one named person.

Types: `reporting_manager`, `department_head`, `team_lead`, `functional_manager`, `project_manager`,
`mentor`, `reviewer`, `executive_sponsor`, `temporary_delegate`, `approval_owner`.

Supporting tables: `org_teams`, `org_positions`, `org_employee_assignments` (who sits where, when —
append-only on the same terms).

### `status` vs effective dates — the distinction that keeps the history alive

| Field | Question it answers |
| --- | --- |
| `effective_from` / `effective_to` | **When** the relationship was true. A closed row is still a true record of the past. |
| `status` | **Whether** the row is a trustworthy assertion at all. `active` = real, counts on any date in its range. `revoked` = entered in error, counts on no date. |

**Superseding an edge sets `effective_to` and leaves `status = 'active'`.** There is deliberately no
`'superseded'` status. Every historical query filters `status = 'active'`, so a closed row that also
lost its active status would vanish from history — destroying the one thing this table exists to
keep. `revoked` is only for rows that should never have existed.

Validation section 6 looks for `'superseded'` appearing as a status for exactly this reason.

### The half-open boundary

The in-force test is `effective_from <= at AND (effective_to IS NULL OR effective_to > at)`. So
closing one edge and opening the next **at the same instant** leaves no gap and no overlap — at that
instant exactly one row answers. `supersedeReportingManager()` relies on this, and does both in one
data-modifying CTE so it cannot half-succeed and leave someone reporting to nobody.

---

## Two id-space traps

**1. Employee ids vs user ids.** The graph is keyed on `hr_employees.id`. The legacy column it
replaces does the opposite: `hr_employees.reporting_manager_id` holds a **users** id
(`db/hr-schema.sql:114-118`; `hr-wallet.ts approverRole()` compares it to the signed-in user's id).
So the API has two clearly separated halves:

```ts
// employee-id space
getManager(employeeId)            isReportingManager(managerEmployeeId, employeeId)
getReportingChain(employeeId)     isResponsibleFor(actorEmployeeId, targetEmployeeId)

// user-id space — crosses the trap once, via employeeIdForUser(), then delegates
userIsReportingManager(userId, employeeId)     userIsDepartmentHead(userId, departmentId)
userIsResponsibleFor(userId, employeeId)       userDirectReports(userId)
```

Never pass a session user id to the first half. The backfill translates via
`hr_employees.user_id`, and a manager who is a user *without* an employee record cannot be
represented at all — validation section 2a counts them rather than letting them vanish.

**2. Department ids are TEXT and are never cast to `::uuid`.** `departments.id` is `varchar(50)` — a
slug — in `src/lib/db/schema.ts:80` and `UUID` in `db/hr-schema.sql:31`. The same logical value has
two types in this product. `org_relationships.scope_id` is TEXT, and `hr_employees.department_id` is
read as `::text` everywhere. A `::uuid` cast throws `invalid input syntax for type uuid` the first
time a slug arrives.

---

## The service — `src/lib/org-graph.ts`

```ts
isInitialized()            // is there ANY data yet?
getManager(employeeId, { asOf })          getDirectReports(managerEmployeeId, { asOf })
isReportingManager(mgrId, empId, { asOf }) getReportingChain(employeeId, { asOf, maxDepth })
getDepartmentHead(departmentId, { asOf })  isDepartmentHead(employeeId, departmentId, { asOf })
getMentor(employeeId, { asOf })            getDelegates(employeeId, { asOf })
getApprovalOwner(domain, { employeeId, asOf })
isResponsibleFor(actorEmployeeId, targetEmployeeId, { asOf })
getRelationshipHistory(employeeId)         // the payoff of append-only

// writes — append-only, nothing calls them yet
openRelationship(input)   closeRelationship(id, { asOf })   revokeRelationship(id, reason)
supersedeReportingManager(employeeId, newManagerEmployeeId, { asOf, createdByUserId, note })
```

**Zero role names.** Nothing in the file reads `users.role`, compares against `'department_head'`,
`'hr'`, `'super_admin'` or any other `userRoleEnum` value, or accepts a role as an argument. The
string `'department_head'` does appear — as a value of `org_relationships.type`, a *relationship
type*, living in a different table and never compared to a user's role.

**Fail closed, every function, no exceptions.** Every resolver is wrapped in `try/catch` and returns
the closed answer on any error: `false` for a predicate, `null` for a lookup, `[]` for a list. A
missing table, a malformed id, a dropped connection — all mean "no relationship", never "yes". The
real Postgres reason is logged via `e?.cause?.message || e?.message`, because `e.message` on a
drizzle error is only the failed SQL.

**Effective-dated.** Every read takes `{ asOf }`. Omit it for now; pass the approval timestamp to ask
what was true then. That is the entire point of the row-per-edge design.

**Cycle-safe, three times over**, because a cycle is a request that never comes back and corrupt org
data is precisely what a first backfill produces:

1. the recursive query carries the path walked so far and refuses to re-enter it, so `A -> B -> A`
   stops at the repeat;
2. `depth < MAX_CHAIN_DEPTH` (12) caps the walk regardless;
3. the TypeScript loop reading the result tracks visited ids and stops.

**No N+1.** `getReportingChain()` and `isResponsibleFor()` are each a *single* recursive CTE, not a
loop of per-level lookups. The user-id wrappers cost one extra constant-time query, never one per row.

### `isInitialized()` — why it is exported alongside everything else

The graph is **empty until the founder runs the backfill**, and an empty graph makes `getManager()`
return `null` for everybody. At the call site that is indistinguishable from "this person genuinely
has no manager". Those two must render differently:

```
isInitialized() === false                        ->  "Organization Graph not yet initialized"
isInitialized() === true, getManager() === null  ->  "No reporting manager on record"
```

A screen showing the second when the first is true is telling every employee they report to nobody.

### **There is no role-name fallback, and there must never be one**

If the graph is empty and this module answered "is a department head" from
`users.role = 'department_head'`, every screen would look like it worked — and the per-row
relationship would have silently become a per-user grant again, handing every manager authority over
every employee. That is the regression Phase 1 spent its budget removing, and it is the single
easiest way to undo this work.

When there is no data, the honest answer is `isInitialized() === false`.

---

## The compatibility layer

```ts
getManagerCompat(employeeId, { asOf })                  // -> { value, source }
userIsReportingManagerCompat(userId, employeeId, opts)  // -> { value, source }
// source: 'graph' | 'legacy-column' | 'none'
```

It reads `hr_employees.reporting_manager_id` — **an existing data column**, holding an id an
administrator typed into the Employment tab of `/admin/hr/employees/[id]`. It is a per-*row* fact
("this employee's manager is that person"), which is the same shape as a graph edge and can be read
as one.

It does **not** read `users.role`. That distinction is the whole point. A role name is a per-*user*
label; used as a relationship it makes every manager a manager of everyone. **Reading the data
column is migration; reading the role would be the regression.**

When it engages: **only when `isInitialized()` is false** — the graph has no rows at all. A graph
that *is* populated but has no manager for this person correctly answers "no manager" and does not
fall back. If it fell back there, deleting a wrong edge would silently restore the stale column
value.

**How to remove it:** after the backfill, when `db/org-graph-validate.sql` section 2 returns no rows,
delete the compatibility section and point its callers at `getManager()` /
`userIsReportingManager()`. Nothing else depends on it. The `source` field is what makes that
verifiable from a screen — **if any surface still says `legacy-column` after the backfill, it is not
finished.**

---

## Founder commands — production execution is yours, not the agent's

Nothing below was run. No database was connected to during this phase.

```bash
# 0. Backup / point-in-time restore marker. Steps 2 and 3 write rows.

# 1. Create the tables (or skip — the app bootstraps them on first use)
psql "$DATABASE_URL" -f db/org-graph-schema.sql

# 2. Seed reporting lines + primary department assignments from the legacy column. Idempotent.
psql "$DATABASE_URL" -f db/org-graph-backfill.sql

# 3. Check it. READ THE OUTPUT — sections 2-7 should all return zero rows.
psql "$DATABASE_URL" -f db/org-graph-validate.sql

# 4. OPTIONAL and DELIBERATE — department heads, a one-time translation of
#    users.role + users.assigned_department_id into data. Read the file header first,
#    run its SECTION A (read-only) and check A3 returns nothing, then run SECTION B.
psql "$DATABASE_URL" -f db/org-graph-backfill-department-heads.sql

# 5. Undo, if needed. Open the file and set ONE stage's `confirm := TRUE`.
psql "$DATABASE_URL" -f db/org-graph-rollback.sql
```

**What "done" looks like:** validation section 1 shows `open_reporting_edges` equal to
`employees_with_manager_column` minus the exceptions listed in section 2, and sections 2–7 all return
zero rows.

---

## Verification status — what was checked and what was not

**Checked in the worktree** (`c:/Users/user/Projects/edurankai-phase36`, branch
`phase3-6/implementation`):

* `npx astro check --minimumSeverity error` -> **194 errors, exactly the baseline.** Zero attributable
  to any file in this phase.
* `npm run build` -> reaches *"prerendering static routes"* and prints **"Complete!"**, run with a
  placeholder `DATABASE_URL` pointing at `127.0.0.1` so no real database was reachable.

**NOT VERIFIED — no browser and no database were available, so none of this was observed:**

* No SQL in `db/` has been executed anywhere. The backfill, validation and rollback files are
  **unrun**. Their syntax has been read, not parsed by Postgres.
* No function in `src/lib/org-graph.ts` has ever executed. Every query is unproven against a live
  schema.
* The self-bootstrapping DDL has never created a table.
* The data-modifying CTE in `supersedeReportingManager()` relies on the partial unique index being
  evaluated against the closing row within the same statement. That reasoning is stated in the code
  and **has not been observed to hold**. Exercise it against a non-production database first.
* The recursive-CTE cycle guard has never been run against cyclic data.
* No responsive or runtime claim is made: there is no UI in this phase.

Reported success and observable result are not the same thing. Nothing in this phase has an
observable result yet, by design.

---

## What comes next, and in what order

1. **Run the backfill and read the validation output.** Everything after this depends on the graph
   having trustworthy data.
2. **Build the admin surface** — view and edit relationships, and an org chart. It must call
   `openRelationship()` / `supersedeReportingManager()` rather than inventing its own `INSERT`, or
   the append-only guarantee stops holding.
3. **Migrate consumers one at a time**, each verified on the live site before the next:
   `hr-leave.ts pendingLeaveForApprover`, `hr-wallet.ts approverRole` and
   `pendingWithdrawalsForApprover`, `workforce/composer.ts`, `workforce/loaders.ts`,
   `employee-tasks.ts`. All of them currently compare `reporting_manager_id::text` to a user id.
4. **Retire `department.lead`.** `src/lib/auth/permissions.ts` documents why it could not be removed:
   *"THE ORGANISATIONAL DATA DOES NOT EXIST."* After step 4 of the founder commands, that has stopped
   being true. Point `requireTeamLead()` at `isDepartmentHead()` **first**, verify on the live site
   that the same people can open the same screens, and only then delete the key. Keep the population
   identical at every step.
5. **Delete the compatibility layer** once validation section 2 is empty and no surface reports
   `source: 'legacy-column'`.
6. **Then, and only then**, consider dropping `hr_employees.reporting_manager_id`.
