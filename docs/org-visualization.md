# Phase 5 — Organization Visualization

A reachable page, not a library. `/portal/organization` draws the Organization Graph that Phase 3B
shipped inactive, and it is the first surface in this product that calls it.

**Nothing here is activated.** No table is created by this phase, no relationship is written, no
capability is invented and no backfill is run. The graph is still empty until the founder runs
`db/org-graph-backfill.sql`, and until then this page says so in as many words.

---

## What shipped

| File | What it is |
| --- | --- |
| `src/lib/org-chart.ts` | The read model. Scope resolution + seven view builders. Read-only, fail-closed. |
| `src/components/workforce/OrgNode.astro` | One person and everyone under them. Recursive, server-rendered, native `<details>`. |
| `src/pages/portal/organization.astro` | The page: view tabs, search, department filter, empty states. |
| `src/lib/workforce/navigation.ts` | One new destination (`organization`) so the page is reachable from the workspace drawer. |
| `docs/org-visualization.md` | This file. |

No schema, no backfill SQL, no rollback SQL: this phase adds no storage. The tables, backfill,
validation and rollback all belong to Phase 3B and are unchanged — see `docs/org-graph.md`.

---

## The three layers, and where this page sits

| Layer | Question | Where it is answered |
| --- | --- | --- |
| 1 — Organization | who is responsible for whom | `src/lib/org-graph.ts`, per **row** |
| 2 — Authorization | what a user may do | `src/lib/auth/permissions.ts`, per **user** |
| 3 — Workflow | how work moves | elsewhere |

`org-chart.ts` holds no capability, grants nothing and denies nothing. It asks **one** Layer 2
question (`ctx.holds('employee.manage')`, through the composition the page already built) and **one**
Layer 1 question (does the graph contain a `department_head` edge whose subject is this employee),
and then narrows a query. There is no second authorization engine here.

**No new capability was invented.** `employee.manage` already means "may administer employee
records" — it is what `requireHr()` admits on and what gates `/admin/hr/employees`, where every one
of these people is already listed by name. Reusing it means this page changes who may see what by
exactly nothing. Minting an `org.view.all` key would have required granting it to somebody, and that
is a policy decision for the founder, not for a build.

---

## Scoping — resolved per viewer, enforced in the query

`resolveOrgViewerScope(userId, holds)` returns one of four scopes, in this order:

| Order | Test | Scope | What is queried |
| --- | --- | --- | --- |
| 1 | `isInitialized()` is false | — | nothing. "Organization Graph not yet initialized". |
| 2 | holds `employee.manage` | `full` | the whole graph |
| 3 | a `department_head` **edge** in the graph names them | `departments` | those departments' subtrees |
| 4 | an `hr_employees` row is linked | `self` | their own reporting line and their direct reports |
| 5 | none of the above | `none` | nothing, with an explanation |

The order matters. An empty graph is not a permission problem and is not dressed as one: everybody
gets the same screen at step 1, whatever they hold.

### The department head test is a GRAPH read, not a role read

```sql
SELECT DISTINCT r.scope_id::text
  FROM org_relationships r
 WHERE r.type = 'department_head'
   AND r.scope_type = 'department'
   AND r.subject_employee_id = $1::uuid
   AND r.status = 'active'
   AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now())
```

`users.role` is not read. `users.assigned_department_id` is not read. An account labelled
`department_head` with no edge in the graph **is not a department head on this page**. That is the
whole of Phase 1's work, and reintroducing the role name here would have looked exactly like it
worked.

### An unentitled branch is ABSENT FROM THE QUERY

`inScope(alias, scope)` is AND-ed into every people query in `org-chart.ts`:

* `full` → `TRUE`
* `departments` → `alias.department_id::text IN (…) OR alias.id = <viewer>`
* `self` → `alias.id = <viewer>`
* anything unresolvable → `FALSE`

Nothing in `organization.astro` hides a person. There is no `display:none` on a node, no
`aria-hidden` over a branch, and no filtering in the template — because a person the viewer may not
see was never fetched, never serialised and is not in the HTML at all.

Two details that fall out of that and are easy to get wrong:

* **The department filter narrows, it never substitutes.** `?dept=` is validated against
  `scopeDepartmentOptions(scope)` and dropped if it is not already in scope. A filter that replaced
  the scope would be a scope chosen by the person browsing.
* **A subtree root is whoever has no in-force manager *who is also in scope*.** A department member
  whose manager sits outside the department becomes a root of the department's own chart, and that
  manager is not fetched. Without the second half of that clause the query would have had to read
  the manager in order to decide not to show them.
* **An out-of-scope `?focus=` is ignored, not refused.** "That person exists but is not yours to
  see" is itself a disclosure.

---

## The empty state is the default path

Until the backfill runs, this is what the page **is**. Three different sentences, three different
causes, and confusing any two of them is how an org chart lies:

| Condition | Heading |
| --- | --- |
| `isInitialized()` false | **Organization Graph not yet initialized** — with a line saying a one-time backfill fills it, and that nothing is guessed from job titles or account settings. |
| initialized, viewer has no employee record | **You are not on the organization graph** |
| initialized, viewer has a record, no edges name them | **No reporting relationship recorded for you** |
| initialized, teams table empty | **No teams recorded** — teams live in their own table; this is not the graph being empty. |

`selfLine()` returns **zero** nodes when a person has neither a manager nor a report, deliberately: a
one-person "hierarchy" looks like an answer, and an empty state is the true sentence.

**There is no role-name fallback and there must never be one.** When the graph is empty the page does
not reach for `hr_employees.reporting_manager_id`, does not reach for `users.assigned_department_id`,
and does not draw a chart out of role names. A chart drawn from a fallback is indistinguishable from
a chart drawn from data, which is exactly why the fallback is the dangerous option rather than the
kind one.

---

## The seven views

| `?view=` | What it draws | Source |
| --- | --- | --- |
| `chart` | everyone in scope, arranged by reporting lines | one recursive query |
| `reporting` | one person's line: up to the top, plus their direct reports | `getReportingChain()` + `getDirectReports()` |
| `department` | departments, the head **from the graph**, members **from each person's own record** | two queries |
| `team` | teams and their recorded members | `org_teams` + `org_employee_assignments` |
| `delegation` | `temporary_delegate` edges in force | edge list |
| `approval` | `approval_owner` edges, by domain | edge list |
| `mentorship` | `mentor` edges | edge list |

Two of these carry a claim that must not drift:

* **Approval ownership says where a request ROUTES. It does not say who may decide it.** That is
  Layer 2's answer, from `permissions.ts`, and this page must never be read as granting it.
* **Mentorship confers no authority.** `mentor` is deliberately absent from
  `RESPONSIBILITY_TYPES` in `org-graph.ts`, and the page's own copy says so.

The department view keeps its two sources visibly apart: the head is a relationship row, membership
is `hr_employees.department_id` — a fact on the person's own row, labelled "on record" on screen.
Nothing infers a head from a membership or a membership from a head.

---

## Why `org-chart.ts` contains SQL, when the rule is "consume org-graph.ts"

Everything `org-graph.ts` can already answer is asked of it: `isInitialized()`,
`employeeIdForUser()`, `getReportingChain()`, `getDirectReports()`, `getManager()`, `getMentor()`,
`getDelegates()`. **Not one relationship rule is restated.**

What `org-graph.ts` deliberately does not offer is **set assembly** — "every open reporting edge
under these roots", "every department this employee heads", "every delegation in force in this
department". Its API is per-person by design, and building a chart out of per-person calls is an N+1
that gains a query for every employee hired, on a page that renders on a phone.

So the set-shaped reads live here under three rules:

1. **The in-force predicate is copied exactly** from `org-graph.ts`'s private `inForce()`:
   `status = 'active' AND effective_from <= at AND (effective_to IS NULL OR effective_to > at)`.
   Half-open, same as there. **This is a real coupling: if that rule changes, `org-chart.ts` must
   change with it.** It is written down rather than assumed.
2. **No predicate here may be wider** than the equivalent `org-graph.ts` answer.
3. **Nothing here writes.** No INSERT, no UPDATE, no DDL beyond the shared `ensureOrgGraphSchema()`
   bootstrap `org-graph.ts` already runs on every call.

House rules observed throughout: postgres-js returns plain arrays (`rows()` normalises, never
`r.rows[0]`); the real Postgres reason is logged from `e?.cause?.message || e?.message`; every
`const` is declared above its first use; department ids are compared `::text` and **never** cast
`::uuid`, because `departments.id` is a varchar slug in `schema.ts` and a UUID in `hr-schema.sql`.

### Cycle and size guards

* The downward walk carries the path it has taken and refuses to re-enter it, **and** caps at
  `MAX_TREE_DEPTH` (= `MAX_CHAIN_DEPTH`, 12). A cycle here is a request that never returns, and
  corrupt org data is exactly what a first backfill produces.
* `MAX_CHART_NODES` is 400, `MAX_EDGE_ROWS` 300. Truncation is **reported on the model** and printed
  on screen; it is never silent. Results are ordered by depth ascending so the tail that gets cut
  can never orphan a child whose parent survived.
* `unattached` counts active employees with no reporting edge in either direction. Without that
  number a half-backfilled graph looks like a complete company.

---

## Rendering

* **Server-rendered tree.** `OrgNode.astro` recurses into itself; the whole tree is HTML before it
  reaches the device.
* **Expand/collapse with no JavaScript.** A node with reports is a native `<details>` and its row is
  the `<summary>` — a real disclosure widget, keyboard operable, correctly announced, working before
  hydration and on the offline shell.
* **Client JS added: 880 bytes. That is the whole weight of this page.** One `is:inline` script,
  emitted verbatim into the document — `is:inline` is not processed, so its comments ship too; 597
  bytes of the 880 is code. It produces **no entry in the client bundle** (confirmed against the
  build output) and no extra request. It adds Expand-all / Collapse-all and nothing else: the
  buttons are rendered `hidden` and the script un-hides them, so a browser without JavaScript never
  shows a control that does nothing. The page is fully usable without it.
* **No external chart library.** The only graphic is one inline monochrome SVG chevron. No emoji
  anywhere.

### Mobile first — 360px is the design width

About nine in ten of these people are on a phone.

* Indentation is 12px per level with a hairline rule, not 24px: at 360px and eight levels deep, 24px
  would leave 168px for a name.
* Names **wrap**, never truncate. "Sudhanshu Ram…" is a different person.
* Every summary row, button, field and link clears the 44px touch floor.
* `html, body { overflow-x: hidden }` and **two** dedicated scrollers: the view tabs
  (`.tabs { overflow-x: auto }`) and each tree (`.treebox { overflow-x: auto }`). A deep tree scrolls
  inside its own box; the page never scrolls sideways.
* No POST handler. Search and filters are a GET form, so state is in the URL, shareable, and
  survives the back button — and there is no handler above the declarations to trip the
  const-hoisting trap that has taken pages down on this project.

---

## Reachability

`src/lib/workforce/navigation.ts` gains one destination:

```
key 'organization' → /portal/organization, group 'record', bar: null (drawer only)
audience: worksHere   (an employee record, or admin.access)
```

`bar: null` keeps the four ranked bottom tabs exactly as they were. The audience is **strictly
narrower** than the page's own gate ("signed in"), the same discipline Messages, Meet and Mail
follow. It is deliberately **not** gated on the whole-graph capability: that would offer the page
only to HR and hide it from every employee entitled to see their own reporting line, which is most
of the people it was built for. The page scopes itself per viewer in the query; the nav entry only
decides whether the door is worth showing.

`NAV_BACKLOG['reports.direct']` was updated rather than deleted: a reporting manager can now *see*
their reports here, and still has no surface where their reports' tasks, leave and hours appear
together. That gap is real and stays recorded.

---

## Verification status — what was checked, and what was not

**Checked, in the worktree:**

* `npx astro check --minimumSeverity error` → **194 errors**, identical to the baseline. No error in
  `org-chart.ts`, `OrgNode.astro`, `organization.astro` or `navigation.ts`.
* `npm run build` → reached "prerendering static routes" and printed **Complete!**

**NOT VERIFIED — there is no browser and no database in this environment, and no claim below has
been observed:**

* Every runtime and data claim. No query in `org-chart.ts` has been executed against any database.
  The SQL is reviewed, not proven — the recursive CTE, the `LATERAL` head lookup and the
  `array_length(path, 1) - 1` parent projection in particular.
* Every responsive claim. The 360px layout, the 44px touch targets, the two scroll containers and
  the absence of page-level horizontal scroll are all *designed for* and none are *measured*.
* The empty-state path is the only one that can be reasoned about with confidence today, because the
  graph is empty in production until the backfill runs — but it has not been loaded either.
* Accessibility: the disclosure semantics come from native `<details>`, which is the reason they
  were chosen, but no screen reader has been run against this page.

**To verify, after deploying:** open `/portal/organization` as an account with `employee.manage`,
then as an ordinary employee. Before the backfill both should read "Organization Graph not yet
initialized". After `db/org-graph-backfill.sql` and a clean `db/org-graph-validate.sql`, the first
should see a chart and the second should see their own line and nothing else — confirm by View
Source that no other employee's name is in the document.

---

## What this phase deliberately did not do

* **No writes.** Relationships are recorded by HR; this page reads. `openRelationship()`,
  `supersedeReportingManager()` and the rest are still wired to nothing, which is Phase 3B's stated
  position and not this phase's to change.
* **No new capability, no new table, no DDL.**
* **No person detail page.** `personDetail()` exists in `org-chart.ts` and is exported for the
  surface that should follow; nothing renders it yet, and it is named here rather than left as a
  quiet unused export.
* **No pan-and-zoom canvas chart.** A node-and-edge canvas needs a chart library or a large amount
  of hand-written SVG layout, neither of which reads well at 360px or degrades without JavaScript.
  An indented, collapsible tree is the honest shape for this audience.
