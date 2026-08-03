# Known gaps

Only verified gaps. Each names the evidence. Historical blockers are not current blockers.

## Declared-but-not-existing (the outage class)

Three production outages this week came from querying a column a schema file declared and the live
database did not have. Verify against **writers**, never against `db/hr-schema.sql`.

| Column / table | Evidence | Status |
|---|---|---|
| `hr_employees.work_email` | Log: `[admin-access] employee lookup column "work_email" does not exist`. Locked every admin out of `/admin`, and made `/portal/employee` report "no employee profile found". | Column now created via `ensureOnce` in `src/pages/portal/employee.astro`. |
| `hr_task_log` | Log: `relation "hr_task_log" does not exist`. Only CREATEd inside the clock-out handler, so absent until someone clocked out. | Created in the same ensure block. |
| `meet_rooms.scheduled_at`, `duration_min`, `invitees`, `recurrence` | Declared in `src/pages/portal/meet/index.astro`. Sole INSERT (`meet/[id].astro:98`) writes only `id, host_user_id, title, kind`. | **Open.** No meetings capability may be built until a writer exists. |
| `meet_rooms.host_user_id` | Declared `INTEGER`; `users.id` is UUID. | **Open.** Schema contradicts its own reader. |

## RESOLVED 2026-08-02 — `users.full_name` does not exist

`users` has `name` (`src/lib/db/schema.ts:50`). Four files queried `u.full_name`, which throws.
`/portal/messages` returned HTTP 500 for every signed-in user with a thread. Fixed by aliasing at
the query boundary (`u.name AS full_name`) so callers are unchanged.

Files corrected: `src/pages/portal/messages.astro` (3 sites), `src/lib/gamification.ts`,
`src/lib/legal-hold.ts` (2 sites). **`legal-hold.ts` was mine** — the participant and sender-name
lookups in the founder held-records surface would have failed the same way.

Fifth instance of declared-vs-existing this week. The pattern is now unmistakable: this codebase
routinely queries columns that exist only in someone's mental model. Verify against
`src/lib/db/schema.ts` and the writers, never against intuition or `db/hr-schema.sql`.

## Follow-up: department is optional on save, and should not stay that way

**Status: deliberate, temporary. Owner: HR. Unblocks on backfill.**

`hr_employees.department_id` is now written by two more paths — the Employment tab
(`src/pages/admin/hr/employees/[id].astro`) and the manual add form
(`src/pages/admin/hr/employees/index.astro`) — alongside the one that already existed
(`src/lib/hr/sync.ts:62-77`, on an application turning `hired`).

It is **not** mandatory on either form, on purpose. Nearly every existing row has `department_id`
NULL, and a hard requirement would refuse to save designation, salary, PAN or dates on exactly those
records — locking HR out of editing the rows that most need editing. Both surfaces instead state the
consequence in place: the employee record shows a "no department set" banner, and the list card shows
"Not set. They appear in no department list." A submitted department that is not on the register is
refused outright, because a value matching nothing reads as assigned while behaving as unassigned.

**The rule to apply once backfill is done:** department required on CREATE (the add form and
`syncHiredToEmployee`), still optional on EDIT so historical rows stay editable. Sequence:

1. Backfill: every active `hr_employees` row gets a department. Verify with a count of
   `department_id IS NULL AND is_active = true` — this is a production read, so it is a command handed
   to the user, not run here.
2. Make the add form's select `required` and refuse an empty value server-side.
3. Only then consider `NOT NULL`; until step 1 is provably complete it would break every write path.

Until step 1, `DEPARTMENT_COVERAGE_NOTICE` (`src/lib/auth/workspace-access.ts:150`) must stay under
every list built with `departmentFilter()` — a department-scoped list is still shorter than the team.

## Missing capabilities (migration required, do not fake)

- **Projects** — no table. Tasks have no project relation.
- **Approval chains** — no `approval_chains` / `approval_requests` / delegation tables. `approverRole()` in `src/lib/hr-wallet.ts:146` answers one question about one request: super_admin, admin, exact role `hr`, or `hr_employees.reporting_manager_id`. No sequence, no delegation, no escalation, no expiry.
  - Cycles are refused at the one write boundary that exists: `src/pages/admin/hr/employees/[id].astro` rejects self-report and walks the line up to 12 levels, refusing any proposed manager whose own chain returns to this employee. This is application-level only — there is no database constraint, so a row written by any other path (a direct SQL fix, a future importer) can still loop, and `approverRole()` does not defend against one.
- **Task threading** — `employee_task_comments` has no `parent_id`. `CommentThread.astro` ships without reply forms for this reason.
- **Leave entitlement** — `LEAVE_TYPES` in `src/lib/hr-leave.ts:11` is a constant in code (casual 12, sick 12, earned 15). No per-employee balance, accrual or carry-forward table.
- **Attendance intelligence** — no data source for weather, battery, internet quality, Bluetooth beacon, or burnout signals. Several also require device permissions not currently requested.

## Identity columns with no CREATE anywhere (declared-vs-existing, unresolved)

Found by the architecture survey. Each is read and written by real code, and has **no** `CREATE` or
`ALTER` in `src/` or `db/` — they exist only if production already had them. Every write sits in a
swallowing try/catch, so a missing column is silent.

- `users.identity_verified`, `users.id_doc_url`, `users.reg_fee_paid` — same class as `work_email`.
- `users.consent_given_at`, `users.consent_ip` — `astro check` errors ts(2769) at
  `src/pages/portal/signup.astro:67`: Drizzle does not map them, so the consent record is **not
  being stored** the way the code reads it. Consent evidence that is not written is not evidence.
- `departments` has two contradictory definitions: `src/lib/db/schema.ts:80` (id `varchar(50)`, a
  slug) is the live shape; `db/hr-schema.sql:31` (id UUID) describes a table that does not exist in
  that form. **Never cast `department_id` to `::uuid`.**
- `user_role` enum has no `intern`, `employee` or `campus_ambassador` values, yet
  `src/pages/portal/submissions/new.astro:28-45` compares against all three — four dead branches.

## Environment

`DATABASE_URL` is empty in `.env`; populated in `.env.production`. Consequence: `npm run build` fails at prerender on `src/pages/aaverify/addpanel.astro`. Compilation is still provable by confirming the build reaches `prerendering static routes`.
