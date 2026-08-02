# Workforce OS — Master Specification

**Software Design Specification and Product Requirements Document**

| Field | Value |
|---|---|
| Document | `docs/workforce-os/WORKFORCE_OS_MASTER_SPEC.md` |
| Version | 1.0.0 |
| Status | Approved for implementation. No section is a placeholder. |
| Date | 2026-08-02 |
| Supersedes | Nothing. Companion to `docs/workforce-os-architecture.md` (the capability inventory), which this document consumes as its evidence base. |
| Scope | The signed-in staff experience at `/portal/*`. Does not change `/admin/*`, `/aquintutor/*`, or any public route. |
| Method | Source-only. No database connection was opened, no `.env*` file was read, no script that opens a connection was run. |

---

## The problem this document exists to solve

`/portal/employee` is architecturally an intern portal, and every authenticated user gets it. The
page requires nothing but a session (`src/pages/portal/employee.astro:16-17`) and then leads with
Credit Hours, Attendance %, Days In, Clock In and Leave. Those are internship concepts. A founder, a
CEO, a research lead, a staff engineer and a volunteer all sign in and are shown a credit-hours
progress bar measuring an engagement they are not in.

The intern functionality is not wrong. It is **correct, for interns**, and it is the only surface in
the product that tells an intern the credit position their completion letter will be built from
(`src/lib/credit-ledger.ts` drives both). It does not get deleted. It moves behind a composer, so it
renders for the intern workspace and nowhere else.

---

## The discipline this document is written under

**Every widget states its data source and whether that source exists today.**

Three production outages this week came from code querying a column that existed only in someone's
mental model: `hr_employees.work_email`, `hr_task_log`, `meet_rooms.scheduled_at`,
`users.identity_verified` / `consent_given_at`, and `users.full_name` (the table has `name`). Five
instances. A widget list that does not say where its numbers come from is a wish list, and this
project has already lost three days to code trusting a schema that was not real.

So every widget in Section 13 carries one of three markers:

| Marker | Meaning |
|---|---|
| **Buildable-now** | The table and columns exist in production and a real code path writes them. The widget can be implemented in the next commit. |
| **Needs-migration** | The widget is well-specified but its table or column does not exist, or exists in two contradictory shapes. Named DDL is required first, delivered per Section 20. |
| **No-data-source** | Nothing in the platform can answer this. The widget is **not built and not rendered** — no placeholder, no zero, no "coming soon". See DDR-004. |

Where a source exists but can hold no rows yet, the widget carries an **Empty until** note. That
state is real and is different from both "no data source" and "you have nothing" — see DDR-007.

Schema claims below were verified against `src/lib/db/schema.ts` and against **writers** (INSERT
column lists and `UPDATE ... SET` clauses), never against `db/hr-schema.sql`, which describes tables
that do not exist in that form.

---

## Table of contents

1. [Vision](#1-vision)
2. [Workforce Experience Engine](#2-workforce-experience-engine)
3. [Dashboard Composition Engine](#3-dashboard-composition-engine)
4. [Role-Based Workspace Architecture](#4-role-based-workspace-architecture)
5. [Universal Widget Framework](#5-universal-widget-framework)
6. [Workspace Composer](#6-workspace-composer)
7. [Dashboard Configuration Engine](#7-dashboard-configuration-engine)
8. [Workforce Context Engine](#8-workforce-context-engine)
9. [Dynamic Home Experience](#9-dynamic-home-experience)
10. [Dashboard Decision Flow](#10-dashboard-decision-flow)
11. [Widget Registry](#11-widget-registry)
12. [Widget Visibility Rules](#12-widget-visibility-rules)
13. [Dashboard Permission Matrix](#13-dashboard-permission-matrix)
14. [Personalization](#14-personalization)
15. [AI Workspace Personalization](#15-ai-workspace-personalization)
16. [The workspaces](#16-the-workspaces)
17. [Future Workforce Categories](#17-future-workforce-categories)
18. [Migration Strategy](#18-migration-strategy)
19. [Compatibility Matrix](#19-compatibility-matrix)
20. [Acceptance Criteria](#20-acceptance-criteria)
21. [Testing Checklist](#21-testing-checklist)
22. [Implementation Tracker](#22-implementation-tracker)
23. [Known Gaps](#23-known-gaps)
24. [Design Decision Records](#24-design-decision-records)
25. [Changelog](#25-changelog)

---

## 1. Vision

### 1.1 The one-sentence statement

**One home page, composed per person from what the platform can actually answer about them, so that
the first screen after sign-in is about their work rather than about somebody else's engagement
model.**

### 1.2 What "Workforce OS" means here, and what it does not

It means: a **composition layer**. Every capability the composed page shows already exists as a
library function or is named in Section 18 as a migration. Workforce OS adds no new business logic
to tasks, leave, attendance, wallets or credit hours. It decides which of those to show, in what
order, to whom.

It does **not** mean a new console, a second design system, a rewrite of `/portal/employee`'s
existing behaviour, or a claim that EduRankAI performs work it does not. The platform is the
technology; accredited partners award credentials; internships are unpaid unless a stipend is
explicitly recorded. Nothing in this document changes that.

### 1.3 Principles, in force order

1. **Server-resolved.** The workspace, the widget set and every gate are decided in the frontmatter
   before a byte of HTML exists. No client-side role branch. (DDR-002)
2. **Data-source-first.** A widget without a verified writer is not built. (DDR-004)
3. **Empty and failed are different sentences.** Every loader reports whether it ran. (DDR-007)
4. **Nothing is deleted.** Intern widgets move; they do not disappear. (DDR-003)
5. **Roles are data, not `if` statements.** (DDR-001)
6. **Fail closed, and explain.** The pattern `src/lib/auth/workspace-access.ts` already sets: a
   denial carries a heading and a sentence a person can act on.
7. **Mobile-first at 360px.** The audience checks this between jobs, on a phone, in daylight.
8. **Private data never enters the composer.** Health, government IDs, salary and bank details are
   out of scope for every widget in this document. (DDR-010)

### 1.4 Success, stated so it can be falsified

A super_admin, an `hr` user, a `department_head`, an engineer with no special role and an intern each
sign in to `/portal/employee`. Five different first screens render. Exactly one of them shows a
credit-hours progress bar, and it is the intern's. Every number on every screen traces to a table
this document names, and no card on any screen is empty because its source does not exist.

---

## 2. Workforce Experience Engine

The Workforce Experience Engine is the name for the whole subsystem: four cooperating parts, each a
module, each independently testable.

```
                    Astro.locals.user  (session, already resolved by middleware)
                              |
                              v
        +-------------------------------------------+
        |  8. Workforce Context Engine               |   src/lib/workforce/context.ts
        |     resolveWorkforceContext(user)          |
        |     - reuses resolveWorkspace()            |
        |     - reuses resolvePermissions()          |
        |     - adds seniority + function + tenure   |
        +-------------------------------------------+
                              |  WorkforceContext
                              v
        +-------------------------------------------+
        |  4. Role-Based Workspace Architecture      |   src/lib/workforce/workspaces.ts
        |     resolveWorkspaceKind(context)          |
        |     deterministic, first match wins        |
        +-------------------------------------------+
                              |  WorkspaceKind
                              v
        +-------------------------------------------+
        |  7. Dashboard Configuration Engine         |   src/lib/workforce/config.ts
        |     WORKSPACE_LAYOUTS[kind] -> widget ids  |
        |     data, not branches                     |
        +-------------------------------------------+
                              |  widget ids, in order
                              v
        +-------------------------------------------+
        |  6. Workspace Composer                     |   src/lib/workforce/composer.ts
        |     for each id: registry lookup ->        |
        |       availability -> visibility ->        |
        |       permission -> load -> ok?            |
        +-------------------------------------------+
                              |  ComposedDashboard
                              v
        +-------------------------------------------+
        |  9. Dynamic Home Experience                |   src/pages/portal/employee.astro
        |     renders slots; never decides anything  |
        +-------------------------------------------+
```

### 2.1 Module boundaries and why they are drawn here

| Module | Owns | Must never |
|---|---|---|
| `context.ts` | Reading identity, engagement, seniority, function, permissions | Decide a layout; read any widget's data |
| `workspaces.ts` | The single ordered classification function | Query the database (it is pure over a context) |
| `config.ts` | Which widget ids belong to which workspace, in order | Contain a data query or a permission check |
| `registry.ts` | The widget catalogue: id, title, gate, loader, availability | Know about workspaces |
| `composer.ts` | Running the pipeline and reporting per-widget outcome | Contain a workspace name or a widget-specific rule |
| `employee.astro` | Rendering | Branch on role, permission or department |

`workspaces.ts` being **pure** is what makes Section 21's role matrix testable without a database.

### 2.2 Reuse contract — what this engine calls and never reimplements

| Existing module | Function used | Used for |
|---|---|---|
| `src/lib/auth/workspace-access.ts` | `resolveWorkspace`, `requireEmployee`, `employeeFilter`, `departmentFilter`, `DEPARTMENT_COVERAGE_NOTICE` | Employee record, department, `isIntern`, `isTeamLead`, `isHr`, `isActive`, and the two WHERE-clause scopers |
| `src/lib/auth/registry.ts` | `resolvePermissions`, `holdsPermission`, `hasPermission` | The capability set, including custom roles and `WILDCARD` |
| `src/lib/auth/permissions.ts` | `can`, `canAccessSection`, `PERMS_BY_ROLE` | Built-in role fallback and section gating |
| `src/lib/employee-tasks.ts` | `myTasksView`, `listBoard`, `listTasksForTeam`, `taskCounts` | Every task widget |
| `src/lib/hr-leave.ts` | `pendingLeaveForApprover`, `listLeave`, `getBalances` | Leave widgets |
| `src/lib/hr-wallet.ts` | `pendingWithdrawalsForApprover`, `getBalance`, `listTxns` | Money widgets |
| `src/lib/credit-ledger.ts` | `ledgerFor`, `termsFor` | Credit widgets — **intern workspace only from now on** |
| `src/lib/work-groups.ts` | `visibleGroupsFor` | Community widget |
| `src/lib/hr-onboarding.ts` | `listDocs` | Joining-document widgets |
| `src/lib/hr-classification.ts` | `ensureClassificationSchema`, `CLASSIFICATIONS` | Volunteer / consultant / contractor detection |
| `src/styles/workforce.css` | tokens | All widget styling |
| `src/components/workforce/*` | 11 components incl. `BottomNav` (`items` override), `EmptyState`, `StatusBadge`, `PriorityFlag`, `PermissionGate` | All widget chrome |

Anything not in this table is either specified as new in Section 22 or is out of scope.

---

## 3. Dashboard Composition Engine

### 3.1 The contract

```ts
// src/lib/workforce/composer.ts
export interface ComposedWidget {
  id: string;
  title: string;
  /** Slot the layout placed it in. */
  slot: 'attention' | 'primary' | 'secondary' | 'quiet';
  /** The loader's payload. Shape is the widget's own; the composer never inspects it. */
  data: unknown;
  /** FALSE means the read did not happen. The widget renders its could-not-read sentence,
   *  never its empty state. This is the single most important field in the interface. */
  ok: boolean;
  /** True when the read ran and legitimately returned nothing. */
  empty: boolean;
  /** Present only when ok === false. Already reduced to a human sentence; never a stack trace. */
  problem: string | null;
}

export interface ComposedDashboard {
  kind: WorkspaceKind;
  /** Why this workspace, in one clause. Rendered in the workspace switcher, and logged. */
  because: string;
  widgets: ComposedWidget[];
  /** Ids dropped, with the reason. Never rendered to the user. For /admin diagnostics only. */
  dropped: Array<{ id: string; reason: 'no-data-source' | 'not-available' | 'not-visible' | 'not-permitted' }>;
  /** True when at least one widget failed to read. Suppresses any all-clear headline. */
  degraded: boolean;
}
```

### 3.2 The pipeline, per widget, in order

1. **Registry lookup.** Unknown id: dropped, logged as a configuration error. A layout naming a
   widget that does not exist is a bug in `config.ts`, never a runtime surprise.
2. **Availability.** `widget.availability === 'no-data-source'` is dropped before anything else runs.
   This is a compile-time-visible constant, not a query. (DDR-004)
3. **Visibility.** `widget.visibleFor(context)` — a pure predicate over the context. No I/O.
4. **Permission.** `widget.gate` evaluated per Section 13. Failure drops the widget silently; it does
   not render a locked card. A greyed-out card is a map of the organisation.
5. **Load.** `widget.load(context)` runs inside the composer's own try/catch. A throw becomes
   `ok:false` with a sentence; it never propagates to the page.
6. **Collect.** Ordered by the layout, not by completion time.

### 3.3 Concurrency and cost

Loaders run with `Promise.allSettled` in one batch per slot, so a slow widget delays its slot and not
the page. Every loader must be a **read**. A loader that writes is a defect: the composer runs on
every page load including a bot's, and `ensureOnce`-style bootstrapping belongs in the owning library,
not in a dashboard loader.

Budget: **12 widgets maximum per composed page**, and **no more than 14 queries**. Above that, a
phone on a slow connection is being asked to wait for cards below the fold. `config.ts` enforces the
cap at module load with a thrown error, so a layout that exceeds it fails the build rather than the
user.

### 3.4 Failure semantics

| Condition | Result |
|---|---|
| One loader throws | That widget renders "we could not read this just now"; the rest of the page is unaffected; `degraded = true` |
| Context resolution throws | `requireEmployee`'s existing denial is rendered. No partial dashboard. |
| `resolvePermissions` returns `degraded:true` | Every permission-gated widget is dropped. An empty permission set from a failed lookup must never be read as "this person may do nothing, so show them the intern page". |
| Layout is empty after filtering | The Universal Baseline (Section 7.4) renders. There is no state in which a signed-in employee sees a blank page. |

---

## 4. Role-Based Workspace Architecture

### 4.1 The ten workspaces

| Kind | For | Primary question it answers |
|---|---|---|
| `executive` | Founders and C-Level | Is the organisation healthy, and what needs my signature? |
| `leadership` | Function leads | Where is my function against its work, and who is blocked? |
| `management` | Department heads and anyone with direct reports | Who is waiting on me, and how is my team doing? |
| `professional` | Senior, Mid and Junior individual contributors | What is on my plate today? |
| `academic` | Teaching and course-authoring roles | What am I teaching, and who is waiting on me? |
| `research` | Research, quantum and safety functions | What am I working on, and what does my group need? |
| `engineering` | AI, infrastructure, data, product, data-engine, form-DB | What is assigned, blocked, and waiting for my review? |
| `operations` | People, legal-finance-strategy, growth | What queues are mine, and what is aging? |
| `volunteer` | Unpaid contributors | What did I commit to, and what is next? |
| `intern` | Interns and apprentices | What is my credit position, and what is due? |

### 4.2 The classification signals that exist today

This is the whole input set. Nothing outside this table may influence workspace resolution.

| Signal | Column / source | Writer | Status |
|---|---|---|---|
| Built-in role | `users.role` (`user_role` enum, 11 values, `schema.ts:51`) | `/admin/users` | **Exists.** Enum has no `intern`, `employee` or `campus_ambassador` value |
| Lead department | `users.assigned_department_id` varchar(50) (`schema.ts:54`) | `/admin/users` | **Exists** |
| Account active | `users.is_active` | multiple | **Exists** |
| Capability set | `resolvePermissions()` over `role_permission_grants`, `role_permissions`, `user_role_assignments` | `/admin/team/roles`, registry API | **Exists**, self-CREATE (`registry.ts:268-341`) |
| Employee record | `hr_employees` via `resolveWorkspace()` | 3 creation paths | **Exists** |
| Engagement classification | `hr_employees.classification` varchar(40) default `'permanent'` | `/admin/hr/classification/index.astro:22` — a real UPDATE | **Exists.** Self-bootstrapping ALTER at `hr-classification.ts:15`. Values: `permanent`, `fixed_term`, `intern`, `contractor`, `eor`, `consultant`, `volunteer` |
| Engagement route | `hr_employees.engaged_via` | same writer | **Exists** |
| Employment type | `hr_employees.employment_type` TEXT, free | 3 creation paths + edit form (8 options) | **Exists**, written inconsistently (`'Internship'` vs `'full_time'`) |
| Designation | `hr_employees.designation` TEXT, free | 3 creation paths + edit form | **Exists**, free text |
| Own department | `hr_employees.department_id` | **one** writer (`src/lib/hr/sync.ts:70`) | **Exists but sparse.** NULL for everyone added by hand |
| Seniority | `hr_employees.application_id` then `applications.role_id` then `roles.level` (`role_level` enum: `C-Level`, `Lead`, `Senior`, `Mid`, `Junior`, `Intern`, `Apprentice`) | `application_id` written by `hr/sync.ts:60` and `hire-transfer.ts:34`; **not** by the manual add form | **Exists but sparse.** The only structured seniority signal in the database |
| Function | `roles.department_id` on the same join, or `hr_employees.department_id`, or `users.assigned_department_id` | as above | **Exists but sparse** |
| Reporting line | `hr_employees.reporting_manager_id` — holds a **`users.id`**, not an `hr_employees.id` | **one** writer (`admin/hr/employees/[id].astro:157`) | **Exists but sparse** |
| Derived flags | `isIntern`, `isTeamLead`, `isHr`, `isActive` from `workspace-access.ts` | derived | **Exists** |

**The live department slugs** (`scripts/seed.ts:35-49`, `departments.id` is `varchar(50)` — a slug,
never a UUID, and a `::uuid` cast throws):

`founders`, `exec`, `ai`, `data`, `infra`, `product`, `safety`, `research`, `quantum`, `psychology`,
`hr`, `legal`, `growth`, `dataengine`, `formdb`.

### 4.3 The resolution order

Deterministic, first match wins, evaluated top to bottom. Implemented once in
`src/lib/workforce/workspaces.ts` as a pure function over `WorkforceContext`.

| # | Kind | Condition | Signal status |
|---|---|---|---|
| 1 | `intern` | `classification === 'intern'` **or** `seniority in ('Intern','Apprentice')` **or** `workspace.isIntern` | Buildable-now |
| 2 | `volunteer` | `classification === 'volunteer'` | Buildable-now |
| 3 | `executive` | `seniority === 'C-Level'` **or** `users.role === 'super_admin'` **or** `functionKey === 'exec'` | Buildable-now |
| 4 | `leadership` | `seniority === 'Lead'` | Buildable-now, sparse |
| 5 | `management` | `workspace.isTeamLead` (i.e. `users.role === 'department_head'` with an `assigned_department_id`) **or** `directReportCount > 0` | Buildable-now |
| 6 | `academic` | `users.role in ('teacher','partner','technical_moderator')` **or** `functionKey === 'psychology'` | Buildable-now |
| 7 | `research` | `functionKey in ('research','quantum','safety')` | Buildable-now, sparse |
| 8 | `engineering` | `functionKey in ('ai','infra','data','product','dataengine','formdb')` | Buildable-now, sparse |
| 9 | `operations` | `functionKey in ('hr','legal','growth')` **or** `workspace.isHr` | Buildable-now |
| 10 | `professional` | Anything else with an active employee record | Buildable-now — **the floor** |

`founders` is deliberately **not** an executive signal. It is the flagship intern programme
(`scripts/seed.ts:35`, "Sit inside the founding team") and its role catalogue contains
`Managing Intern` and `Product-Specific Intern` at level `Intern`. Rule 1 catches those correctly;
rule 3 would have mis-promoted them.

### 4.4 Why seniority is a *preference*, never a *requirement*

`roles.level` is reachable only through `hr_employees.application_id`, which the manual "Add
employee" form does not write (`admin/hr/employees/index.astro:67` — the column is absent from the
INSERT list). For anyone HR added by hand, seniority is `null`. The order above degrades cleanly:
rules 1, 2, 3 (via `super_admin`), 5, 6 and 9 all work without it, and rule 10 is the floor. **A
missing seniority signal produces the Professional workspace, never a blank page and never the intern
page.**

The corollary is a rule for the composer: **a null signal is never treated as a "no".** `seniority
=== null` must not satisfy `seniority !== 'C-Level'` in any widget predicate. Section 12.3 states this
as a lint rule.

### 4.5 The `isIntern` false positive, and the improvement

`workspace-access.ts:275` derives `isIntern` from `employment_type` or `designation` containing the
substring `intern`. A designation like "Internal Auditor" matches. The document notes the flaw and
notes it fails safe (more restriction, never more exposure).

Rule 1 above **improves** it by checking `classification === 'intern'` and `seniority` **first**.
Both are structured values from closed vocabularies. The substring test remains as the last arm,
because it is the only signal available for a hand-added record. Concretely: an Internal Auditor whose
classification has been set to `permanent` on `/admin/hr/classification` resolves to Professional, and
today resolves to Intern. That is a real fix for a real person, delivered by ordering rather than by
new schema.

**This does not change `intern-guard.ts`.** The guard that blocks interns from `/admin` and the
composer that gives them a workspace must never disagree about who is an intern — but the guard is
allowed to be stricter. If rule 1 is ever loosened, `intern-guard.ts:48-52` must be reviewed in the
same commit.

---

## 5. Universal Widget Framework

### 5.1 The widget interface

```ts
// src/lib/workforce/types.ts
export type WidgetAvailability = 'buildable-now' | 'needs-migration' | 'no-data-source';

export interface WidgetLoadResult<T = unknown> {
  ok: boolean;      // did the read HAPPEN
  empty: boolean;   // did it run and legitimately return nothing
  data: T | null;
  problem?: string; // human sentence, present only when ok === false
}

export interface WidgetDefinition<T = unknown> {
  id: string;                       // stable, namespaced: 'tasks.mine'
  title: string;                    // the card heading a person reads
  availability: WidgetAvailability; // Section 11. 'no-data-source' is never rendered.
  /** The migration that unblocks it. Required when availability is 'needs-migration'. */
  blockedBy?: string;
  gate: WidgetGate;                 // Section 13
  visibleFor: (ctx: WorkforceContext) => boolean;  // pure, no I/O
  load: (ctx: WorkforceContext) => Promise<WidgetLoadResult<T>>;
  /** Where this widget's own screen lives, for the card's action. Must be a route that OPENS. */
  href?: string;
  /** Rendering component. One per widget; no dynamic component names. */
  component: 'stat' | 'list' | 'attention' | 'progress' | 'roster' | 'link';
}
```

### 5.2 The five rules every widget obeys

1. **Report whether the read happened.** `ok:false` is not the same value as `empty:true`.
   `myTasksView()` already models this (`employee-tasks.ts:992` returns an `ok` flag precisely
   because `listMyTasks()` returns `[]` on failure and on emptiness alike).
2. **Never render a number you cannot stand behind.** If any input failed, the widget withholds its
   headline count. `/portal/employee` already does this for the attention count
   (`attentionCountShown`), and it is the behaviour being generalised.
3. **Scope in the WHERE clause.** Use `employeeFilter()` / `departmentFilter()`. Filtering after the
   query is not scoping — the row has already been read.
4. **Log the real reason.** Every catch logs `e?.cause?.message || e?.message`. `e.message` alone is
   just the failed SQL.
5. **Normalise postgres-js results.** `const rows = Array.isArray(r) ? r : (r?.rows || [])`. Never
   `r.rows[0]`.

### 5.3 The four component shapes

Only four render shapes exist. A widget that needs a fifth is a screen, not a widget, and belongs
behind an `href`.

| Component | Renders | Reused from |
|---|---|---|
| `attention` | The triage list: glyph, title, note, tone, priority | The existing `attentionRows` block in `employee.astro:747-869`, lifted into `src/components/workforce/AttentionList.astro` |
| `stat` | One to four figures with labels and an optional trend word | **New:** `src/components/workforce/StatTile.astro` |
| `list` | Up to five rows with a title, a meta line and an optional `StatusBadge` | `TaskCard`, `StatusBadge`, `PriorityFlag` |
| `progress` | A labelled bar with an honest null state ("no requirement recorded", never "0%") | The existing credit bar, lifted into `src/components/workforce/ProgressMeter.astro` |
| `roster` | People rows: name, designation, one status | `AvatarStack` |
| `link` | A titled card whose whole body is a route | `EmptyState` with `actionHref` |

`component: 'link'` exists so a capability with no *summarisable* number still reaches its screen
without inventing a metric. Wellness is the canonical case: it is a link and never a data widget.
(DDR-010)

### 5.4 Widget chrome

`src/components/workforce/WidgetShell.astro` (new) provides the heading, the optional action link,
the could-not-read sentence and the empty state, so no widget writes those three states by hand and
they cannot drift. It renders:

- **ok, not empty** — the widget body.
- **ok, empty** — `EmptyState` with the widget's own words.
- **not ok** — a fixed sentence naming what could not be read, in `--wf-danger-*` tones, with no
  count, no zero and no empty state.

### 5.5 Accessibility and density

- Every status carries **shape as well as hue** — the existing `StatusBadge` and `PriorityFlag`
  contract. A composed dashboard must triage correctly in greyscale.
- Glyphs are inline monochrome SVG. No emoji anywhere, including in seeds and notification bodies.
- Minimum target 44px, minimum body text `--wf-t-body` (14px).
- Widget order is DOM order. No CSS reordering, so the screen-reader sequence is the visual sequence.
- `prefers-reduced-motion` is respected by `workforce.css` already; no widget adds animation.

---

## 6. Workspace Composer

### 6.1 Entry point

```ts
// src/lib/workforce/composer.ts
export async function composeDashboard(
  user: WorkspaceUser | null | undefined,
  opts?: { preview?: WorkspaceKind }
): Promise<{ gate: SelfGate } & ({ dashboard: ComposedDashboard } | { dashboard: null })>;
```

Called as the **first statement of the frontmatter**, above the POST handler. `const` is not hoisted;
a handler reaching a later declaration has taken pages down in this repo before.

### 6.2 The order of operations, and why

```
1. requireEmployee(user)                 <- fails closed WITH a sentence, redirects if not signed in
2. resolveWorkforceContext(user, gate)   <- one pass, no module-scope cache
3. resolveWorkspaceKind(context)          <- pure
4. WORKSPACE_LAYOUTS[kind]               <- data lookup
5. applyPreferences(layout, prefs)       <- ordering only, never visibility (DDR-008)
6. run the pipeline (Section 3.2)
7. return
```

Step 1 first is load-bearing. `requireEmployee` is the only place that distinguishes "no record"
from "the lookup failed" from "two records share your address", and each is a different sentence to
the person reading the screen. Composing a dashboard before that gate would produce ten empty cards
where one clear explanation belongs.

### 6.3 The preview parameter

`opts.preview` lets `/admin/access-preview` render another workspace's **layout** — the widget ids and
their order — without loading anybody's data. It is accepted only when the caller has already
established authority; the composer does not check it, because a composer that trusts a parameter is
the shape of a scope bug. **`preview` never reaches a loader.** It short-circuits after step 4 and
returns ids only.

### 6.4 Nothing is cached at module scope

A cache in a long-lived server process is how one person's dashboard ends up rendered for another.
`resolveWorkspace()` already states this rule and this module inherits it. Per-request memoisation
inside a single `composeDashboard` call is fine and is how `resolvePermissions` is called once rather
than per widget.

### 6.5 The workspace switcher

A person may open any workspace **they already resolve to or a narrower one**, never a wider one. The
switcher is a link list rendered from `ALLOWED_ALTERNATES[kind]`:

| Resolved kind | May also open |
|---|---|
| `executive` | `leadership`, `management`, `professional` |
| `leadership` | `management`, `professional` |
| `management` | `professional` |
| every other kind | `professional` |
| `intern` | `professional` is **not** offered — see below |
| `professional` | nothing |

Switching changes the **layout**, never the **gates**. A `professional` widget opened by an executive
still runs its own permission check and its own scoping, so the switcher cannot be a privilege
escalation. It is a preference stored per Section 14, not a session claim.

An intern is not offered the Professional workspace because the intern layout is a strict superset of
what they can see plus the credit position, so the alternate would be a strictly worse screen with no
new capability. That is a product judgement, recorded here so it is not re-litigated as a bug.

---

## 7. Dashboard Configuration Engine

### 7.1 Layouts are data

```ts
// src/lib/workforce/config.ts
export interface WorkspaceLayout {
  kind: WorkspaceKind;
  label: string;              // "Executive workspace"
  /** One clause, rendered in the switcher and logged with the resolution. */
  because: string;
  attention: string[];        // widget ids, in order
  primary: string[];
  secondary: string[];
  quiet: string[];
  /** BottomNav items override. Reuses the existing `items` prop; no new component. */
  nav: Array<{ key: string; href: string; label: string; icon?: string }>;
}

export const WORKSPACE_LAYOUTS: Record<WorkspaceKind, WorkspaceLayout> = { /* Section 16 */ };
```

There is no `if (role === ...)` anywhere in this file, and there is no widget id in this file that is
absent from the registry. Both are asserted at module load:

```ts
// Fails the BUILD, not the request.
for (const layout of Object.values(WORKSPACE_LAYOUTS)) {
  const ids = [...layout.attention, ...layout.primary, ...layout.secondary, ...layout.quiet];
  if (ids.length > MAX_WIDGETS_PER_PAGE) throw new Error(`layout ${layout.kind} exceeds widget cap`);
  for (const id of ids) if (!WIDGETS[id]) throw new Error(`layout ${layout.kind} names unknown widget ${id}`);
}
```

### 7.2 The four slots

| Slot | Purpose | Cap | Position |
|---|---|---|---|
| `attention` | Things that will go wrong if ignored today | 1 widget | Top, above the fold at 360px |
| `primary` | The work itself | 3 | Immediately below |
| `secondary` | Position and context | 4 | Below |
| `quiet` | Reference, links, rarely-changing facts | 4 | Bottom |

The `attention` slot holds exactly one widget — the composite triage list — because a screen with two
competing "look here first" cards has none.

### 7.3 Slot behaviour when empty

A slot with no surviving widgets renders **nothing at all**: no heading, no divider, no placeholder.
An empty section heading is a promise the page does not keep.

### 7.4 The Universal Baseline

Every layout includes these, and no layout may remove them. They are the floor that guarantees a
composed page is never blank and never useless:

| Widget id | Slot | Why it is mandatory |
|---|---|---|
| `attention.queue` | attention | The one thing every workspace shares: what needs this person |
| `notifications.unread` | quiet | Rows are already written for every staff account |
| `profile.me` | quiet | Identity, designation, department, employee code — the "am I looking at my own record" check |
| `support.hr` | quiet | A route to a human when the screen is wrong |

---

## 8. Workforce Context Engine

### 8.1 The type

```ts
// src/lib/workforce/context.ts
export interface WorkforceContext {
  userId: string;
  role: string;                 // users.role, lowercased and trimmed
  workspace: Workspace;         // from resolveWorkspace() — see workspace-access.ts
  permissions: ResolvedPermissions;   // from resolvePermissions()
  /** roles.level via application_id. NULL is the common case; never treat it as a 'no'. */
  seniority: 'C-Level' | 'Lead' | 'Senior' | 'Mid' | 'Junior' | 'Intern' | 'Apprentice' | null;
  /** A departments.id SLUG (TEXT). Never cast ::uuid. Resolution order in 8.3. */
  functionKey: string | null;
  /** hr_employees.classification. Defaults to 'permanent' on the column. */
  classification: string | null;
  /** COUNT of hr_employees.reporting_manager_id = this users.id. Sparse; 0 is common and honest. */
  directReportCount: number;
  /** Whole days since joining_date. NULL when joining_date is unset. */
  tenureDays: number | null;
  /** The database's CURRENT_DATE as YYYY-MM-DD. Empty string when the read failed. */
  dbToday: string;
  /** Per-source honesty. A false here suppresses every widget that depends on that source. */
  ok: { workspace: boolean; permissions: boolean; seniority: boolean; reports: boolean; today: boolean };
}
```

### 8.2 How each field is obtained

| Field | Query | Availability |
|---|---|---|
| `workspace` | `resolveWorkspace(user)` | Buildable-now |
| `permissions` | `resolvePermissions(user.id, { locals })` | Buildable-now |
| `seniority`, and `functionKey` first choice | `SELECT r.level, r.department_id FROM hr_employees e JOIN applications a ON a.id = e.application_id JOIN roles r ON r.id = a.role_id WHERE e.id = $1` | Buildable-now, **sparse** — NULL when `application_id` is NULL |
| `classification` | `SELECT classification FROM hr_employees WHERE id = $1`, after `ensureClassificationSchema()` | Buildable-now |
| `directReportCount` | `SELECT COUNT(*)::int FROM hr_employees WHERE reporting_manager_id = $1 AND is_active = true` — **`$1` is a `users.id`**, per `hr-wallet.ts` and `employee.astro:474` | Buildable-now, sparse |
| `tenureDays` | Derived from `workspace.joiningDate`; no query | Buildable-now |
| `dbToday` | `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d` | Buildable-now — already in `employee.astro:596` |

### 8.3 `functionKey` resolution order

1. `roles.department_id` from the seniority join (the role the person was actually hired into).
2. `hr_employees.department_id` (one writer; NULL for hand-added records).
3. `users.assigned_department_id` (only set for `department_head`).
4. `null`.

All three are compared **as text**. `departments.id` is `varchar(50)` in `src/lib/db/schema.ts:81`
and UUID in `db/hr-schema.sql:31`; the varchar shape is live and `::uuid` throws on a slug.

### 8.4 The join risk, stated once

`reporting_manager_id` holds a **`users.id`**, not an `hr_employees.id`. Joining it to
`hr_employees.id` matches zero rows and reads as "nobody reports to you" rather than erroring. That is
the most likely implementation error in this codebase and it is silent. `directReportCount` above is
written against `users.id` deliberately, and the column comment in `context.ts` must say so.

### 8.5 What the context never contains

`gender`, `pan_number`, `aadhaar_number`, `bank_*`, `base_salary`, `date_of_birth`, and every
`wellness_*` value. `EMPLOYEE_COLUMNS` in `workspace-access.ts:155` is already an explicit allow-list
for exactly this reason — `gender` is the column read in the 2026-08-02 breach — and the context
inherits it without widening it. A field added to this context is a field that ends up in the render
scope of every widget, in every log line, on every workspace.

---

## 9. Dynamic Home Experience

### 9.1 One route

`/portal/employee` remains the URL. It is the address in `BottomNav`'s `hr` item
(`BottomNav.astro:103`), it is where `workspace-access.ts` sends people in four denial messages, and
it is what people have bookmarked. Changing it would break all of that to no benefit. **The page
changes what it composes; it does not change where it lives.** (DDR-006)

### 9.2 What the page does, in full

```
1. compose (Section 6.1)
2. if gate denied -> render gate.title + gate.reason, and stop. Redirect only when not signed in.
3. POST handler (unchanged behaviour: clock_event, daily_report, add_time_log, delete_time_log,
   task_status). Every const it uses is declared above it.
4. render: header, workspace switcher, then the four slots in order, then BottomNav with layout.nav
```

### 9.3 What the page must not do

- No `if (user.role === ...)`. If a role decision is needed, it belongs in `workspaces.ts`.
- No query. Every read is a loader.
- No `<script>` inside a JSX conditional — it breaks Astro parsing.
- No `Record<string,string>` typed map inside JSX.
- No arrow characters inside JSX strings.
- No `define:vars` combined with `is:inline`.

### 9.4 The header

Name, designation, department, and the workspace label with its `because` clause. The `because`
clause is the difference between a person understanding why their screen looks like this and a person
filing a bug. Example strings, one per kind, are in Section 16.

### 9.5 Progressive disclosure at 360px

The `attention` slot is above the fold. `primary` follows. `secondary` and `quiet` are below and are
not lazy-loaded — a phone on a poor connection is better served by one complete server-rendered
document than by a skeleton that fills in.

---

## 10. Dashboard Decision Flow

```
                              signed in?
                                  |
                     no ----------+---------- yes
                     |                          |
          redirect /portal/login          requireEmployee()
                                                |
                        +-----------------------+-----------------------+
                        |                       |                       |
                 no-employee-record       ambiguous-record          ok / inactive
                        |                       |                       |
              render title + reason    render title + reason            |
              (ask HR to link)         (two records, we will       resolveWorkforceContext()
                                        not guess)                      |
                                                                        v
                                                        classification === 'intern'
                                                        or seniority in (Intern, Apprentice)
                                                        or workspace.isIntern
                                                                 |
                                             yes ----------------+---------------- no
                                              |                                     |
                                         INTERN                        classification === 'volunteer'
                                                                                    |
                                                            yes --------------------+-------------------- no
                                                             |                                             |
                                                        VOLUNTEER                    seniority = C-Level, role = super_admin,
                                                                                     or functionKey = exec
                                                                                                           |
                                                                       yes ---------------------------------+--------------- no
                                                                        |                                                     |
                                                                   EXECUTIVE                                        seniority = Lead
                                                                                                                              |
                                                                                          yes -------------------------------+------- no
                                                                                           |                                          |
                                                                                      LEADERSHIP                  isTeamLead or directReportCount > 0
                                                                                                                                      |
                                                                                                    yes --------------------------- +---- no
                                                                                                     |                                    |
                                                                                                MANAGEMENT                    role in (teacher, partner,
                                                                                                                              technical_moderator)
                                                                                                                              or functionKey = psychology
                                                                                                                                    |
                                                                                                              yes -----------------+------------ no
                                                                                                               |                                  |
                                                                                                           ACADEMIC              functionKey in (research,
                                                                                                                                quantum, safety)
                                                                                                                                        |
                                                                                                                    yes ----------------+--------- no
                                                                                                                     |                              |
                                                                                                                 RESEARCH        functionKey in (ai, infra, data,
                                                                                                                                 product, dataengine, formdb)
                                                                                                                                            |
                                                                                                                        yes ----------------+------ no
                                                                                                                         |                           |
                                                                                                                    ENGINEERING      functionKey in (hr, legal,
                                                                                                                                     growth) or isHr
                                                                                                                                              |
                                                                                                                          yes ---------------+------- no
                                                                                                                           |                           |
                                                                                                                      OPERATIONS              PROFESSIONAL
```

Every leaf is reachable. `PROFESSIONAL` is the floor and cannot be escaped by a missing signal.

### 10.1 Worked examples

| Person | Signals | Resolves to | Why |
|---|---|---|---|
| Founder | `users.role = 'super_admin'`, no `hr_employees` row | denial, then `executive` once a record exists | `requireEmployee` needs the record; `super_admin` then hits rule 3. **Known gap G-07** |
| CEO hired through the pipeline | `roles.level = 'C-Level'`, dept `exec` | `executive` | Rule 3, first arm |
| AI Platform Lead | `roles.level = 'Lead'`, dept `ai` | `leadership` | Rule 4 before rule 8 — a lead's day is not an engineer's day |
| Department head, dept `growth` | `users.role = 'department_head'`, `assigned_department_id = 'growth'` | `management` | Rule 5 before rule 9 |
| Senior ML Engineer | `roles.level = 'Senior'`, dept `ai` | `engineering` | Rules 1-5 miss; rule 8 |
| Data Analyst added by hand | classification `permanent`, no `application_id`, no `department_id` | `professional` | Every signal null; the floor holds |
| AquinTutor teacher | `users.role = 'teacher'` | `academic` | Rule 6 |
| Unpaid contributor | classification `volunteer` | `volunteer` | Rule 2 |
| Internal Auditor, classification `permanent` | designation contains "intern" | `professional` | Rule 1's first two arms fail; today this person gets the intern page |
| Managing Intern, dept `founders` | `roles.level = 'Intern'` | `intern` | Rule 1 before rule 3. `founders` is not an executive signal |

---

## 11. Widget Registry

Ninety-five widgets. Every row states its data source and its availability. Rows marked
**No-data-source** are specified so that nobody re-proposes them, and are **not implemented**.

### 11.1 Universal — every workspace

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `attention.queue` | Needs you today | Composite: `myTasksView()`, `listBoard()`, `pendingLeaveForApprover()`, `pendingWithdrawalsForApprover()`, `listDocs()` | **Buildable-now** | Task arms empty until `createTask()` has a caller |
| `notifications.unread` | Notifications | `notifications` WHERE `user_id` AND `is_read = false` AND `is_archived IS NOT TRUE`; self-CREATE at `notifications-schema.ts:15`, written by `push.ts:138` and `notify.ts:35` | **Buildable-now** | — |
| `profile.me` | Your record | `resolveWorkspace()` — no extra query | **Buildable-now** | — |
| `support.hr` | Ask the people team | Static route card (`component: 'link'`) | **Buildable-now** | — |

### 11.2 Work

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `tasks.mine` | Your tasks | `myTasksView(employeeId)` -> `employee_tasks`; self-CREATE `employee-tasks.ts:627` | **Buildable-now** | `createTask()` has zero callers — an assign surface is required |
| `tasks.dueToday` | Due today | Partition of `tasks.mine` against `ctx.dbToday` | **Buildable-now** | same |
| `tasks.blocked` | Blocked | `employee_tasks.status = 'blocked'` + `blocked_reason` | **Buildable-now** | same |
| `tasks.signoff` | Waiting for your sign-off | `listBoard(userId)` filtered `status='under_review'` and viewer role `approver` or `lead` | **Buildable-now** | same |
| `tasks.review` | Waiting for your review | same, viewer role `reviewer` | **Buildable-now** | same. Reviewers are only ever added by hand |
| `tasks.assignedByMe` | Work you assigned | `employee_tasks WHERE assigned_by_user_id = $1`, indexed (`employee_tasks_assigner_idx`) | **Buildable-now** | same |
| `tasks.team` | Your team's work | `listTasksForTeam(departmentId)` | **Buildable-now** | same, plus `department_id` sparsity |
| `tasks.activity` | Recent task activity | `listTaskActivity()` -> `employee_task_activity` | **Buildable-now** | same |
| `worklog.today` | What you logged today | `hr_task_log` WHERE `employee_id` AND `log_date = CURRENT_DATE`; self-CREATE since `61efa4f` | **Buildable-now** | Written only inside the clock-out branch, only when the text field is non-empty |
| `offline.queue` | Work captured offline | `offline_work`, self-CREATE `api/offline/sync.ts:13`; `GET /api/offline/mine` | **Buildable-now** | — |
| `projects.mine` | Your projects | `work_projects` + `work_project_members` | **Needs-migration** | Section 18 M-04 |
| `projects.portfolio` | Portfolio health | same | **Needs-migration** | M-04 |
| `tasks.dependencies` | Blocked by | `employee_task_deps` | **Needs-migration** | M-04 |
| `capacity.utilisation` | Team capacity | — | **No-data-source** | `employee_tasks` has no estimate, effort or points column (DDL verified at `employee-tasks.ts:626-650`). Capacity cannot be computed |
| `cycle.time` | Cycle time | — | **No-data-source** | Requires a project and estimate model that does not exist. `status_changed_at` alone gives a last-transition timestamp, not a cycle |

### 11.3 Time, attendance and leave

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `clock.today` | Today's clock position | `hr_clock_events` WHERE `DATE(event_time) = CURRENT_DATE`; written by `portal/employee.astro:159` | **Buildable-now** | — |
| `attendance.month` | This month's attendance | `hr_attendance` aggregate by `status` | **Buildable-now** | — |
| `timelog.today` | Hours logged today | `hr_time_logs` WHERE `log_date = CURRENT_DATE` | **Buildable-now** | — |
| `dailyreport.today` | Today's report | `hr_daily_reports` WHERE `report_date = CURRENT_DATE` | **Buildable-now** | — |
| `leave.mine` | Your leave | `listLeave({ employeeId })` -> `hr_leave_request`, self-bootstrapping `hr-leave.ts:20-37` | **Buildable-now** | — |
| `leave.balance` | Leave remaining | `getBalances()` — entitlement from the **code constant** `LEAVE_TYPES` (`hr-leave.ts:11`), consumption `SUM`med per calendar year | **Buildable-now** | Entitlement is not per-person; the card must say the allowance is the standard one |
| `approvals.leave` | Leave decisions | `pendingLeaveForApprover(user)` | **Buildable-now** | — |
| `attendance.team` | Team attendance | `hr_attendance` JOIN `hr_employees` under `departmentFilter()` | **Buildable-now** | `department_id` has one writer; `DEPARTMENT_COVERAGE_NOTICE` is mandatory beside it |
| `leave.entitlement` | Your entitlement | `hr_leave_balance` | **Needs-migration** | M-06 |
| `holidays.next` | Next holiday | `hr_holidays` | **Needs-migration** | M-06 |
| `overtime.mine` | Overtime | — | **No-data-source** | `hr_attendance.overtime_hours` is written by **nothing**. `/admin/hr/attendance:163` already SUMs it and the total is structurally always 0. That is the exact defect this marker prevents |
| `break.deducted` | Break time | — | **No-data-source** | `break_start`/`break_end` rows are stored and touch nothing; `work_hours` is raw `NOW() - clock_in` |
| `attendance.intelligence` | Commute, weather, burnout | — | **No-data-source** | No source for weather, battery, connection quality or beacon. Several also need device permissions this product does not request |
| `shifts.roster` | Your shift | — | **No-data-source** | No shift, roster or timesheet-approval table, and no DDL |

### 11.4 Credit and engagement — intern workspace only

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `credit.position` | Credit hours | `ledgerFor(employeeId, termsFor(employeeId))` -> derived live from `hr_attendance` + approved `hr_leave_request`. No table; term columns ensured at `credit-ledger.ts:214` | **Buildable-now** | — |
| `credit.weeksLeft` | Weeks remaining | `remainingWeeks()` from `credit-hours.ts` | **Buildable-now** | — |
| `completion.status` | Completion letter | `completionFor()` (`credit-ledger.ts:307`) | **Buildable-now** | — |
| `reviews.mine` | Your reviews | `reviewsFor(employeeId)` (`credit-ledger.ts:278`) | **Buildable-now** | — |

`credit.position` renders "no credit-hour requirement recorded" rather than "0% complete" when the
term columns are unset. Zero and unknown are different facts, and that wording is already the
established convention (`4302ce3`).

### 11.5 Money

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `wallet.balance` | Your balance | `getBalance(employeeId)` -> `hr_wallet_txn`, self-CREATE `hr-wallet.ts:17` | **Buildable-now** | — |
| `wallet.recent` | Recent credits | `listTxns(employeeId, 5)` | **Buildable-now** | — |
| `approvals.withdrawal` | Withdrawal decisions | `pendingWithdrawalsForApprover(user)` | **Buildable-now** | — |
| `payslips.mine` | Payslips | `hr_payslips` JOIN `hr_payroll_runs` — **written directly, not via `hr-payslip.ts`** | **Buildable-now** | `hr-payslip.ts:24` selects `e.work_email`, a column nothing writes. The widget must not call that reader until Phase 0 removes it |
| `payroll.lastRun` | Last payroll run | `hr_payroll_runs` | **Buildable-now** | Table is not self-bootstrapping; see M-01 |
| `bank.status` | Payout account | `hr_bank_account` presence only, via `mask()` (`hr-wallet.ts:71`) | **Buildable-now** | `verified` is read and never written, so the widget must not render a verified badge |
| `payroll.cost` | Payroll cost | — | **No-data-source** | No employer PF, ESIC, gratuity or CTC column anywhere. Employer liability cannot be reported |
| `finance.runway` | Runway, burn, revenue | — | **No-data-source** | No finance, revenue, invoice or expense table exists in `src/` or `db/` — grep-verified |

### 11.6 People and organisation

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `manager.card` | Your reporting manager | `hr_employees` WHERE `user_id = employee.reporting_manager_id`, two display columns only | **Buildable-now** | One writer; NULL for most |
| `team.roster` | Your team | `hr_employees` under `departmentFilter()`, `EMPLOYEE_COLUMNS` allow-list | **Buildable-now** | `department_id` sparsity; notice mandatory |
| `reports.direct` | Your direct reports | `hr_employees WHERE reporting_manager_id = $1` (**a `users.id`**) | **Buildable-now** | One writer |
| `headcount.summary` | Headcount | `hr_employees` COUNT by `is_active`, `employment_type`, `classification` | **Buildable-now** | — |
| `groups.mine` | Your groups | `visibleGroupsFor(userId)` -> `work_groups`; the only permitted reader | **Buildable-now** | — |
| `onboarding.docs` | Your joining documents | `listDocs(userId)` -> `hr_onboarding_documents`, self-CREATE `hr-onboarding.ts:41` | **Buildable-now** | — |
| `onboarding.review` | Documents to review | `hr_onboarding_documents WHERE status='submitted' AND user_id <> $1` | **Buildable-now** | — |
| `goals.mine` | Your goals | `hr_employee_goals`, self-CREATE, 2 writers in `hr-lifecycle.ts` | **Buildable-now** | **Closes a real gap: no portal surface reads this today** |
| `probation.mine` | Probation status | `hr_probation`, `hr_probation_reviews`, self-CREATE | **Buildable-now** | Read only. The acknowledge action is No-data-source below |
| `pip.mine` | Improvement plan | `hr_pips`, `hr_pip_checkins`, self-CREATE | **Buildable-now** | Read only |
| `perf.mine` | Performance review | `hr_performance_reviews` WHERE employee and `status='submitted'`, **excluding `reviewer_comments`** | **Buildable-now** | Must **not** join `reviewer_id` — declared nowhere, written by nothing |
| `org.chart` | Reporting chain | `hr_reporting_line` | **Needs-migration** | M-08 |
| `reviews.waiting` | Reviews waiting on you | `hr_performance_reviews.reviewer_id` + a reviewer picker | **Needs-migration** | M-07 — the ALTER alone changes nothing without a writer |
| `lifecycle.acknowledge` | Acknowledge a plan | — | **No-data-source** | `employee_acknowledged` / `_at` exist on four lifecycle tables and **no code writes any of them**. A PIP the person never saw is currently indistinguishable from one they accepted. Until a writer exists, the widget is a read-only view, not an acknowledgement control |
| `directory.people` | Staff directory | — | **No-data-source** | Deliberate. A cross-department person list is a map of the organisation; `visibleGroupsFor()`'s design (an unentitled group is absent, not greyed out) is the precedent |
| `equipment.assets` | Assigned equipment | — | **No-data-source** | No asset table |
| `certifications.expiring` | Expiring certifications | — | **No-data-source** | No table |
| `survey.engagement` | Engagement score | — | **No-data-source** | No survey table |

### 11.7 Hiring and pipeline

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `hiring.pipeline` | Application pipeline | `applications` GROUP BY `status` (real Drizzle table, `schema.ts:125`) | **Buildable-now** | — |
| `hiring.openRoles` | Open roles | `roles WHERE is_open = true` (real Drizzle table) | **Buildable-now** | — |
| `offers.pending` | Offers out | `offer_letters WHERE status` (real Drizzle table, `schema.ts:368`) | **Buildable-now** | — |
| `requisitions.mine` | Your requisitions | `hiring_requisitions`, self-CREATE | **Buildable-now**, **read only** | `decideRequisition()` performs **no role check** and takes the stage from a hidden form field. The widget must not offer a decide action until Phase 0 closes that hole |
| `offers.awaitingSignature` | Awaiting your signature | — | **No-data-source** | Signing is by unguessable token; there is no per-user "awaiting your signature" query and no inbox |

### 11.8 Communication and community

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `discussion.recent` | Community | `discussions` | **Buildable-now** | `is_pinned` and `is_deleted` are ordered and filtered on and written by nothing — the widget must not order by them |
| `messages.counts` | Messages | `chat_thread_members` + `chat_messages` | **Needs-migration** | M-02. `chat_messages` is created with **two incompatible shapes**; exactly one is live and the other system's every write throws. Cannot be resolved from source |
| `announcements.feed` | Announcements | `staff_announcements` | **Needs-migration** | M-05 |
| `mentions.mine` | Mentions of you | — | **No-data-source** | No mentions table, no mention parsing, no mention column. `employee_task_comments` has five columns and none of them is a mention |
| `receipts.read` | Who has read | — | **No-data-source** | `chat_message_receipts` is written but the UI never reads it; the ticks at `messages.astro:913` are hardcoded `class='tick read'`, so a tick proves nothing |

### 11.9 Meetings and calendar

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `meetings.today` | Today's meetings | `staff_meetings` + `staff_meeting_invitees` | **Needs-migration** | M-03 |
| `huddle.active` | Live huddle | `meet_presence` — a working signalling relay | **Buildable-now** | — |
| `meetings.scheduled` | Scheduled meetings | — | **No-data-source** | `meet_rooms.scheduled_at`, `duration_min`, `invitees`, `recurrence` are written by nothing; the sole INSERT creates an ad-hoc huddle. `/api/meet/rooms` does not exist and the scheduler UI POSTs to it at four sites |
| `recordings.recent` | Past recordings | — | **No-data-source** | `meet_recordings` has no INSERT anywhere |
| `calendar.week` | Your week | — | **No-data-source** | Nothing holds an internal meeting, availability or slot row. Depends on M-03 |

### 11.10 Learning

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `learning.started` | Courses you opened | `training_enrollments` — one writer (`portal/courses/[slug].astro:35`) | **Needs-migration** | M-09. The `training_*` tables have **no `CREATE TABLE` anywhere in the repo**; the DDL lives only in a gitignored script |
| `learning.assigned` | Assigned learning | `training_assignments` | **Needs-migration** | M-10, which depends on M-09 |
| `teaching.load` | Courses you author | `training_courses WHERE author` | **Needs-migration** | M-09. Two writers with disjoint column sets exist on each `training_*` table; one of each pair must be failing |

### 11.11 Governance and oversight

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `permissions.mine` | What you can do | `resolvePermissions(userId)` | **Buildable-now** | — |
| `audit.recent` | Recent changes | `audit_log` via the reader used by `/admin/audit` | **Buildable-now** | `logAudit()` swallows its own exception (`audit.ts:21`), so the trail is incomplete by construction; the card must say "recorded changes", not "all changes" |
| `activity.feed` | Platform activity | `activity_log` | **Buildable-now**, near-empty | `attachActivityFeed()` (`activity-feed.ts:192`) is **never called**, so only 3 direct `record()` sites plus the `push.ts:171` mirror produce rows |
| `wellness.entry` | Wellness | **Route card only.** `component: 'link'`. No count, no aggregate, no row | **Buildable-now** | Never a data widget on any workspace. (DDR-010) |
| `legalhold.mine` | Your record access | `/portal/my-record-access` route card | **Buildable-now** | Link only. `logAccess()` must succeed before anything renders, which is the page's job, not a widget's |
| `wellness.oversight` | Wellness oversight | — | **No-data-source by policy** | Aggregate-only surfaces exist at `/admin/wellness` behind their own gate and suppress groups below `MIN_GROUP`. They are **not** compositionally available. A query returning a row per user on an admin surface is the screen that must not exist |
| `compliance.filings` | PF, ESIC, PT, TDS | — | **No-data-source** | No ECR, challan or return anywhere |

### 11.12 Function-specific

| id | Title | Data source (exact) | Availability | Empty until |
|---|---|---|---|---|
| `research.publications` | Publications | — | **No-data-source** | No table |
| `research.experiments` | Experiments | — | **No-data-source** | No table |
| `engineering.deploys` | Deploys | — | **No-data-source** | No table and no integration layer. Adding one would need an outbound connector, which the Sovereignty Constitution requires to sit behind a swappable interface with a self-hostable default |
| `engineering.incidents` | Incidents | — | **No-data-source** | No table |
| `engineering.oncall` | On call | — | **No-data-source** | No table |
| `ops.tickets` | Internal tickets | — | **No-data-source** | `hr_application_support` / `hr_support_messages` are the **paid candidate** support flow, not an internal desk. Using them would show candidate conversations to staff |
| `academic.cohorts` | Your cohorts | — | **No-data-source** | Depends on M-09 and on a cohort model that does not exist |

### 11.13 Registry tally

| Availability | Count | Meaning for the build |
|---|---|---|
| Buildable-now | 54 | Implementable in the next commit. 28 of the 54 carry a note in the final column — a structural emptiness, or a caveat the card is required to state (an incomplete audit trail, an unverified bank flag, a sparse department key) |
| Needs-migration | 13 | Specified, absent from every layout until the named migration lands |
| No-data-source (specified, refused, not built) | 28 | Never rendered. Each row carries the grep result that refuses it |
| **Total** | **95** | |

Counts machine-derived from this section's tables, not hand-tallied.

---

## 12. Widget Visibility Rules

Visibility is a **pure predicate over the context**. It runs before the permission gate and before
any query. It answers "is this widget about this person's job", not "may this person see it" — that
is Section 13's question, and conflating the two is how a permission ends up expressed as a layout.

### 12.1 The predicate vocabulary

```ts
const isIntern   = (c: WorkforceContext) => c.workspace.isIntern || c.classification === 'intern';
const isVolunteer= (c: WorkforceContext) => c.classification === 'volunteer';
const leadsPeople= (c: WorkforceContext) => c.workspace.isTeamLead || c.directReportCount > 0;
const inFunction = (...keys: string[]) => (c: WorkforceContext) => !!c.functionKey && keys.includes(c.functionKey);
const atLeast    = (level: Seniority) => (c: WorkforceContext) => c.seniority !== null && RANK[c.seniority] >= RANK[level];
const always     = () => true;
```

### 12.2 The rules

| Rule | Statement |
|---|---|
| V-1 | `credit.*` and `completion.status` are visible **only** when `isIntern(ctx)`. This is the rule the whole document exists for. |
| V-2 | `approvals.*` are visible when the person can decide one. Visibility is `leadsPeople(ctx) or isHr or role in (super_admin, hr)`; **authority is re-checked at the write** by `decideLeave` / `decideWithdrawal`, so a visible card can still refuse. |
| V-3 | `team.*` and `reports.*` require `leadsPeople(ctx)` **and** a resolvable scope. `departmentFilter()` returns `false` (no rows) without one, so a lead whose department was never set sees nothing rather than everything. |
| V-4 | Function widgets are visible only via `inFunction(...)`. A null `functionKey` matches nothing, which is why every function workspace also carries the universal and work widgets. |
| V-5 | `headcount.summary`, `hiring.*`, `payroll.lastRun` require `atLeast('Lead')` **or** an explicit permission. Seniority alone never grants; see Section 13. |
| V-6 | `wellness.entry` is visible to every person for **themselves**, on every workspace, as a link. It is never conditioned on gender, and the page behind it does its own server-side gating. Conditioning the link would disclose a health-relevant fact through the layout. |
| V-7 | A widget whose `availability` is `no-data-source` has no visibility rule, because it is dropped in step 2 of the pipeline and can never reach step 3. |
| V-8 | Preferences never change visibility. Section 14. |

### 12.3 The null-signal lint rule

**A null signal must never satisfy a negative predicate.** These are wrong:

```ts
// WRONG: null !== 'C-Level' is true, so everyone with no seniority gets the non-executive branch
visibleFor: (c) => c.seniority !== 'C-Level'
// WRONG: same class, via a department that is NULL for every hand-added record
visibleFor: (c) => c.functionKey !== 'hr'
```

These are right:

```ts
visibleFor: (c) => c.seniority !== null && RANK[c.seniority] >= RANK.Lead
visibleFor: inFunction('ai', 'infra', 'data')
```

Every `visibleFor` in the registry must be expressible with the vocabulary in 12.1. A predicate that
needs a raw comparison is a predicate that has not been thought through.

---

## 13. Dashboard Permission Matrix

### 13.1 The gate vocabulary

```ts
export type WidgetGate =
  | { kind: 'self' }                                   // own rows only; scoped by employeeFilter()
  | { kind: 'department' }                             // departmentFilter(); needs scopeDepartmentId
  | { kind: 'permission'; key: string }                // hasPermission() via the registry
  | { kind: 'section'; key: string; action: PermissionAction }  // canAccessSection()
  | { kind: 'approver' }                               // the reader self-gates; see 13.3
  | { kind: 'open' };                                  // no gate beyond an active employee record
```

### 13.2 The matrix

`self` is not a weak gate. It is `employeeFilter()` in the WHERE clause, keyed off the session, and it
is the strongest available guarantee that one person's rows cannot be another's.

| Widget | Gate | Enforced by |
|---|---|---|
| `attention.queue` | `self` + per-arm gates | Each composing reader gates itself |
| `notifications.unread` | `self` | `WHERE user_id = $session` |
| `profile.me` | `self` | `resolveWorkspace()` |
| `support.hr`, `wellness.entry`, `legalhold.mine` | `open` | Route card only |
| `tasks.mine`, `tasks.dueToday`, `tasks.blocked` | `self` | `myTasksView(employeeId)` |
| `tasks.signoff`, `tasks.review`, `tasks.assignedByMe`, `tasks.activity` | `self` | `visibleToSql()` — assignee OR assigner OR collaborator OR department lead, resolved **in SQL**; an empty viewer compiles to `false` |
| `tasks.team` | `department` | `listTasksForTeam(scopeDepartmentId)` |
| `clock.today`, `attendance.month`, `timelog.today`, `dailyreport.today`, `worklog.today`, `offline.queue` | `self` | `employeeFilter()` |
| `leave.mine`, `leave.balance` | `self` | `listLeave({ employeeId })` |
| `approvals.leave` | `approver` | `pendingLeaveForApprover(user)`, then `decideLeave` re-checks at the write |
| `approvals.withdrawal` | `approver` | `pendingWithdrawalsForApprover(user)`, then `decideWithdrawal` re-checks |
| `attendance.team`, `team.roster` | `department` | `departmentFilter()`, returns `false` without a scope |
| `reports.direct` | `self` | `WHERE reporting_manager_id = $session_user_id` |
| `credit.*`, `completion.status`, `reviews.mine`, `perf.mine`, `probation.mine`, `pip.mine`, `goals.mine` | `self` | `employeeFilter()`. `perf.mine` additionally excludes `reviewer_comments` at the SELECT |
| `wallet.balance`, `wallet.recent`, `payslips.mine`, `bank.status` | `self` | `employeeFilter()`; `mask()` on any account number |
| `onboarding.docs` | `self` | `listDocs(userId)` scopes to `user_id` internally |
| `onboarding.review` | `section: employees / edit` | `canAccessSection()` — the same test `/api/portal/onboarding/documents` uses to authorise the review |
| `headcount.summary` | `section: employees / view` | `canAccessSection()` |
| `hiring.pipeline`, `hiring.openRoles` | `permission: applications.view` | `hasPermission()` |
| `offers.pending` | `permission: offers.view` | `hasPermission()` |
| `requisitions.mine` | `self` | Own rows only. **No decide action** until the authorisation hole is closed |
| `payroll.lastRun` | `section: payroll / view` | `canAccessSection()` |
| `permissions.mine` | `self` | `resolvePermissions(self)` |
| `audit.recent` | `permission: audit.view` | `hasPermission()` — a sensitive permission; granting it is itself audited |
| `activity.feed` | `permission: audit.view` | Same |
| `groups.mine` | `self` | `visibleGroupsFor(userId)` — an unentitled group is absent, not greyed out |
| `discussion.recent` | `open` | Board's own gate. Its weakness is Known Gap G-05 |
| `huddle.active` | `self` | Addressed by peerId |

### 13.3 Why `approver` is its own kind

`approverRole()` (`hr-wallet.ts:189`) answers one question about one request: `super_admin`, `admin`,
exact role `hr`, or the employee's `reporting_manager_id`. It is not expressible as a static
permission key because the fourth arm depends on **the row**. So the gate is the reader itself:
`pendingLeaveForApprover(user)` returns only rows this person may decide, and an empty result is a
correct answer, not a denial.

The role test is **exact equality**, never `role.indexOf('hr') >= 0`. That substring test at
`admin/hr/wallet/index.astro:10` leaks unmasked account numbers and IFSC codes to any role whose name
contains those two letters, and `approverRole()` deliberately fixed it with an exact match twelve
lines away with a comment explaining why.

### 13.4 Degraded permissions

`ResolvedPermissions.degraded === true` means the lookup failed and the set is empty **by
construction**. Every `permission` and `section` gate then **fails closed**, and the composer sets
`degraded` on the dashboard so no all-clear headline renders. An empty permission set from a failed
lookup must never be read as "this person may do nothing, therefore show them the simplest page" —
that is how a founder ends up on the intern screen.

### 13.5 What a failed gate looks like

**Nothing.** The widget is absent. No lock icon, no "request access", no greyed card. A list of
capabilities somebody does not have is a map of the organisation, and `work-groups.ts` already
established scoping-at-the-query as this codebase's convention for exactly that reason.

---

## 14. Personalization

### 14.1 The single rule

**Personalization reorders and collapses. It never reveals and never hides.** (DDR-008)

A person may move a widget up, move it down, or collapse it. A person may not add a widget their
workspace does not include, and may not remove one the Universal Baseline requires. Visibility is a
property of the job and the permission, not of a preference, and a preference that could hide
`attention.queue` would let someone hide the fact that a colleague is waiting on them.

### 14.2 What is stored

| Preference | Values | Scope |
|---|---|---|
| Widget order within a slot | Array of widget ids | Per user, per workspace kind |
| Collapsed state | Set of widget ids | Per user, per workspace kind |
| Active workspace | A `WorkspaceKind` from `ALLOWED_ALTERNATES` | Per user |
| Density | `comfortable` \| `compact` | Per user — CSS-only, `workforce.css` already supports it |
| Focus mode | on \| off | Per user — CSS-only |

### 14.3 Data source

**Needs-migration.** No preference table exists. Proposed, **not applied**, delivered per Section 18
as M-11:

```sql
-- PROPOSED. Not applied. Deliver via ensureOnce('workforce_prefs_v1', ...).
-- Every column also appears as its own ADD COLUMN IF NOT EXISTS, because
-- CREATE TABLE IF NOT EXISTS is a NO-OP on a table that already exists.
-- That is the exact reason work_email and hr_task_log failed.
CREATE TABLE IF NOT EXISTS workforce_dashboard_prefs (
  user_id        UUID NOT NULL,
  workspace_kind TEXT NOT NULL,
  widget_order   JSONB NOT NULL DEFAULT '[]'::jsonb,
  collapsed      JSONB NOT NULL DEFAULT '[]'::jsonb,
  density        TEXT  NOT NULL DEFAULT 'comfortable',
  focus_mode     BOOLEAN NOT NULL DEFAULT FALSE,
  active_kind    TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, workspace_kind)
);
ALTER TABLE workforce_dashboard_prefs ADD COLUMN IF NOT EXISTS widget_order JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workforce_dashboard_prefs ADD COLUMN IF NOT EXISTS collapsed    JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workforce_dashboard_prefs ADD COLUMN IF NOT EXISTS density      TEXT  NOT NULL DEFAULT 'comfortable';
ALTER TABLE workforce_dashboard_prefs ADD COLUMN IF NOT EXISTS focus_mode   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workforce_dashboard_prefs ADD COLUMN IF NOT EXISTS active_kind  TEXT;
ALTER TABLE workforce_dashboard_prefs ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();
```

### 14.4 Applying preferences safely

```
1. Start from WORKSPACE_LAYOUTS[kind] — the authority.
2. Stable-sort each slot by the stored order. Ids not in the stored order keep their layout position.
3. Ids in the stored order that are NOT in the layout are IGNORED, not added.
4. Universal Baseline ids are pinned and cannot be collapsed.
5. A malformed or unreadable preference row is discarded silently; the layout renders as designed.
```

Step 3 is the security property: a preference row is user-controlled data, and a composer that
**added** widgets from it would let a person compose a dashboard they were never granted. The layout
is a whitelist and the preference is a sort key.

### 14.5 Until M-11 lands

Personalization is **not shipped**. Density and focus mode already work as CSS-only modes and are
exposed immediately; ordering and collapse wait for the table. Shipping ordering against
`localStorage` is explicitly rejected: it would not survive a device change, and a "your layout" that
silently resets is worse than no layout control.

---

## 15. AI Workspace Personalization

### 15.1 Position

**No AI ships in version 1.0, and nothing in this document requires AI to work.** Every gap named
here is a missing table, a missing form, or a missing function call. That is stated plainly so the AI
section cannot become a reason to defer real work.

### 15.2 What AI would and would not be allowed to do

| Allowed | Not allowed |
|---|---|
| Reorder widgets **within a slot** | Add a widget to a layout |
| Rank rows **within** `attention.queue` | Remove a widget from a layout |
| Suggest a workspace switch, as a dismissible line the person accepts | Change the resolved workspace |
| Summarise the person's **own** rows | Read any other person's rows |
| — | Touch any `wellness_*` table, `gender`, or any government ID, ever |
| — | Influence a permission, a gate, or a scope |

The boundary is the same one the composer already draws: **AI is a sort key, never a whitelist.** An
AI that could add a widget would be an AI that could grant access.

### 15.3 The interface, if it is ever built

Per the Sovereignty Constitution, any model sits behind a swappable interface with a self-hostable
default, and the **deterministic ranker is the default implementation** — not a fallback.

```ts
// src/lib/workforce/ranking.ts
export interface WidgetRanker {
  /** Returns a permutation of the ids given. MUST NOT add or drop an id. */
  rank(ids: string[], signals: RankingSignals): Promise<string[]> | string[];
}

/** The default. No model, no network, no configuration. */
export const deterministicRanker: WidgetRanker;
```

The contract "returns a permutation" is enforced by the composer, which discards any result whose
sorted id set differs from the input. A ranker that misbehaves is ignored, not trusted.

### 15.4 Signals a ranker could use, and their availability

| Signal | Source | Availability |
|---|---|---|
| Which widget the person opened last | `workforce_dashboard_prefs` (extended) | **Needs-migration** (M-11) |
| Overdue count | `myTasksView()` | **Buildable-now**, empty until tasks exist |
| Approvals waiting | `pendingLeaveForApprover()`, `pendingWithdrawalsForApprover()` | **Buildable-now** |
| Time of day, day of week | The request | **Buildable-now** |
| Notification click-through | `notifications.clicked_at` | **Buildable-now** |
| Interaction history / dwell time | — | **No-data-source.** No client telemetry is collected, and adding it is a separate product decision with its own consent question |

### 15.5 The deterministic default, specified

Order within a slot by: (1) any widget reporting `ok:false` last, so a failure is never the first
thing a person reads; (2) descending count of things needing action; (3) descending recency of the
newest row; (4) the layout order. That is a complete, testable ranking with no model in it, and it is
what ships.

---

## 16. The workspaces

Each workspace below lists its layout, the `because` clause the header renders, and its nav. Every
widget named is **Buildable-now** unless marked. Needs-migration widgets are listed under
"Arriving with" and are **absent from the layout until their migration lands** — a layout naming an
unavailable widget would drop it at compose time and leave a hole in a designed grid.

### 16.1 Executive

> **because:** "You are recorded at C-Level."  (or "You hold the founder account." / "You are in the executive function.")

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `headcount.summary`, `hiring.pipeline`, `approvals.withdrawal` |
| secondary | `hiring.openRoles`, `offers.pending`, `approvals.leave`, `payroll.lastRun` |
| quiet | `audit.recent`, `notifications.unread`, `profile.me`, `support.hr` |

**Nav:** Home, Approvals, People, Community.
**Arriving with:** `announcements.feed` (M-05), `projects.portfolio` (M-04), `meetings.today` (M-03).
**Explicitly absent:** `credit.position` (V-1), `clock.today` — an executive punching a clock is the
failure this document was written to fix. Clock controls remain fully available at
`/portal/workspace`; they are not on the executive home.
**Refused:** revenue, runway and burn. No finance table exists. A CEO dashboard with a fabricated
revenue tile is worse than one without a revenue tile.

### 16.2 Leadership

> **because:** "You lead a function."

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `tasks.signoff`, `tasks.team`, `approvals.leave` |
| secondary | `team.roster`, `attendance.team`, `approvals.withdrawal`, `hiring.pipeline` |
| quiet | `groups.mine`, `notifications.unread`, `profile.me`, `support.hr` |

**Nav:** Home, Tasks, Team, Community.
**Arriving with:** `projects.portfolio` (M-04), `reviews.waiting` (M-07), `meetings.today` (M-03).
`team.roster` and `attendance.team` render `DEPARTMENT_COVERAGE_NOTICE` beneath them, always. A short
list reads as a complete one, and `hr_employees.department_id` has exactly one writer.

### 16.3 Management

> **because:** "You lead the {department} department." / "{n} people report to you."

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `approvals.leave`, `approvals.withdrawal`, `tasks.team` |
| secondary | `reports.direct`, `team.roster`, `attendance.team`, `tasks.signoff` |
| quiet | `onboarding.review`, `notifications.unread`, `profile.me`, `support.hr` |

**Nav:** Home, Approvals, Team, Tasks.
**Arriving with:** `reviews.waiting` (M-07), `org.chart` (M-08).

This workspace is the one that most needs the honest-empty behaviour. A manager whose
`assigned_department_id` is unset gets `false` from `departmentFilter()`, so `team.roster` renders the
"no department is recorded for you yet" sentence from `requireTeamLead` and not "0 people".

### 16.4 Professional

> **because:** "This is your work."

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `tasks.mine`, `tasks.dueToday`, `tasks.blocked` |
| secondary | `leave.mine`, `leave.balance`, `goals.mine`, `wallet.balance` |
| quiet | `manager.card`, `groups.mine`, `notifications.unread`, `profile.me` |

**Nav:** Home, Tasks, Community, Learn.
**Arriving with:** `projects.mine` (M-04), `learning.assigned` (M-10), `meetings.today` (M-03).

`goals.mine` on this layout closes a genuine gap: `hr_employee_goals` has two writers and **no portal
reader**, so an employee cannot currently see their own objectives.

### 16.5 Academic

> **because:** "You are recorded in a teaching role."

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `tasks.mine`, `tasks.dueToday`, `discussion.recent` |
| secondary | `goals.mine`, `leave.mine`, `groups.mine`, `perf.mine` |
| quiet | `manager.card`, `notifications.unread`, `profile.me`, `support.hr` |

**Nav:** Home, Tasks, Community, Learn.
**Arriving with:** `teaching.load` (M-09), `learning.assigned` (M-10), `academic.cohorts` (blocked on
a cohort model that does not exist).

**Stated honestly:** the academic workspace is currently the professional workspace with a teaching
label. Every teaching-specific number depends on the `training_*` tables, which have **no
`CREATE TABLE` anywhere in the repo** and two writers each with disjoint column sets. Shipping a
"Courses you author" card against them would be the sixth instance of the defect class this project
keeps paying for. The label is real; the teaching widgets arrive with M-09.

Note also that `teacher`, `partner` and `technical_moderator` hold **no** `admin.access` and are
confined to `/aquintutor/admin` by the middleware. `/portal` is a separate surface, so this workspace
is reachable — but no widget on it may link into `/admin/*`.

### 16.6 Research

> **because:** "You are in the {function} function."

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `tasks.mine`, `tasks.blocked`, `tasks.review` |
| secondary | `goals.mine`, `groups.mine`, `discussion.recent`, `leave.mine` |
| quiet | `manager.card`, `notifications.unread`, `profile.me`, `support.hr` |

**Nav:** Home, Tasks, Community, Learn.
**Arriving with:** `projects.mine` (M-04).
**Refused:** publications, experiments, datasets, compute. No table exists for any of them, and
inventing four is a research-tooling project, not a dashboard.

### 16.7 Engineering

> **because:** "You are in the {function} function."

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `tasks.mine`, `tasks.blocked`, `tasks.review` |
| secondary | `tasks.signoff`, `tasks.assignedByMe`, `goals.mine`, `leave.mine` |
| quiet | `manager.card`, `groups.mine`, `notifications.unread`, `profile.me` |

**Nav:** Home, Tasks, Community, Learn.
**Arriving with:** `projects.mine` (M-04), `tasks.dependencies` (M-04).
**Refused:** deploys, incidents, on-call, error rates, PR queues. All No-data-source, and each would
need an outbound connector that the Sovereignty Constitution requires to sit behind a swappable
interface with a self-hostable default. That is a separate build.

### 16.8 Operations

> **because:** "You are in the {function} function." / "You hold HR permissions."

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `approvals.leave`, `approvals.withdrawal`, `onboarding.review` |
| secondary | `headcount.summary`, `hiring.pipeline`, `offers.pending`, `tasks.mine` |
| quiet | `payroll.lastRun`, `notifications.unread`, `profile.me`, `support.hr` |

**Nav:** Home, Approvals, People, Tasks.
**Arriving with:** `announcements.feed` (M-05), `reviews.waiting` (M-07).
Every widget here carries its own gate: an operations person without `applications.view` does not see
`hiring.pipeline`, and the card is absent rather than locked.

### 16.9 Volunteer

> **because:** "You are recorded as an unpaid contributor."

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `tasks.mine`, `tasks.dueToday`, `timelog.today` |
| secondary | `groups.mine`, `discussion.recent`, `worklog.today` |
| quiet | `manager.card`, `notifications.unread`, `profile.me`, `support.hr` |

**Nav:** Home, Tasks, Community, Learn.
**Explicitly absent, and this is the point:** `wallet.balance`, `payslips.mine`, `bank.status`,
`approvals.withdrawal`, `credit.position`, `leave.balance`. A volunteer has no payroll and no
statutory leave entitlement. Showing a zero balance to an unpaid contributor states a fact about
money that does not apply to them.

`classification = 'volunteer'` carries `risk: 'high'` in `hr-classification.ts:33` ("Use sparingly;
check local labour law"). The workspace exists so that an unpaid contributor is visibly a distinct
engagement rather than an employee with empty cards — which is exactly the misclassification the
register was built to prevent.

### 16.10 Intern

> **because:** "You are on an internship."

| Slot | Widgets |
|---|---|
| attention | `attention.queue` |
| primary | `credit.position`, `tasks.mine`, `clock.today` |
| secondary | `attendance.month`, `credit.weeksLeft`, `leave.mine`, `timelog.today` |
| quiet | `manager.card`, `dailyreport.today`, `groups.mine`, `profile.me` |

**Nav:** Home, Tasks, Community, Learn.
**Arriving with:** `learning.assigned` (M-10).

This is the existing `/portal/employee`, unchanged in behaviour and unchanged in wording, now scoped
to the people it was designed for. Nothing was removed. `credit.position` keeps its honest null
("no credit-hour requirement recorded", never "0% complete") and keeps driving the same numbers as the
completion letter, because it is the same engine. (DDR-003)

`completion.status` and `reviews.mine` remain on `/portal/workspace`, which is the intern's detail
screen; the home page shows the position, not the paperwork.

---

## 17. Future Workforce Categories

Categories the organisation may need, with the signal that would classify them and what is missing.
Listed so that adding one is a config change and not a redesign.

| Category | Classifying signal | Available today? | What is missing |
|---|---|---|---|
| **Contractor** | `classification = 'contractor'` | **Yes** — the value exists and has a writer | A layout. No schema. Add to `WORKSPACE_LAYOUTS` and to the resolution order between rules 2 and 3. Widgets: tasks, time logs, invoices; **not** leave balance, **not** payslips |
| **Consultant / advisor** | `classification = 'consultant'` | **Yes** | A layout. Likely a thin one: engagement scope and a route to their contact |
| **EOR-employed (foreign)** | `classification = 'eor'` + `country_of_work` | **Yes**, both columns written by `/admin/hr/classification` | A layout, and a decision about which statutory widgets are meaningless outside India |
| **Fixed-term employee** | `classification = 'fixed_term'` | **Yes** | Probably no separate layout; Professional plus an end-date line on `profile.me` |
| **Apprentice** | `roles.level = 'Apprentice'` | **Yes** (sparse) | Currently folded into `intern` by rule 1. Separating it needs a credit-hours decision: apprenticeships may not carry a credit requirement |
| **Campus ambassador** | — | **No** | `user_role` has no such value, yet `portal/submissions/new.astro:28-45` branches on it — a dead branch flagged by `astro check` as ts(2367). Either add the enum value **and** a writer, or delete the branches |
| **Alumni / offboarded** | `employment_status = 'inactive'` + `is_active = false` | **Partly** | `requireEmployee` currently denies with "Your employee record is closed". A read-only alumni workspace (final payslip, completion letter, record-access history) is a product decision, not a schema one |
| **Partner institution staff** | `users.role = 'partner'` | **Yes** | Folded into `academic` today. A separate layout needs the partner model in `src/lib/aquin-partners.ts` to be reconciled with `hr_employees`, which it currently is not |
| **Board / advisory** | — | **No** | No signal. Would need a `classification` value and a writer |
| **Agency-supplied** | `engaged_via = 'staffing_agency'` | **Yes** | A layout. Note that `ENGAGEMENT_VIAS` descriptions in `hr-classification.ts:36-43` **name real third-party companies**, which violates the no-company-names rule if that text ever reaches a user-facing surface. Fix before reusing those strings outside `/admin` |

### 17.1 The cost of adding one

Adding a category is: one arm in `resolveWorkspaceKind`, one entry in `WORKSPACE_LAYOUTS`, one row in
Section 19's compatibility matrix, one case in the Section 21 role matrix test. **No widget changes,
no page changes, no permission changes.** If adding a category requires touching
`src/pages/portal/employee.astro`, the composer has been built wrong.

---

## 18. Migration Strategy

### 18.1 Delivery mechanism

This project has **no migration runner**. The established, working pattern is `ensureOnce()`
(`src/lib/ensure-once.ts`): memoise the in-flight promise per process, drop failures from the cache so
a transient hiccup does not poison the process. The model to copy is `src/lib/work-groups.ts:82-92`,
which re-asserts **every column past the primary key** with `ADD COLUMN IF NOT EXISTS` explicitly
because of the `work_email` incident.

**The rule for every ensure block:** `CREATE TABLE IF NOT EXISTS` is a **no-op on an existing table**.
It will not add a column. Therefore every column must *also* appear as its own
`ADD COLUMN IF NOT EXISTS`. This is the exact reason `work_email` and `hr_task_log` failed.

**No SQL in this document has been run against any database, and none should be run by an agent.**
Per `CLAUDE.md`, schema changes are handed to the user to run.

### 18.2 The migration list

All SQL is specified in `docs/workforce-os-architecture.md` at the sections referenced. This table is
the **dependency order and the widget impact**, which that document does not carry.

| Id | Migration | SQL at | Unblocks | Phase |
|---|---|---|---|---|
| **M-00** | **Phase 0 code fixes. No SQL.** Wrap `admin/hr/attendance:110-120` in try/catch; replace `u.full_name` with `u.name` in four files; remove `e.work_email` from `hr-payslip.ts:24` and its nine dead `OR` arms; fix `decideRequisition()`'s missing role check; fix `admin/hr/wallet:10` to exact role equality | arch §3.13, Phase 0 | `payslips.mine`, `requisitions.mine`, `messages.counts` prerequisites | 0 |
| **M-01** | Port Tier-1 DDL into `ensureOnce` blocks: `user_face_enrollments` first (it gates every protected page), then `hr_attendance`, `hr_daily_reports`, `hr_time_logs`, `hr_clock_events`, `hr_payroll_runs`, `hr_payslips`, `hr_salary_structures` | arch §3.1 | Portability of `clock.today`, `attendance.month`, `timelog.today`, `dailyreport.today`, `payroll.lastRun`. **These work in production today; M-01 makes them survive a fresh environment** | 1 |
| **M-02** | Resolve the `chat_messages` shape collision | arch §3.7 — **an `information_schema` query the user runs**, not an agent | `messages.counts` | 1 |
| **M-03** | `staff_meetings` + `staff_meeting_invitees`, plus the missing `/api/meet/rooms` | arch §3.8 | `meetings.today`, `calendar.week` | 3 |
| **M-04** | `work_projects`, `work_project_members`, `employee_tasks.project_id` / `parent_task_id` / `sort_rank`, `employee_task_deps` | arch §3.4 | `projects.mine`, `projects.portfolio`, `tasks.dependencies` | 4 |
| **M-05** | `staff_announcements` + `staff_announcement_reads` | arch §3.9 | `announcements.feed` | 3 |
| **M-06** | `hr_holidays` + `hr_leave_balance` (entitlement only; consumption stays derived) | arch §3.5 | `leave.entitlement`, `holidays.next`, and makes "absent" stop counting weekends | 4 |
| **M-07** | `hr_performance_reviews.reviewer_id` + `reviewer_assigned_at`, **plus a reviewer picker** | arch §3.11 | `reviews.waiting`. The ALTER alone changes nothing — the column needs a writer | 3 |
| **M-08** | `hr_reporting_line` — optional, only if skip-level, dotted lines or history are genuinely needed | arch §3.3 | `org.chart` | 4 |
| **M-09** | Port `.dev-scripts/migrate-training.mjs` into `ensureTrainingSchema()` in `src/lib/` | arch §3.10 | `learning.started`, `teaching.load`, and everything academic | 1 |
| **M-10** | `training_assignments` | arch §3.10 | `learning.assigned` | 3 |
| **M-11** | `workforce_dashboard_prefs` (Section 14.3 — **specified in this document**) | §14.3 above | Personalization ordering and collapse | 2 |

### 18.3 The critical path for this document's own value

M-00 is the only migration that must land **before** Workforce OS ships. Everything else changes how
many widgets a workspace carries, not whether the composer works.

The single highest-value item that is **not** a migration: **build the task assignment surface**.
`createTask()` (`employee-tasks.ts:1566`) has zero callers, and four of the ten dashboard questions
depend on it. The engine, the permission model, the ten-state graph, the collaborator roles and eleven
components already exist. It needs a **form**, not SQL. Until it lands, `tasks.*` renders correct,
gated, honest empty states on every workspace — and this document is deliberately explicit about that
rather than shipping cards that look broken.

### 18.4 Rollout of the composer itself

| Step | Action | Reversible? |
|---|---|---|
| 1 | Ship `context.ts`, `workspaces.ts`, `config.ts`, `registry.ts`, `composer.ts` with **no page consuming them**. Add `/admin/access-preview` rendering resolved layouts per role | Yes — dead code |
| 2 | Ship `WidgetShell`, `StatTile`, `ProgressMeter`, `AttentionList`; migrate the existing `/portal/employee` command centre into `AttentionList` with **no behaviour change** | Yes |
| 3 | Compose `/portal/employee` for the `intern` kind only. Every other kind falls through to the page exactly as it is today | Yes — one boolean |
| 4 | Enable `professional`, then `management`, then the function workspaces, then `executive` / `leadership` / `academic` / `volunteer` | Yes — per kind |
| 5 | Remove the legacy fall-through | No — do this only after step 4 has been observed on the live site |

Step 3 first is deliberate: the intern layout is the current page, so the first composed render should
be visually identical to what shipped. A composition engine whose first output differs from the known
good page cannot be debugged.

---

## 19. Compatibility Matrix

### 19.1 Workspace vs. widget

`Y` = in the layout. `-` = not in the layout. `M` = arrives with a migration. Blank = never.

| Widget | exec | lead | mgmt | prof | acad | rsch | eng | ops | vol | intern |
|---|---|---|---|---|---|---|---|---|---|---|
| `attention.queue` | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| `notifications.unread` | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| `profile.me` | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| `support.hr` | Y | Y | Y | - | Y | Y | - | Y | Y | - |
| `tasks.mine` | - | - | - | Y | Y | Y | Y | Y | Y | Y |
| `tasks.dueToday` | - | - | - | Y | Y | - | - | - | Y | - |
| `tasks.blocked` | - | - | - | Y | - | Y | Y | - | - | - |
| `tasks.review` | - | - | - | - | - | Y | Y | - | - | - |
| `tasks.signoff` | - | Y | Y | - | - | - | Y | - | - | - |
| `tasks.assignedByMe` | - | - | - | - | - | - | Y | - | - | - |
| `tasks.team` | - | Y | Y | - | - | - | - | - | - | - |
| `approvals.leave` | Y | Y | Y | - | - | - | - | Y | - | - |
| `approvals.withdrawal` | Y | Y | Y | - | - | - | - | Y | | - |
| `team.roster` | - | Y | Y | - | - | - | - | - | - | - |
| `attendance.team` | - | Y | Y | - | - | - | - | - | - | - |
| `reports.direct` | - | - | Y | - | - | - | - | - | - | - |
| `manager.card` | - | - | - | Y | Y | Y | Y | - | Y | Y |
| `headcount.summary` | Y | - | - | - | - | - | - | Y | - | - |
| `hiring.pipeline` | Y | Y | - | - | - | - | - | Y | - | - |
| `hiring.openRoles` | Y | - | - | - | - | - | - | - | - | - |
| `offers.pending` | Y | - | - | - | - | - | - | Y | - | - |
| `onboarding.review` | - | - | Y | - | - | - | - | Y | - | - |
| `payroll.lastRun` | Y | - | - | - | - | - | - | Y | - | - |
| `audit.recent` | Y | - | - | - | - | - | - | - | - | - |
| `wallet.balance` | - | - | - | Y | - | - | - | - | | - |
| `leave.mine` | - | - | - | Y | Y | Y | Y | - | - | Y |
| `leave.balance` | - | - | - | Y | - | - | - | - | | - |
| `goals.mine` | - | - | - | Y | Y | Y | Y | - | - | - |
| `groups.mine` | - | Y | - | Y | Y | Y | Y | - | Y | Y |
| `discussion.recent` | - | - | - | - | Y | Y | - | - | Y | - |
| `perf.mine` | - | - | - | - | Y | - | - | - | - | - |
| `clock.today` | | - | - | - | - | - | - | - | - | Y |
| `attendance.month` | | - | - | - | - | - | - | - | - | Y |
| `timelog.today` | | - | - | - | - | - | - | - | Y | Y |
| `worklog.today` | | - | - | - | - | - | - | - | Y | - |
| `dailyreport.today` | | - | - | - | - | - | - | - | - | Y |
| `credit.position` | | | | | | | | | | Y |
| `credit.weeksLeft` | | | | | | | | | | Y |
| `payslips.mine` | - | - | - | - | - | - | - | - | | - |
| `bank.status` | - | - | - | - | - | - | - | - | | - |
| `projects.mine` | - | - | - | M | - | M | M | - | - | - |
| `projects.portfolio` | M | M | - | - | - | - | - | - | - | - |
| `meetings.today` | M | M | M | M | M | - | - | - | - | - |
| `announcements.feed` | M | - | - | - | - | - | - | M | - | - |
| `reviews.waiting` | - | M | M | - | - | - | - | M | - | - |
| `learning.assigned` | - | - | - | M | M | - | - | - | - | M |
| `teaching.load` | - | - | - | - | M | - | - | - | - | - |
| `messages.counts` | M | M | M | M | M | M | M | M | M | M |

A blank cell is a **policy** statement, not an omission. `credit.position` is blank for nine
workspaces because it is intern-only (V-1). `payslips.mine` and `wallet.balance` are blank for
`volunteer` because an unpaid contributor has no payroll.

### 19.2 Signal vs. workspace — what still resolves when a signal is missing

| Missing signal | exec | lead | mgmt | prof | acad | rsch | eng | ops | vol | intern |
|---|---|---|---|---|---|---|---|---|---|---|
| `seniority` NULL (hand-added record) | via `super_admin` or `exec` only | **unreachable** | reachable | reachable | reachable | reachable | reachable | reachable | reachable | via `classification` or `isIntern` |
| `functionKey` NULL | via seniority or role | reachable | reachable | reachable | via `users.role` | **unreachable** | **unreachable** | via `isHr` | reachable | reachable |
| `classification` NULL | reachable | reachable | reachable | reachable | reachable | reachable | reachable | reachable | **unreachable** | via `seniority` or `isIntern` |
| `hr_employees` row absent | denial | denial | denial | denial | denial | denial | denial | denial | denial | denial |

The Leadership, Research and Engineering rows are the honest cost of `application_id` and
`department_id` each having one writer. The mitigation is not more code: it is a `name="department"`
select on the Employment tab of `/admin/hr/employees/[id].astro`, which is one form field and is
listed as W-14 in Section 22.

### 19.3 Browser and device

| Target | Requirement |
|---|---|
| 360px viewport | Every widget legible with no horizontal scroll. The `attention` slot above the fold |
| No JavaScript | Every widget renders. Forms are the mechanism; drag and collapse are enhancements |
| Greyscale | Every status distinguishable by shape and label |
| Screen reader | DOM order equals visual order; each widget is a landmark region with its title as the accessible name |
| Offline | The service worker caches `/portal`; composed pages are server-rendered documents and cache normally. `/api` and `/admin` stay online-only |

---

## 20. Acceptance Criteria

Numbered so a reviewer can check each one against the live site. **Every criterion is observable.**

### 20.1 The defect being fixed

| # | Criterion |
|---|---|
| A-01 | A `super_admin` signing in at `/portal/employee` sees **no** credit-hours progress bar, **no** attendance percentage, **no** Days In counter and **no** Clock In control |
| A-02 | An intern signing in at `/portal/employee` sees all four, worded exactly as they are worded today |
| A-03 | A `department_head` sees leave and withdrawal approvals in the `primary` slot, above their own tasks |
| A-04 | An individual contributor with no special role sees their tasks first, and no approval queue |
| A-05 | A person whose `classification` is `volunteer` sees no wallet, no payslip, no bank card and no leave balance |
| A-06 | Every one of the five renders in under 12 widgets and under 14 queries |

### 20.2 Correctness of composition

| # | Criterion |
|---|---|
| A-07 | `resolveWorkspaceKind` is pure and its ten branches are each covered by a unit test with no database |
| A-08 | A person with every signal NULL and an active employee record resolves to `professional`, never to a blank page and never to `intern` |
| A-09 | `WORKSPACE_LAYOUTS` names no widget absent from the registry — asserted at module load, so violation fails the build |
| A-10 | No layout exceeds the widget cap — same assertion |
| A-11 | Grep of `src/pages/portal/employee.astro` for `user.role ===` returns zero matches |
| A-12 | Grep of `src/lib/workforce/config.ts` for `db.execute`, `sql\`` and `if (` returns zero matches |

### 20.3 Honesty

| # | Criterion |
|---|---|
| A-13 | With `employee_tasks` empty, `tasks.mine` renders its empty state; with the query failing, it renders the could-not-read sentence. The two are different strings and are both tested |
| A-14 | No widget whose `availability` is `no-data-source` appears in any layout — asserted at module load |
| A-15 | `attention.queue` withholds its headline count whenever any composing source failed |
| A-16 | `credit.position` renders "no credit-hour requirement recorded" and never "0%" when the term columns are unset |
| A-17 | `team.roster` and `attendance.team` always render `DEPARTMENT_COVERAGE_NOTICE` |
| A-18 | No widget renders a locked, greyed or "request access" card. A failed gate produces absence |

### 20.4 Safety

| # | Criterion |
|---|---|
| A-19 | `WorkforceContext` contains no `gender`, government ID, bank or salary field. Verified by reading the interface |
| A-20 | No composed widget queries any `wellness_*` table. `wellness.entry` is `component: 'link'` |
| A-21 | `opts.preview` never reaches a loader — verified by a test that passes a preview kind and asserts zero queries |
| A-22 | A preference row naming a widget outside the layout adds nothing |
| A-23 | `ResolvedPermissions.degraded === true` drops every permission-gated widget and sets `dashboard.degraded` |
| A-24 | Every `catch` in `src/lib/workforce/*` logs `e?.cause?.message || e?.message` — grep-verified |
| A-25 | Every postgres-js result is normalised with `Array.isArray(r) ? r : (r?.rows || [])`; grep for `.rows[0]` in `src/lib/workforce/*` returns zero matches |

### 20.5 Build and platform

| # | Criterion |
|---|---|
| A-26 | `npx astro check --minimumSeverity error` shows no **new** errors against the 195-error baseline of 2026-08-02 |
| A-27 | `npm run build` reaches `prerendering static routes`. It then fails on `src/pages/aaverify/addpanel.astro` because `DATABASE_URL` is empty in `.env`; that is expected and is not this work |
| A-28 | No emoji in any new file — grep-verified |
| A-29 | No `Record<string,string>` typed map inside JSX, no arrow character inside a JSX string, no `<script>` inside a JSX conditional, no `define:vars` with `is:inline` |
| A-30 | Every `const` used by the POST handler in `employee.astro` is declared above it |
| A-31 | Nothing under `src/layouts/`, `public/era/` or `.env*` is modified |

---

## 21. Testing Checklist

No browser is available in this environment, so items marked **manual** are the user's to run on the
live site. Reported success and observable result are not the same thing, and they have diverged
repeatedly on this project.

### 21.1 Unit — pure, no database

- [ ] `resolveWorkspaceKind` returns each of the ten kinds for a fixture context (10 cases)
- [ ] Every-signal-null context returns `professional`
- [ ] `founders` department with `roles.level = 'Intern'` returns `intern`, not `executive`
- [ ] `classification = 'permanent'` with designation "Internal Auditor" returns `professional`
- [ ] `classification = 'volunteer'` beats every function and seniority signal except `intern`
- [ ] `seniority = null` does not satisfy any negative predicate in any `visibleFor` (12.3)
- [ ] `applyPreferences` ignores ids absent from the layout
- [ ] `applyPreferences` cannot collapse or reorder a Universal Baseline widget
- [ ] `deterministicRanker` returns a permutation for every input, including the empty array
- [ ] The composer discards a ranker result whose id set differs from the input

### 21.2 Config assertions — run at module load, so they fail the build

- [ ] Every layout id exists in the registry
- [ ] No layout names a `no-data-source` widget
- [ ] No layout exceeds `MAX_WIDGETS_PER_PAGE`
- [ ] Every kind in `WorkspaceKind` has a layout
- [ ] Every layout contains all four Universal Baseline ids

### 21.3 Loader contract — one test per Buildable-now widget

- [ ] Returns `ok:true, empty:true` when the table is reachable and has no matching rows
- [ ] Returns `ok:false` with a sentence when the query throws
- [ ] Never returns `ok:true` with fabricated data
- [ ] Scopes in the WHERE clause; an empty scope yields no rows, never all rows
- [ ] Performs no write

### 21.4 Permission matrix — one case per row of Section 13.2

- [ ] Holder sees the widget; non-holder gets absence, not a locked card
- [ ] `degraded` permissions drop every gated widget
- [ ] `approver` widgets return only decidable rows, and the write re-checks
- [ ] `department` widgets return nothing without a scope

### 21.5 Regression — the behaviour that must not change

- [ ] Clock in, clock out, break start, break end still write `hr_clock_events` and `hr_attendance`
- [ ] The daily report still upserts on `(employee_id, report_date)`
- [ ] Add and delete time log still work, with the same validation messages
- [ ] `task_status` still passes `user.id` (a `users.id`) to `updateTaskStatus`, never `employee.id`
- [ ] The intern layout renders byte-comparable content to the pre-composer page for an intern fixture

### 21.6 Manual, on the live site — the user runs these

- [ ] **manual** Sign in as `super_admin`. Confirm A-01 by eye
- [ ] **manual** Sign in as an intern account. Confirm A-02
- [ ] **manual** Sign in as a `department_head`. Confirm A-03 and that `team.roster` shows the notice
- [ ] **manual** Resize to 360px. Confirm the attention slot is above the fold and nothing scrolls sideways
- [ ] **manual** Disable JavaScript. Confirm every widget still renders and every form still posts
- [ ] **manual** Force greyscale. Confirm statuses remain distinguishable
- [ ] **manual** Tab through the page. Confirm focus order matches visual order and every card is reachable
- [ ] **manual** Confirm the deployed commit is live: `git log origin/main..main` must be empty. Not live until pushed

### 21.7 Not executed in this environment, and stated as such

Runtime, accessibility and responsive behaviour of everything above are **unverified**: no server was
started, no URL was loaded, no query was run. Every "populated" claim in this document is an inference
from writer reachability in source, never an observation. "Nothing writes this" is reliable
(full-tree grep). "A live surface writes this" proves a path exists, not that anyone has walked it.

---

## 22. Implementation Tracker

Dependency order. Each item is buildable only after those above it.

| # | Work item | Files | Depends on | Status |
|---|---|---|---|---|
| W-01 | `WorkspaceKind`, `WorkforceContext`, `WidgetDefinition` types | `src/lib/workforce/types.ts` (new) | — | Not started |
| W-02 | Context engine | `src/lib/workforce/context.ts` (new) | W-01 | Not started |
| W-03 | Pure classifier + its unit tests | `src/lib/workforce/workspaces.ts` (new) | W-01 | Not started |
| W-04 | Widget registry, Buildable-now rows only | `src/lib/workforce/registry.ts` (new) | W-01, W-02 | Not started |
| W-05 | Loaders, one file per domain | `src/lib/workforce/widgets/*.ts` (new) | W-04 | Not started |
| W-06 | Layout config + module-load assertions | `src/lib/workforce/config.ts` (new) | W-03, W-04 | Not started |
| W-07 | Composer pipeline | `src/lib/workforce/composer.ts` (new) | W-02..W-06 | Not started |
| W-08 | `WidgetShell.astro` | `src/components/workforce/WidgetShell.astro` (new) | W-01 | Not started |
| W-09 | `StatTile.astro`, `ProgressMeter.astro`, `AttentionList.astro` | `src/components/workforce/` (new) | W-08 | Not started |
| W-10 | Lift the existing command centre into `AttentionList` with **no behaviour change** | `src/pages/portal/employee.astro` | W-09 | Not started |
| W-11 | Compose for `intern` only; every other kind falls through | `src/pages/portal/employee.astro` | W-07, W-10 | Not started |
| W-12 | Enable `professional`, then `management` | same | W-11 verified live | Not started |
| W-13 | Enable the remaining six kinds | same | W-12 verified live | Not started |
| W-14 | **`name="department"` select on the Employment tab** of `/admin/hr/employees/[id].astro` | that file | — | Not started. **Highest leverage non-composer item**: it is why Leadership, Research and Engineering are unreachable for hand-added records |
| W-15 | Task assignment form (a caller for `createTask()`) | `src/pages/portal/tasks/new.astro` (new) | — | Not started. Turns four dashboard questions from structurally-empty into answered. **No schema change** |
| W-16 | Wire `employee-tasks.ts` to `push.ts` on assign, block, review-request, approve | `src/lib/employee-tasks.ts` | W-15 | Not started. Three imports, four call sites. Until then the `watcher` role watches nothing |
| W-17 | Open the portal notification inbox to employees | `src/pages/portal/notifications.astro:8` | — | Not started. Rows are already written for them; only the door is shut. `notifications.unread`'s action link needs it |
| W-18 | Workspace switcher UI | `src/pages/portal/employee.astro` | W-13 | Not started |
| W-19 | Preferences read/write | `src/lib/workforce/preferences.ts` (new) | M-11 | Blocked on migration |
| W-20 | `deterministicRanker` | `src/lib/workforce/ranking.ts` (new) | W-07 | Not started |
| W-21 | Layout preview per role on `/admin/access-preview` | that file | W-06 | Not started |
| W-22 | Regression tests (21.1-21.5) | `tests/workforce/*` | W-07 | Not started |

### 22.1 Files this work must not touch

`src/layouts/`, `public/era/`, `.env*`. `src/lib/credit-ledger.ts` and `src/lib/credit-hours.ts` are
read-only for this work: the credit engine is correct and is shared with the completion letter.

---

## 23. Known Gaps

Only verified gaps. Each names its evidence. Historical blockers are not current blockers.

| Id | Gap | Evidence | Effect on this design |
|---|---|---|---|
| G-01 | **`employee_tasks` has no reachable INSERT.** `createTask()` has zero callers | Grep over `src/pages`, `src/components`, `.dev-scripts`, `scripts` | Every `tasks.*` widget renders a correct, gated empty state. Four of the ten dashboard questions are structurally empty until W-15 |
| G-02 | **`application_id` is not written by the manual add form** | `admin/hr/employees/index.astro:67` — the column is absent from the INSERT list | `seniority` is NULL for hand-added records, so Leadership is unreachable for them |
| G-03 | **`department_id` has one writer** (`hr/sync.ts:70`) | Full-tree grep | `functionKey` is NULL for hand-added records; Research and Engineering unreachable. W-14 fixes it with one form field |
| G-04 | **`reporting_manager_id` holds a `users.id`, not an `hr_employees.id`** | `hr-wallet.ts` compares it to `user.id`; `employee.astro:474` looks up by `user_id` | `directReportCount` and `reports.direct` must query by `users.id`. Joining to `hr_employees.id` matches zero rows and reads as "nobody reports to you" |
| G-05 | **`discussions` has a weak gate and four empty catches** | `portal/discussion.astro` — only `if (!user) redirect`; a failed post redirects showing success | `discussion.recent` is read-only and must not order by `is_pinned` (written by nothing) |
| G-06 | **`decideRequisition()` performs no role check**, and the stage comes from a hidden form field | `hr-requisition.ts` | `requisitions.mine` ships read-only. A "waiting on you" count would be wrong for everyone |
| G-07 | **The founder may have no `hr_employees` row** | `requireHr` and `requireTeamLead` deliberately do not require one; `requireEmployee` does | A `super_admin` with no employee record gets the "no employee record is linked" denial rather than the executive workspace. Either HR creates the record, or a future `requireEmployeeOrPrivileged` gate is added — **not** in 1.0, because loosening the base gate is how scope bugs start |
| G-08 | **`chat_messages` has two incompatible live shapes** | `setup-team-chat.mjs:24` + `schema.ts:723` vs `messages.astro:37` | `messages.counts` is Needs-migration and cannot be resolved from source. The `information_schema` query is the user's to run |
| G-09 | **`training_*` tables have no `CREATE TABLE` in the repo** | Full-tree grep; DDL lives only in a gitignored script | Every academic and learning widget is Needs-migration. The Academic workspace is currently Professional with a label |
| G-10 | **`hr_attendance.overtime_hours` is written by nothing** | 4 grep hits: 1 declaration, 1 ALTER, 1 comment, 1 `SUM()` read | `overtime.*` is No-data-source. `/admin/hr/attendance` already displays a structurally-zero total that reads as a real figure |
| G-11 | **`employee_acknowledged` on four lifecycle tables is written by nothing** | `hr-lifecycle.ts:57,78,101,122` | `probation.mine` and `pip.mine` are read-only. A PIP the person never saw is indistinguishable from one they accepted — a fairness problem, not a cosmetic one |
| G-12 | **`logAudit()` swallows its own exception** | `audit.ts:21`, which also logs the raw error rather than `e.cause?.message` | `audit.recent` must say "recorded changes", never "all changes" |
| G-13 | **`attachActivityFeed()` is never called** | `activity-feed.ts:192`, full-tree grep | `activity.feed` is near-empty by construction. One function call at boot fixes it |
| G-14 | **No preference table** | Full-tree grep | Personalization ordering and collapse are Needs-migration (M-11). Density and focus mode ship immediately, CSS-only |
| G-15 | **`ENGAGEMENT_VIAS` descriptions name real third-party companies** | `hr-classification.ts:36-43` | Those strings must not reach a user-facing surface. No widget in this document renders them; a future contractor workspace must not either |
| G-16 | **`user_role` has no `intern`, `employee` or `campus_ambassador` value**, yet four branches compare against them | `portal/submissions/new.astro:28-45`; `astro check` ts(2367) x4 | Nothing in this design branches on those strings. The Campus Ambassador category in Section 17 is blocked on it |
| G-17 | **No task, project or approval notification** | `employee-tasks.ts` imports db, drizzle, ensure-once, workspace-access and audit — never push, mail or the activity feed | A composed dashboard is the only place assigned work becomes visible. That raises the value of W-16, not the value of a widget |
| G-18 | **Runtime, accessibility and responsive behaviour are unverified** | No browser in this environment | Section 21.6 is the user's to run, and its result is the only evidence that will exist |

---

## 24. Design Decision Records

### DDR-001 — Roles are not hardcoded

**Decision.** Workspace resolution consumes `users.role`, `hr_employees.classification`,
`roles.level`, `departments.id` and the resolved permission set as **data**, in one ordered function.
No page, component or widget contains a role name.

**Why.** This codebase has already been taught this lesson. `PERMS_BY_ROLE` is exported so that
`/admin/access-preview` can *show* the matrix rather than have a second hand-typed copy drift away
from the real one. `ROLE_SECTIONS` was missing entries for three roles, and absence meant "no
filtering" — the widest view in the product, granted by an omission nobody would grep for. Permission
resolution moved into `registry.ts` where custom roles hold real grants and every sensitive grant is
audited and rolls back if the audit write fails.

A hardcoded role check re-creates all three failures at once: it cannot be previewed, it fails open
when a role is unlisted, and it is invisible to the audit trail.

**Consequences.** Adding a role or a category is a config change (Section 17.1). The classifier is
pure and its ten branches are unit-testable without a database. `/admin/access-preview` can render
what each role's home page will contain **before** anyone signs in.

**Rejected alternative.** A `workspace_kind` column on `hr_employees`, set by HR. Rejected: it is a
fourth place the truth could live, it would drift from `classification` and `roles.level` the first
time someone changed a job title, and there is no evidence anyone would maintain it. The signals
already exist; what was missing was a function that read them in a defined order.

---

### DDR-002 — The composer resolves server-side

**Decision.** Workspace, layout, visibility, permission and data all resolve in the Astro frontmatter.
The browser receives finished HTML. There is no client-side role check, no feature-flag payload, and
no widget that fetches its own data after render.

**Why.**

1. **A client-side check is not a check.** Anything the browser decides, the browser can be told to
   decide differently. `workspace-access.ts` states the principle already: nothing the browser
   sends — no `?employee=`, no hidden form field — may ever decide whose rows come back, and the
   narrowing must happen in the WHERE clause. Filtering after the query is not scoping; the row has
   already been read.
2. **Shipping the layout ships the org chart.** A client payload listing every widget with a
   `visible:false` flag is a map of what exists and who has it. Widgets that fail a gate are absent
   from the response entirely.
3. **The audience is on a phone.** One server-rendered document beats a skeleton that fills in.
4. **It is the codebase's own convention.** Forms are the mechanism, drag is the enhancement. Server
   re-validates every transition.

**Consequences.** Every loader is a server read. The widget cap (12) and the query cap (14) are real
constraints, enforced at module load. Personalization is stored server-side (M-11) rather than in
`localStorage` — a layout that silently resets on a new device is worse than no layout control.

**Rejected alternative.** An islands architecture where each widget hydrates and fetches. Rejected:
it multiplies the auth surface by the widget count, it makes "did the read happen" a per-island
question the page cannot answer, and it turns one document into fourteen requests on the connection
least able to afford them.

---

### DDR-003 — Intern widgets move rather than being deleted

**Decision.** Credit hours, attendance percentage, days in, clock controls and the daily report keep
their code, their wording and their engine. They are declared in the `intern` layout and in no other,
and they remain reachable at `/portal/workspace` for anyone whose engagement uses them.

**Why.**

1. **They are correct.** `credit-ledger.ts` maps `hr_attendance` plus approved `hr_leave_request` and
   is the same engine the completion letter uses. What an intern reads on this page is what their
   letter will say. Deleting it would break that guarantee for the only people with a stake in it.
2. **The complaint is placement, not existence.** A CEO does not want the credit bar removed from the
   product; they want it off their home page.
3. **Deletion is irreversible in a way that composition is not.** If the classifier is wrong for
   someone, they see the wrong screen and a one-line config change fixes it. If the widget were
   deleted, the fix would be a rebuild.
4. **This project has been punished for silent removals.** A number that quietly stops appearing is
   exactly the kind of absence nobody reports and nobody notices — the reason the credit loader's
   `catch` was changed from silent to logged in the first place.

**Consequences.** The intern layout is deliberately near-identical to today's page, which is why
rollout step 3 (Section 18.4) composes for interns first: the first composed render should look like
the known good page. The rule is stated as V-1 so it cannot be softened by a later layout edit.

---

### DDR-004 — A widget with no data source is not rendered

**Decision.** `availability: 'no-data-source'` widgets are specified in the registry, dropped in step
2 of the pipeline, and rejected from any layout at module load. **No placeholder. No zero. No "coming
soon". No greyed card.**

**Why.** This project has three live examples of the alternative, and each is worse than absence:

- `/admin/hr/attendance:163` sums `hr_attendance.overtime_hours`, which nothing writes. The total is
  structurally always 0 and reads as a real figure. Somebody will make a decision on it.
- `portal/parent.astro:218,248` queries `live_classes.start_at` and `.user_id`. Neither column
  exists. Both sit in bare `catch (_) {}`, so "Next class" is permanently null and `weeklyClasses` is
  permanently 0, **with nothing in the logs**.
- `admin/hr/performance.astro:98` LEFT JOINs `pr.reviewer_id`, declared nowhere. The query throws
  into a bare `catch(e){}` and the reviews list renders **empty with no error** — a silent wrong
  answer, worse than a crash.

A zero is a claim. "0 meetings today" asserts that the meeting count was computed and came to zero.
When no writer exists it means "we did not look", and those are different facts.

**Consequences.** The registry is longer than the shipped widget set: 28 rows exist to be
**refused**. That is deliberate. A refusal with its evidence attached stops the same widget being
proposed every quarter, and gives the next person the grep result rather than the intuition.

**The three-way distinction this creates, stated so nobody collapses it:**

| State | Meaning | Renders |
|---|---|---|
| No data source | Nothing can ever answer this | Nothing at all |
| Empty until | Source exists, cannot hold rows yet | The widget's empty state, in its own words |
| `ok:false` | Source exists, the read failed | "We could not read this just now" — never a count, never an empty state |

---

### DDR-005 — Professional is the floor, and a null signal is never a "no"

**Decision.** The classifier's last rule is unconditional for any active employee record. Every
predicate that tests a nullable signal must test `!== null` explicitly.

**Why.** `seniority` and `functionKey` are NULL for anyone HR added by hand, because
`application_id` and `department_id` each have one writer that a manual add does not go through. A
predicate like `seniority !== 'C-Level'` is **true** for those people, so a naive negative test hands
the non-executive branch to everyone with no data — which is the same class of bug as
`hasFaceEnrolled` swallowing its error into `false` and redirecting every user to `/enroll-face`
forever.

**Consequences.** Section 12.3 is a lint rule with concrete wrong and right examples. Section 19.2
states honestly which workspaces are unreachable per missing signal instead of pretending the
classifier is complete.

---

### DDR-006 — One route, not ten

**Decision.** `/portal/employee` composes. There is no `/portal/executive`, no `/portal/engineering`.

**Why.** The URL is already `BottomNav`'s `hr` destination, the target of four denial messages in
`workspace-access.ts`, and a bookmark. Ten routes would mean ten places to forget a gate, ten places
for the POST handler to drift, and a redirect chain deciding which one a person gets — a redirect
chain being exactly the shape of the sign-in outage this product has already had.

**Consequences.** One page, one POST handler, one set of Astro traps to respect. The workspace
switcher is a preference, not a route.

---

### DDR-007 — Every loader reports whether the read happened

**Decision.** `WidgetLoadResult` carries `ok` and `empty` as separate booleans. `WidgetShell` renders
three distinct states.

**Why.** `myTasksView()` exists for precisely this reason (`employee-tasks.ts:992`):
`listMyTasks()` returns `[]` on failure and on emptiness alike, so "you have no tasks" and "the query
threw" arrive identically — and the card would print "Nothing on your list right now" at somebody
whose task table could not be read. That is a claim, not an absence, and it is the same failure shape
as a green flash over a write that never landed. `/portal/employee` already withholds its headline
count when a source did not run; this generalises it.

**Consequences.** Every loader in Section 21.3 is tested for all three states. `dashboard.degraded`
suppresses any all-clear headline across the whole page, not just within the failing card.

---

### DDR-008 — Personalization reorders; it never reveals or hides

**Decision.** Preferences are a sort key over the layout. The layout is a whitelist. Ids in a
preference row that are absent from the layout are ignored, never added.

**Why.** A preference row is user-controlled data stored in the database. A composer that **added**
widgets from it would let a person compose a dashboard they were never granted — a scope bug with a
friendly name. And a preference that could **hide** `attention.queue` would let somebody hide the
fact that a colleague is waiting on them, which is an organisational failure rather than a
personalisation feature.

**Consequences.** The Universal Baseline is pinned. Section 20.4's A-22 tests the whitelist property
directly. The same rule constrains AI (DDR-009): a ranker returns a permutation, never a set.

---

### DDR-009 — AI is a sort key with a deterministic default, or it is nothing

**Decision.** No AI in 1.0. If it is ever added, it sits behind `WidgetRanker` whose default
implementation is deterministic and requires no model, no network and no configuration. The composer
discards any ranker result whose sorted id set differs from its input.

**Why.** Per the Sovereignty Constitution, core capability is first-party and self-hostable, and
proprietary services are optional connectors behind swappable interfaces. More immediately: **nothing
in this document needs AI to work.** Every gap named here is a missing table, a missing form or a
missing function call. Framing personalisation as an AI problem would defer W-14 and W-15, which are
one form field and one form respectively and are worth more than any ranking.

**Consequences.** Section 15.5 specifies the deterministic ranker completely, so it ships as the
product rather than as a placeholder. Section 15.4 marks dwell time and interaction history as
No-data-source: no client telemetry is collected, and adding it is a separate product decision with
its own consent question.

---

### DDR-010 — Private data never enters the composer

**Decision.** `WorkforceContext` carries no `gender`, no government ID, no bank detail, no salary and
no health value. No composed widget queries any `wellness_*` table. Wellness is `component: 'link'` on
every workspace, shown to everyone, conditioned on nothing.

**Why.** On 2026-08-02 a survey task read staff gender data out of `hr_employees` while building the
women's wellness system, whose entire premise is that nobody reads private health data without
consent. `EMPLOYEE_COLUMNS` in `workspace-access.ts:155` is an explicit allow-list written in response,
and `gender` is the exact column that was read. `wellness.ts` deliberately ships no "read any user's
log" helper and suppresses aggregates below `MIN_GROUP`; that absence is the feature.

A context object is the worst possible place for a sensitive field, because it reaches the render
scope of **every** widget on **every** workspace, plus every log line and every error dump.

**Consequences.** V-6 requires the wellness link to be unconditional. Conditioning its visibility on
anything — gender, department, engagement — would disclose a health-relevant fact through the layout
itself, which is the failure mode with no error message. A-19 and A-20 verify the rule by reading the
interface and grepping the loaders.

---

## 25. Changelog

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-02 | Initial specification. Ten workspaces; 95 registry widgets (54 Buildable-now, 13 Needs-migration, 28 No-data-source and refused); 12 migration entries M-00 to M-11, of which M-00 is code-only; 22 work items; 10 design decision records. |

### 25.1 Verification status of this document

Reported per pipeline stage, honestly. **This document is a Markdown file. It enters no build graph
and changes no behaviour.**

| Stage | Result |
|---|---|
| **Source verification** | **EXECUTED.** Every schema claim was checked against `src/lib/db/schema.ts` and against writers this session. Confirmed independently: `hr_employees.classification` is created by `hr-classification.ts:15` and written by `admin/hr/classification/index.astro:22`; `roles.level` is the `role_level` enum with seven values and is reachable only via `hr_employees.application_id`; the manual add form at `admin/hr/employees/index.astro:67` writes neither `application_id` nor `department_id`; `employee_tasks` has no estimate or effort column (`employee-tasks.ts:626-650`); no finance, revenue, invoice or expense table exists in `src/` or `db/`; the live department slugs are the 15 seeded at `scripts/seed.ts:35-49`; `users` has `name`, not `full_name`; `notifications` self-CREATEs at `notifications-schema.ts:15` and is written by `push.ts:138` and `notify.ts:35` |
| **`astro check --minimumSeverity error`** | **EXECUTED as a baseline: 195 errors across 1449 files.** All pre-existing — no TypeScript or `.astro` file was created or modified, so this document cannot have changed the count. The captured tail independently re-confirms `portal/submissions/new.astro:28-29` comparing `user.role` against `'campus_ambassador'` and `'intern'`, neither a `user_role` value, which is Known Gap G-16 |
| **Compilation** | **NOT APPLICABLE.** No source file was created or modified |
| **Prerender** | **NOT APPLICABLE.** Same reason |
| **Runtime** | **NOT EXECUTED.** No server started, no URL loaded, no query run |
| **Accessibility** | **NOT EXECUTED.** No page rendered |
| **Responsive** | **NOT EXECUTED.** No page rendered |
| **Migrations** | **NOT APPLIED.** No SQL in this document has been run against any database, and none should be run by an agent. Per `CLAUDE.md`, schema changes are handed to the user to run |

**CLAUDE.md compliance:** no database connection was opened, no `.env*` file was read, no script that
opens a connection was run, and no file outside `docs/workforce-os/` was created or modified.

**The one question this document cannot answer from source:** which shape of `chat_messages` is live.
That requires an `information_schema` query, which is the user's to run, and it is the sole blocker on
M-02 and on `messages.counts`.
