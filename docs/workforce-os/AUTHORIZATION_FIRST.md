# Authorization-First Execution — binding addendum to WORKFORCE_OS_MASTER_SPEC.md

This is the load-bearing rule of the Workforce OS. Everything else in the master spec is detail.

## The pipeline, and the boundary

```
Request
  -> Authentication
  -> Identity resolution
  -> Organization resolution
  -> Employment resolution
  -> Workforce context resolution
  -> Permission resolution
  -> Capability resolution
  -> Feature-flag resolution
  -> Workspace eligibility resolution
  -> Navigation composition
  -> Widget eligibility resolution
  ================ AUTHORIZATION BOUNDARY ================
  -> Widget data loaders execute      <-- FIRST database access happens HERE
  -> Workspace composition
  -> Rendering
  -> Audit logging
```

No query belonging to a widget may execute above that line.

## Why the boundary sits there

Fetch-then-filter is the failure this architecture exists to prevent, and it is subtle because the
screen looks identical either way. If a payroll loader runs and its rows are discarded during render:

- privileged rows entered the request context, and can leak through an error page, a log line, a
  stack trace, or a serialised island prop;
- the query was a real database access by an unauthorised principal, so the audit log either records
  an access that should never have happened, or — worse — does not record it at all;
- caching layers may retain the result and serve it to a later request;
- every person who cannot see the widget still pays its cost on every page load.

**A widget rendering nothing is not evidence that nothing was read.**

## Implementation obligation

`composeWorkspace()` returns the eligible widget list. Loaders are attached to widget definitions as
**deferred functions**, invoked only for widgets that survive eligibility.

A widget definition must not perform data access at module scope, at import time, or in a
constructor. **Registration is inert.**

## No unauthorized data access

A hidden widget must never load an API, execute SQL, instantiate a repository, run an ORM query, open
a database connection, call a remote service, populate server-side request context, cache data, or
preload information.

Filtering after fetching is prohibited — including for data that seems "not sensitive". That
classification is not a judgement to be made at the point of use.

## Capability vocabulary, not role names

`role === 'hr'` and `role.includes('intern')` are both defects. The second is not hypothetical here:
its sibling `role.indexOf('hr') >= 0` gave approval authority over leave and money to any role whose
name merely contained those two letters.

A widget declares what it must be **able to do**, never who holds it:

`CanApproveLeave` · `CanApprovePayroll` · `CanApproveRecruitment` · `CanApproveTravel` ·
`CanApproveExpenses` · `CanApprovePerformance` · `CanApproveResearch` · `CanManageEmployees` ·
`CanManageProjects` · `CanManageDepartments` · `CanManageLearning` · `CanManageCommunity` ·
`CanModerateCommunity` · `CanPublishAnnouncements` · `CanCreateResearch` · `CanViewPayroll` ·
`CanViewFinance` · `CanViewExecutiveDashboard` · `CanViewLegalHold` · `CanViewWellness` ·
`CanViewCompliance` · `CanViewOrganizationAnalytics` · `CanViewResearchAnalytics` ·
`CanViewHiringAnalytics` · `CanViewExecutiveReports` · `CanViewAuditLogs` · `CanAccessAIInsights`

`CanViewWellness` is deliberately limited to **aggregate programme health**. No capability grants
sight of an individual cycle or symptom record, because no such capability may exist. See
`src/lib/wellness.ts`.

## Widget registration is a runtime assertion

A widget registers **only if** its tables, columns, APIs, permissions and capabilities all exist.
Otherwise registration fails, the reason is recorded, and bootstrapping continues.

One widget failing must never crash the workspace. A workspace missing a widget is degraded; a
workspace that fails to load is an outage.

This is not theoretical. Five production faults in one week came from querying columns that existed
only in a schema file or in someone's memory: `hr_employees.work_email`, `hr_task_log`,
`meet_rooms.scheduled_at`, `users.consent_given_at`, and `users.full_name` (the table has `name`).
Registration-time verification converts that class of fault from a 500 into a logged, contained
absence.

## Data source classification

Exactly one per widget.

| Classification | May register |
|---|---|
| Buildable Now | yes |
| Computed / Derived | yes, if every input is Buildable Now |
| Configuration Only | yes |
| External Integration Required | only when the integration is live and verified |
| Experimental | behind a feature flag, off by default |
| Deprecated | no — scheduled for removal |
| Needs Migration | **no** |
| No Data Source | **no** |
| Unknown | **no** |

The bottom three are documented and absent from production.

## Fail closed

Unknown capability, permission, employment type, organization, department, reporting structure,
feature flag, data source, widget, navigation item or API — and any missing migration, missing
schema, database timeout, remote timeout, incomplete profile or corrupted session — produces the
**safest** experience, never the fullest.

Safest: hide functionality, hide data, hide navigation, record diagnostics, log for audit, render a
safe fallback, keep operating. Never guess. Never infer. **Unknown means hidden.**

The direction matters more than any single outcome. Someone who cannot see what they are entitled to
raises a ticket and it is fixed within the hour. Someone who sees what they are not entitled to may
never mention it, and the disclosure cannot be withdrawn.

## Universal Workspace

Every authenticated member receives only: Messages, Notifications, Calendar, Search, Community,
Personal Profile, Settings, Help.

It carries no privileged business information. It is also the fallback when context resolution fails
— which is precisely why it stays minimal, since a resolution failure is the moment the system knows
least about who it is talking to.

## Verification matrix

Personas: Founder, CEO, COO, CTO, CFO, Director, HR Director, Manager, Research Scientist, Professor,
Software Engineer, Recruiter, Finance Officer, Volunteer, Campus Ambassador, Intern, External
Consultant.

Per persona verify navigation, widgets, permissions, capabilities, data sources, responsive behaviour
and accessibility — plus the three negative assertions that carry the whole security guarantee:

- no unauthorized API call
- no unauthorized SQL statement
- no unauthorized widget registration

**The negative assertions are the point.** Confirming a founder sees no credit-hours widget is a UI
test. Confirming that no credit-hours query *ran* is a security test, and only the second one proves
the authorization boundary holds.

## Acceptance criteria

A Founder never sees internship widgets. A CEO never sees attendance or credit hours without an
explicit employee attendance context. An Intern never sees executive financial dashboards. A Research
Scientist never sees payroll without authorization. An unknown user receives only the Universal
Workspace. Unknown capabilities, permissions and widgets expose nothing. Missing data never renders
fabricated information. Every widget carries a documented data source, dependencies, verification,
accessibility, performance and security notes.
