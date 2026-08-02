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

## Missing capabilities (migration required, do not fake)

- **Projects** — no table. Tasks have no project relation.
- **Approval chains** — no `approval_chains` / `approval_requests` / delegation tables. `approverRole()` in `src/lib/hr-wallet.ts:146` answers one question about one request: super_admin, admin, exact role `hr`, or `hr_employees.reporting_manager_id`. No sequence, no delegation, no escalation, no expiry.
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
