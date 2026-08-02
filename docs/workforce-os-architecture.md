# Workforce OS — capability inventory and architecture gap report

Source-only survey. No database connection was opened, no `.env*` file was read, no script that
opens a connection was run. Every statement below comes from `src/`, `db/hr-schema.sql`,
`src/lib/db/schema.ts`, `scripts/` and `docs/`.

## The rule this document is written under

**A declared column is not an existing column.**

`db/hr-schema.sql` declared `hr_employees.work_email` and `hr_task_log`. Neither existed in
production. Querying them caused three separate outages: every admin locked out of `/admin`, every
employee told "no employee profile found", and a redirect loop that blocked sign-in entirely.

So every capability below is classified on **what application code WRITES**, established by grepping
`INSERT` column lists and `UPDATE ... SET` clauses — never on what a schema file declares. A table
nothing writes is an empty table. A column only a schema file mentions is a liability, not a
capability.

Three consequences of that rule, stated once so they are not re-litigated per row:

1. A **complete engine on an unwritable table is `Blocked`, not `Complete`.** `employee_tasks` has a
   2,100-line workflow engine, a board, a detail page, comments, collaborators and an audit trail.
   `createTask()` has zero callers. The status is `Blocked`.
2. **"Populated" is not observable from source.** Every populated/empty judgement here is an
   inference from writer reachability. "Nothing in the tree writes this" is reliable (full-tree
   grep). "A live surface writes this" proves a path exists, not that anyone has walked it.
3. **Self-bootstrapping is the only migration mechanism this project has.** There is no migration
   runner. A table that CREATEs itself at runtime exists; a table that lives only in
   `db/hr-schema.sql` exists only if someone applied that file by hand.

---

## 1. Capability inventory

Status values: **Complete** (writable, readable, gated, reachable) · **Partial** (works, with a named
hole) · **Blocked** (built but cannot function — no writer, or a schema collision) · **Missing** (no
table, no code).

### 1.1 Identity, access and org structure

| Capability | Purpose | Status | Database (writers) | API | Permissions | Reusable components | Missing dependencies | Migration required | Verification |
|---|---|---|---|---|---|---|---|---|---|
| **Authentication** | Sign in | **Complete** | `users` (6 insert sites), `sessions` (`src/lib/auth/session.ts:26`) | form POST only | cookie → `validateSessionToken` | `src/lib/auth/session.ts`, `cookie.ts` | — | none | Source-verified. Not runtime-tested |
| **Multi-method auth** | Passkey / TOTP / face as alternatives | **Complete** | `user_passkeys`, `user_totp`, `user_backup_codes` — all self-CREATE (`webauthn.ts:113`, `twofactor.ts:21`) | `/api/2fa/*`, `/api/auth/totp-login` | self-service, own account | `TwoFactorPanel.astro` | — | none | Source-verified |
| **Face enrolment gate** | Mandatory identity check | **Partial — high risk** | `user_face_enrollments`, 5 writers | `/api/auth/enroll-face*` | signed-in self | — | **No CREATE anywhere in the application.** Exists only in `.dev-scripts/*` and `face-2fa-portable/migration.sql` | **YES — see 3.1** | Source-verified. `middleware.ts:388` hard-gates every `/admin` and `/portal` path on it; `hasFaceEnrolled` swallows the error and returns `false`, so a missing table redirects *every* user to `/enroll-face` forever. That is the shape of the reported redirect-loop outage |
| **Session lifecycle** | 30-day sliding renewal, kill on deactivate | **Complete** | `sessions` | — | — | `session.ts:8-9`, `:55` | — | none | Source-verified |
| **Role model (built-in)** | 11-value `user_role` enum | **Partial** | `users.role` | — | `ROLE_SECTIONS` (`permissions.ts:178`) | `permissions.ts` | Enum has no `intern`, `employee` or `campus_ambassador`; `portal/submissions/new.astro:28,29,30,45` branches on all three | none — code fix | `astro check` flags all four as `ts(2367)` dead branches |
| **Custom roles + permission registry** | Per-role capability grants | **Complete** | `team_roles`, `user_role_assignments`, `role_permissions`, `permission_catalogue`, `role_permission_grants` — all self-CREATE (`registry.ts:268-341`), catalogue re-seeds every boot (`:403`) | — | `can()`, audited; sensitive grants roll back if the audit write fails (`registry.ts:1089`) | `PermissionGate.astro`, `registry.ts` | — | none | Source-verified. **This is the best-engineered subsystem in the codebase** |
| **Departments** | Org units | **Partial** | `departments` — 3 writers (`admin/departments/index.astro:39`, `[id].astro:58`, `roles/index.astro:53`) | — | `roles.edit` + section `departments` | — | **Two irreconcilable definitions.** `schema.ts:80` = `id varchar(50)` slug (LIVE — every writer supplies a slug and a NOT NULL icon). `db/hr-schema.sql:31` = `id UUID` with different columns. `CREATE TABLE IF NOT EXISTS` makes the second a no-op | none — delete the dead block | Source-verified. **`departments.id` is TEXT. A `::uuid` cast throws** |
| **Employee records** | The HR row | **Partial** | `hr_employees` — 3 disagreeing creation paths (`hr/sync.ts:60`, `hire-transfer.ts:34`, `admin/hr/employees/index.astro:67`) | — | section `employees` | `workspace-access.ts` `EMPLOYEE_COLUMNS` allow-list | `department_id` written by **one line** (`hr/sync.ts:70`); `user_id` NULL for two of three creation paths; `work_email` written by **nothing** | **YES — see 3.2** | Source-verified. `employee_code` is UNIQUE but generated three ways; the `COUNT(*)+1` form collides after any deletion or two concurrent adds |
| **Reporting line** | Who approves for whom | **Partial** | `hr_employees.reporting_manager_id` — **one writer** (`admin/hr/employees/[id].astro:157`) | — | section `employees` | — | No hierarchy table. One nullable column, no chain, no skip-level, no history. **Holds a `users.id`, not an `hr_employees.id`** | optional — see 3.3 | Source-verified. The `workspace-access.ts:184` comment calling it unread is **stale** — 5 readers now |
| **Team-lead scope** | Department leadership | **Partial** | `users.role='department_head'` + `users.assigned_department_id` | — | `isLeadSql()` (`employee-tasks.ts:789`) | `workspace-access.ts` | `assigned_department_id` is set **only** by `/admin/users`; a lead owns a *department*, never a named list of people | none | Source-verified |
| **Audit trail** | Who changed what | **Partial** | `audit_log` via `logAudit()` | — | section `audit` | `src/lib/audit.ts` | `logAudit` **swallows its own exception** (`audit.ts:21`) — the trail is incomplete by construction. It also logs the raw error, violating the `e.cause?.message` rule | none — code fix | Source-verified. The intern bulk-demotion (`intern-guard.ts:38`) changes `users.role` for arbitrarily many accounts and writes **no audit row**, only a `console.warn` |

### 1.2 Work — tasks, comments, collaborators

| Capability | Purpose | Status | Database (writers) | API | Permissions | Reusable components | Missing dependencies | Migration required | Verification |
|---|---|---|---|---|---|---|---|---|---|
| **Task engine** | Assigned work with a real state graph | **BLOCKED** | `employee_tasks`, self-CREATE `employee-tasks.ts:627`. **The only INSERT is `createTask()` at `:1604`, and it has ZERO CALLERS** — re-verified this session by grep over `src/pages`, `src/components`, `.dev-scripts`, `scripts` | none — form POST | `visibleToSql()` (`:814`) = assignee OR assigner OR collaborator OR department lead; empty viewer compiles to `false` | `TaskCard`, `StatusBadge`, `PriorityFlag`, `FilterBar`, `Timeline`, `Dialog`, `EmptyState` | **An assign surface.** Nothing else | **NO** — table self-bootstraps. It needs a *form*, not SQL | Source-verified. **No code path in the application can create a task.** Unless rows were inserted by hand in `psql`, the table is empty and the board, the detail page and the portal card all render an empty state |
| **Task status transitions** | 10-state graph with explicit edges | **Complete (engine) / Blocked (data)** | `moveTask()` `:1764`, reached from `portal/tasks/index.astro:243`, `[id].astro:174/206/237`, `employee.astro:265` | — | role-gated per edge (`:249-318`) | `employee-tasks.ts` | rows to move | none | Source-verified. Legacy `open`/`done` normalised in SQL by `CANON` (`:752`) |
| **Task comments** | Discussion on a task | **Blocked** | `employee_task_comments`, `addComment()` `:1854` | — | entitlement re-derived **inside** the `INSERT ... SELECT` | `CommentThread.astro` | FK to `employee_tasks` — no task, no comment | none | Source-verified. Five columns exactly: no `parent_id`, no read state, no mentions, no receipts |
| **Task collaborators** | co-assignee / reviewer / approver / watcher | **Blocked** | `employee_task_collaborators`, `addCollaborator()` `:1965` | — | double-enforced — `collaboratorRolesAddableBy()` for the UI, `actorHasAnyRoleSql()` re-derived inside the INSERT | `AvatarStack.astro` | same FK dependency | none | Source-verified. An assignee cannot make themselves approver. **`watcher` notifies nobody** — this module never calls push, mail or the activity feed |
| **Task admin surface** | HR/manager view of all work | **Missing** | — | — | — | — | Nothing under `src/pages/admin` references any `employee_task*` table | none | Grep-verified |
| **Projects / epics / milestones** | Group work | **Missing** | — | — | — | — | **No `projects` table, no `project_id`, no `projectId` anywhere in `src/` or `db/`** — re-verified this session. No programme, portfolio, epic, sprint, milestone or workstream table either | **YES — see 3.4** | Grep-verified |
| **Subtasks / dependencies** | Structure between tasks | **Missing** | — | — | — | — | No `parent_task_id`, `blocked_by`, `depends_on`, checklist or rank column | **YES — see 3.4** | Source-verified (`portal/tasks/[id].astro:22` states it) |
| **Self-reported work log** | What I did today | **Partial** | `hr_task_log` — **one writer**, `portal/employee.astro:185`, reachable only inside the `clock_out` branch and only when the text field is non-empty, inside a silent `try/catch` | — | self only | — | **Zero admin readers** — full-tree grep. What someone types at clock-out reaches nobody | none (self-CREATEs since `61efa4f`) | Source-verified. Sparse at best |
| **Offline work log** | Work captured without a connection | **Complete** | `offline_work`, self-CREATE `api/offline/sync.ts:13`, `ON CONFLICT DO NOTHING` for replay safety | **`POST /api/offline/sync`**, `GET /api/offline/mine` | own rows; all rows on `/admin/offline-work` | `public/offline-sync.js` | Payload is opaque `jsonb` — never reaches `employee_tasks`, `hr_time_logs` or `hr_task_log` | none | Source-verified |

### 1.3 Time, attendance and leave

| Capability | Purpose | Status | Database (writers) | API | Permissions | Reusable components | Missing dependencies | Migration required | Verification |
|---|---|---|---|---|---|---|---|---|---|
| **Clock in / out** | Punch | **Partial** | `hr_clock_events` (1 writer, `portal/employee.astro:159`); `hr_attendance` (`:168`, `:175`) | — | self write; admin read | — | Both attendance writes are `.catch(() => {})` — the page prints "Clocked out" even when the row did not update. Clock-in is `SET clock_in = NOW()`, so a second punch overwrites the first | **YES — see 3.1** (no runtime DDL for either table) | Source-verified |
| **Break tracking** | Deduct breaks from hours | **Missing** | `break_start`/`break_end` rows are stored and touch nothing | — | — | — | `work_hours` is raw `NOW() - clock_in` with nothing subtracted (`employee.astro:177`) | column-level | Source-verified |
| **Overtime** | Pay/track extra hours | **BLOCKED** | **`hr_attendance.overtime_hours` is written by NOTHING.** Re-verified: 4 grep hits total — 1 declaration, 1 ALTER, 1 comment, and 1 `SUM()` read at `admin/hr/attendance/index.astro:163` | — | — | — | No overtime rule, rate, threshold or approval anywhere | — | **The overtime total on `/admin/hr/attendance` is structurally always 0** |
| **Manual hour blocks** | Timesheet | **Partial** | `hr_time_logs` — 2 writers, both employee-side | — | self only; backfill capped at 7 days | — | **No admin writer or editor.** The portal copy tells employees to "ask HR" for older entries — that route does not exist in code. `start_time`/`end_time` are TEXT, ordered lexicographically | **YES — see 3.1** | Source-verified |
| **Daily report** | Narrative status | **Complete** | `hr_daily_reports`, 1 writer, 5 readers incl. 3 admin surfaces | — | self write, admin read | — | — | **YES — see 3.1** (no runtime DDL) | Source-verified. `admin/hr/attendance/index.astro:117` LEFT JOINs it in a **top-level `await` with no try/catch** — on a database missing the table that page 500s outright |
| **Leave** | Apply, cancel, decide | **Complete** | `hr_leave_request` — **self-bootstrapping** (`hr-leave.ts:20-37`), 3 writers, audited | — | apply/cancel self; decide via `approverRole()` — exact role match plus `reporting_manager_id` | `hr-leave.ts` | Single-step only — no chain, no escalation, no delegation | none | Source-verified. **The healthiest table in the HR domain.** Approval writes one `hr_attendance` row per calendar day, capped at 400, refusing to overwrite a day already present/wfh |
| **Leave balance** | Entitlement | **Partial** | none — entitlement is the code constant `LEAVE_TYPES` (`hr-leave.ts:11`), consumption is a `SUM` per calendar year | — | — | — | No balance table: no carry-forward, no accrual, no pro-rata for a mid-year joiner, no per-employee override | **YES — see 3.5** | Source-verified |
| **Holiday calendar** | Non-working days | **Missing** | `holiday` is a status value an admin picks by hand, and a `DayStatus` in `credit-hours.ts:21` | — | — | — | Nothing enumerates public holidays or weekends, so "absent" is computed against **calendar** days | **YES — see 3.5** | Source-verified |
| **Credit hours** | Engagement completion | **Partial** | **No table — derived on every page load.** `credit-hours.ts` is pure arithmetic with no DB import; `credit-ledger.ts` maps `hr_attendance` + approved `hr_leave_request` | — | inherited from the calling page | `credit-hours.ts`, `credit-ledger.ts` | Terms live in 4 columns that exist **only** via runtime ALTER (`credit-ledger.ts:214`) and appear in **no** schema file | none — already ensured correctly | Source-verified. The `half-day` branch is **unreachable**: `hr_attendance.status` has no such value. "Authorised" leave is derived (approved request whose `requested_at` predates `start_date`), never trusted to a flag |
| **Shifts / rosters / timesheet approval** | — | **Missing** | — | — | — | — | No such table, no DDL | out of scope | Grep-verified |

### 1.4 Money and documents

| Capability | Purpose | Status | Database (writers) | API | Permissions | Reusable components | Missing dependencies | Migration required | Verification |
|---|---|---|---|---|---|---|---|---|---|
| **Salary wallet** | Credits and debits | **Complete** | `hr_wallet_txn`, **self-CREATE** `hr-wallet.ts:17`, 3 writers | — | section `hr` | `hr-wallet.ts` | — | none | Source-verified. Idempotent on `ref='payslip:<id>'` — re-clicking Mark Paid cannot double-pay |
| **Bank accounts** | Payout destination | **Partial** | `hr_bank_account`, self-CREATE, **1 writer** (employee self-service) | — | own row | `mask()` `hr-wallet.ts:71` | `verified` is read and never written (permanently false); `rzp_fund_account_id` never written, never read | column-level | Source-verified. **Two bank stores that never meet** — `hr_employees.bank_*` is written by three onboarding forms and read by nothing but those forms; payouts read `hr_bank_account` exclusively. The employee must enter bank details twice |
| **Withdrawals** | Request → approve → pay | **Complete** | `hr_withdrawal`, self-CREATE, 3 writers, audited | — | **strongest gate in the domain** — exact role match, payout release narrowed to admin/super_admin/hr_head | `hr-wallet.ts` | — | none | Source-verified. Two different actions on one row — the closest thing to a two-person control |
| **Payroll runs** | Monthly cycle | **Partial — schema risk** | `hr_payroll_runs`, 4 writers, audited | — | section `payroll` + `super_admin\|hr` | — | **NOT self-bootstrapping.** Exists only if `db/hr-schema.sql:215` was applied by hand | **YES — see 3.1** | Source-verified |
| **Payslips** | Per-employee statement | **Partial — LIVE LIABILITY** | `hr_payslips`, written by `admin/hr/payroll/index.astro:142` | `/admin/hr/payslip/[id].ts`, `/portal/payslip/[id].ts` | two doors, deliberately — admin role vs. ownership; 404 for both "missing" and "not yours" so ids are not an oracle | `src/lib/hr-payslip.ts` (shared so the doors cannot drift) | **`hr-payslip.ts:24` SELECTs `e.work_email`** | **YES — see 3.2** | **Both payslip routes depend on a column nothing writes, created at runtime only by an unrelated page's bootstrap (`portal/employee.astro:66-68`). In any environment where that page has not been loaded, both routes 500** |
| **Salary structures** | Components over time | **Partial** | `hr_salary_structures`, `payroll/index.astro:279`; previous row closed by setting `effective_to` | — | as payroll | — | Not self-bootstrapping. `other_deductions` is **absent from the INSERT column list** yet read and printed — always 0 | **YES — see 3.1** | Source-verified. Payroll tolerates the table's absence via `base_salary` fallbacks |
| **Statutory outputs** | PF / ESIC / PT / TDS filing | **Missing** | — | — | — | — | No employer PF, employer ESIC, gratuity or CTC column anywhere. No ECR, no challan, no return. PAN and UAN are stored but not printed on the payslip | out of scope | Grep-verified. **Employer liability cannot be reported** |
| **Onboarding documents** | Credentials as links | **Complete** | `hr_onboarding_documents`, **self-CREATE** `hr-onboarding.ts:41` | **`/api/portal/onboarding/documents`** | add/remove scoped to own `user_id`; review requires `canAccessSection(user,'employees','edit')` | `hr-onboarding.ts` | `employee_id` declared and **never populated** — always NULL | column-level | Source-verified. Drive links only, max 5 — consistent with the no-uploads rule |
| **Offer letters** | Generate, send, sign | **Complete** | `offer_letters` (real Drizzle table), INSERT `offer-letter.astro:261`, signature `portal/offer/[token].astro:140` | — | section `applications`; signing by 32-char token | — | No salary column — compensation lives inside `content` JSONB, so it cannot be queried or reconciled against `hr_salary_structures` | none | Source-verified. `plaintextPassword` deliberately removed |
| **Blank offer letters** | Ad-hoc document | **Partial — no record** | **NOTHING.** No `db.insert`, no `INSERT INTO offer_letters` in `/admin/offer/blank` | — | section `custom_offer` — which **`editor` holds**, and `editor` is the role offer letters auto-assign to candidates | — | — | — | Grep-verified. Blank offer letters leave no record at all |
| **Field-level PII security** | Mask salary/PAN/Aadhaar/bank | **Missing** | — | — | — | 4-line local `mask()` applied only to the employee's own view | **`src/lib/auth/field-security.ts` does not exist** — searched the whole repo | **see 3.6** | Grep-verified. Deliberate minimisation exists as an allow-list convention (`workspace-access.ts:153`), not as a mechanism |

### 1.5 Communication

| Capability | Purpose | Status | Database (writers) | API | Permissions | Reusable components | Missing dependencies | Migration required | Verification |
|---|---|---|---|---|---|---|---|---|---|
| **Portal DMs (E2E)** | Private messaging | **Partial — schema collision + live 500 risk** | `chat_threads`, `chat_thread_members`, `chat_messages` (ciphertext shape), DDL inline in `portal/messages.astro:37-51` | — | membership re-checked on every privileged read | — | **`chat_messages` is defined TWICE with incompatible shapes** (see 3.7). **`portal/messages.astro:282` selects `u.full_name` — `users` has `name`, not `full_name` — in a loop with no try/catch that runs on every page load** | **YES — see 3.7** | Source-verified this session. `employee-tasks.ts:843` names this exact landmine and declines to become the fifth instance |
| **E2E encryption claim** | Content unrecoverable server-side | **Complete — and precisely bounded** | AES-GCM-256, key derived in the browser by ECDH P-256; private key in `localStorage` only; no escrow column | — | — | — | — | none | Corroborated by `legal-hold.ts:214-223`, which returns envelopes only and stamps `contentRecoverable:false`. **This applies to `/portal/messages` ONLY.** `meet_chat.body`, admin chat, `admin_messages.body`, `hr_support_messages.body`, `discussions.body` and `network_messages.body` are all PLAINTEXT |
| **Admin chat channels** | Team channels | **Partial** | `chat_channels`, `chat_memberships`, `chat_attachments` | `/admin/api/chat/*` | section `discussion` | — | `is_dm` and `message_code` are written by code and appear in **no CREATE TABLE in the repo** and are never ALTERed in | **YES — see 3.7** | Source-verified |
| **Admin DMs** | A third message system | **Complete** | `admin_conversations`, `admin_messages` | — | section `dms` | — | Plaintext, unrelated to both systems above | none | Source-verified |
| **Notifications** | In-app bell | **Complete** | `notifications` — heavily populated; `push.ts` persists **first**, pushes second, so the bell fills even with VAPID unset | `/api/admin/notifications-recent` | every read is `WHERE user_id = self` | `push.ts`, `notify.ts`, `notification-catalog.ts` | — | none | Source-verified. **GAP: `/portal/notifications.astro:8` redirects every non-applicant to `/admin` — an employee has no portal notification inbox**, though rows are written for them |
| **Notification catalogue drift** | Category + priority per type | **Partial** | `NOTIFICATION_TYPES` (40 rows) and `NOTIF_META` are **not the same set** | — | — | — | A type in one and missing from the other degrades silently to system/medium; the file records a 2026-07-30 audit finding 22 of 44 in that state | none — code fix | Source-verified |
| **Browser push** | Out-of-app delivery | **Partial** | `push_subscriptions`; rows deleted on 410/404 | `/api/push/subscribe` | self | `push.ts` | No-op unless `VAPID_*` is set | none | Source-verified |
| **Task notifications** | Tell people about their work | **Missing** | — | — | — | — | `employee-tasks.ts` imports db, drizzle, ensure-once, workspace-access and audit — **never push, mail or the activity feed.** Assigning, blocking, requesting review and approving reach nobody who is not looking at the page | **see 3.4** | Grep-verified. **The `watcher` collaborator role watches nothing** |
| **Platform event stream** | Cross-cutting activity | **Partial** | `activity_log` — but **`attachActivityFeed()` (`activity-feed.ts:192`) is never called anywhere.** The bus→log subscription does not exist at runtime | — | `/admin/activity` is super_admin only | `activity-feed.ts` | Only 3 direct `record()` call sites produce rows, plus the `push.ts:171` mirror. Every other event name in `ROUTING` is aspirational | none — one call | Grep-verified. **No task event is routed here at all** |
| **Work groups** | Teams | **Partial** | `work_groups`, `work_group_members` | — | scoped at the QUERY — an unentitled group is absent, not greyed out | `src/lib/work-groups.ts` | `autoJoinOnOnboard` has **exactly one caller** (`hire-transfer.ts:43`). No admin screen creates groups | none | Source-verified. **Every column past the PK is re-asserted with `ADD COLUMN IF NOT EXISTS` (`:82-92`) precisely because of the `work_email` incident — this file is the pattern to copy** |
| **Peer discussion board** | Community | **Partial** | `discussions`, `discussion_reactions` | `/api/discussion/post` | **WEAK** — only `if (!user) redirect`. No employee gate, no moderation surface | — | `is_pinned` and `is_deleted` are **ORDERED and FILTERED on** but written by nothing — there is no pin or delete action anywhere | column-level | Source-verified. Every DB call in the page is inside `try{}catch(e){}` with an **empty body** — a failed post redirects showing success. This is the pattern CLAUDE.md forbids |

### 1.6 Meetings, calendar, learning, performance

| Capability | Purpose | Status | Database (writers) | API | Permissions | Reusable components | Missing dependencies | Migration required | Verification |
|---|---|---|---|---|---|---|---|---|---|
| **Meeting scheduling** | Book a meeting | **BLOCKED** | `meet_rooms` — the **only** INSERT (`portal/meet/[id].astro:98`) creates an ad-hoc "Untitled huddle". `scheduled_at`, `duration_min`, `invitees`, `recurrence`, `passcode`, `waiting_room` are written by **nothing** | **`/api/meet/rooms` DOES NOT EXIST** — re-verified: no `src/pages/api/meet/` directory. The scheduler UI POSTs to it at 4 call sites and silently 404s | signed-in | — | **Two incompatible definitions** — `host_user_id INTEGER` vs `UUID`; `duration_min` vs `duration_minutes` | **YES — see 3.8** | Grep-verified this session |
| **Live huddle (WebRTC)** | Actually meet | **Complete** | `meet_signals`, `meet_presence` — a working mesh signalling relay over Postgres polling | `/api/portal/meet/[id]/signal` | signed-in, addressed by peerId | `src/lib/breakout.ts` | Mesh needs an SFU for many-video (`docs/huddle-sfu-followup.md`) | none | Source-verified |
| **Meeting recordings** | Replay | **BLOCKED** | **`meet_recordings` has NO INSERT anywhere.** The "Past recordings" list can only ever be empty | — | — | — | — | — | Grep-verified |
| **Staff calendar** | Shared availability | **Missing** | — | — | — | — | The only calendars are `edu_deadlines` (learner), `aq_study_plan` (learner), and `hr_application_support.meet_scheduled_at` (a paid candidate booking). **Nothing holds an internal meeting, availability or slot row** | **YES — see 3.8** | Grep-verified |
| **Announcements** | Broadcast to staff | **Missing** | — | — | — | — | No `announcements` table anywhere in `src`, `db` or `scripts`. `discussions.is_pinned` cannot substitute — nothing writes it | **YES — see 3.9** | Grep-verified |
| **Staff learning (LMS)** | Assigned training | **Partial — unverified schema** | `training_courses` / `_lessons` / `_modules` — **TWO writers with disjoint column sets on each table** (`admin/hr/training.astro` vs `aquintutor/admin/*`). One of each pair must be failing | — | section `training` | — | **No `CREATE TABLE` for any of them anywhere in the repo** — they live only in the gitignored, manually-run `.dev-scripts/migrate-training.mjs` | **YES — see 3.10** | Source-verified. Every column named against them is unverified |
| **Learning enrolment** | Who is taking what | **Partial** | `training_enrollments` — one writer (`portal/courses/[slug].astro:35`), ~15 dashboard readers | — | self write | — | No assignment mechanism — enrolment happens on first open. **Nobody can assign a course** | **see 3.10** | Source-verified |
| **Live classes** | Scheduled teaching | **BLOCKED** | **`live_classes` has NO INSERT anywhere.** Only UPDATEs | — | self | — | `portal/parent.astro:218,248` queries `live_classes.start_at` and `.user_id` — **neither column exists** (the table has `scheduled_at`, `host_user_id`), both inside bare `catch (_) {}` | — | Source-verified. Permanently null with nothing in the logs |
| **Performance reviews** | Rate an employee | **Partial** | `hr_review_cycles`, `hr_performance_reviews` — auto-seeds one pending row per active employee on cycle creation | — | section `hr`; employee reads own, `status='submitted'` only, **excluding `reviewer_comments`** | — | **`hr_performance_reviews` has NO reviewer column.** `performance.astro:98` LEFT JOINs `pr.reviewer_id` — re-verified this session: not in `db/hr-schema.sql`, written by nothing. That query throws into a bare `catch(e){}` and the list renders **empty with no error** | **YES — see 3.11** | Source-verified |
| **Goals / KRAs** | Objectives | **Partial** | `hr_employee_goals`, self-CREATE, 2 writers | — | section `employees` | `hr-lifecycle.ts` | **No portal surface reads it** — an employee cannot see their own KRAs. `employee_acknowledged` written by nothing | **see 3.11** | Source-verified. This is the nearest existing thing to a project, but it cannot group tasks |
| **Probation / PIP** | Lifecycle management | **Partial** | `hr_probation`, `hr_probation_reviews`, `hr_pips`, `hr_pip_checkins` — all self-CREATE | — | section `employees` | `hr-lifecycle.ts` | **Every `employee_acknowledged` column across all four tables is declared and never written** — there is no employee-side acknowledgement surface at all | column-level | Source-verified. **A PIP the person never saw is indistinguishable from one they accepted** |
| **Three unconnected review tables** | — | **Partial** | `hr_performance_reviews`, `hr_probation_reviews`, `hr_reviews` (completion-letter flow) | — | — | — | The three never meet. A rating in the performance cycle does not reach the completion letter | consolidation | Source-verified |

### 1.7 Approvals

| Capability | Purpose | Status | Database (writers) | API | Permissions | Reusable components | Missing dependencies | Migration required | Verification |
|---|---|---|---|---|---|---|---|---|---|
| **Generic approval chain** | Any multi-step sign-off | **Missing** | — | — | — | — | No `approvals`, `approval_steps`, `approvers` or `approval_policy` table. Approval exists in exactly three hardcoded shapes | **YES — see 3.12** | Grep-verified |
| **Leave / withdrawal approval** | Single-step | **Complete** | `approverRole()` `hr-wallet.ts:146` — exact role match plus `reporting_manager_id` | — | one decision closes the record | `hr-wallet.ts` | — | none | Source-verified |
| **Hiring requisitions** | The only 2-stage chain | **Partial — SECURITY** | `hiring_requisitions`, self-CREATE, 2 writers | — | **`decideRequisition()` performs NO role check, and the stage comes from a hidden form field.** The page's only gate is "not applicant" | `hr-requisition.ts` | `opened_role_id` never written — "approved requisitions become open roles" exists in a comment and in no code. `withdrawn` never written | **see 3.12** | Source-verified. **Any non-applicant staff account can approve at both stages, including their own requisition** |
| **Task sign-off** | Approver on a task | **Blocked** | `under_review → approved → completed` edges (`employee-tasks.ts:249-318`) — a real graph | — | collaborator role resolved in SQL | `employee-tasks.ts` | Lives entirely in a table nothing can create rows in | none | Source-verified |

---

## 2. Question-driven design

Ten questions an employee should answer in five seconds. Verified against
`src/pages/portal/employee.astro` as it stands after `4302ce3` ("Employee Command Center: built only
from data the platform can actually answer"), which already ran this survey and built only the
answerable six.

A fourth verdict is required and is the most important finding in this section:
**ANSWERABLE-BY-QUERY BUT STRUCTURALLY EMPTY** — the SQL is correct and gated, and the table it reads
can never receive a row.

| # | Question | Verdict | Detail |
|---|---|---|---|
| 1 | **What needs my attention?** | **ANSWERABLE (composite) — partly structurally empty** | Built at `portal/employee.astro:715-789`. Composed of: overdue tasks + due-today tasks (`myTasksView()` → `employee_tasks`, overdue defined in Postgres via `IS_OVERDUE`) — **both structurally empty, no writer**; pending leave decisions (`hr_leave_request`) — **real**; pending withdrawal decisions (`hr_withdrawal`) — **real**. So the card works and today shows only money and leave |
| 2 | **What is due today?** | **ANSWERABLE-BY-QUERY, STRUCTURALLY EMPTY** | `employee.astro:609` partitions `openTasks` on `!t.overdue && t.due === dbToday`, comparing against the **database's** today, not the browser's. Correct code. `employee_tasks` has no reachable INSERT, so the list is empty until an assign surface exists |
| 3 | **Who is waiting on me?** | **PARTIALLY ANSWERABLE** | Answerable for **approvals** (leave, withdrawals, task sign-off via collaborator role resolved in SQL). **NOT answerable for messages or comments**: `employee_task_comments` has five columns — no read state, no mentions, no receipts — so "X is waiting for your answer" cannot be derived. `chat_message_receipts` exists but the UI never reads it: the read ticks in `portal/messages.astro:913` are **hardcoded `class='tick read'`**, so a tick proves nothing |
| 4 | **What is blocked?** | **ANSWERABLE-BY-QUERY, STRUCTURALLY EMPTY** | `employee_tasks.status='blocked'` + `blocked_reason` is a first-class state with real transition edges. Same empty-table caveat. **There is no cross-entity blocker concept** — nothing else in the platform can be marked blocked |
| 5 | **What approvals need me?** | **ANSWERABLE** | Leave: `hr_leave_request WHERE status='pending'`, gated by `approverRole()`. Withdrawals: `hr_withdrawal WHERE status='pending'`, same gate. Task sign-off: collaborator `approver` role. **Requisitions are excluded and should be** — `decideRequisition()` has no role check, so a "waiting on you" count would be wrong for everyone |
| 6 | **What meetings do I have?** | **NOT ANSWERABLE** | `meet_rooms.scheduled_at`, `duration_min`, `invitees` and `recurrence` are **written by nothing**. The sole INSERT creates an ad-hoc huddle with a title and a kind. The table's declared `host_user_id INTEGER` contradicts the `::uuid` casts in the code that reads it, and the scheduler UI POSTs to `/api/meet/rooms`, **which does not exist**. `employee.astro:861-864` records this refusal in a comment rather than shipping an empty card |
| 7 | **Who mentioned me?** | **NOT ANSWERABLE** | No mentions table, no mention parsing, no mention column anywhere. `employee_task_comments` has no `parent_id` and no mention field; `discussions` has no mention field. Nothing tokenises a body on write |
| 8 | **What learning is assigned?** | **NOT ANSWERABLE as "assigned"** | `training_enrollments` has **one writer** — `portal/courses/[slug].astro:35`, an INSERT on the learner's own first open. **There is no assignment mechanism**: nobody can put a course on someone's list, and there is no `assigned_by`, `due_at` or `required` column. "What I have started" is answerable; "what is assigned to me" is not. Compounding this, the `training_*` tables have **no CREATE TABLE anywhere in the repo** |
| 9 | **What documents need action?** | **PARTIALLY ANSWERABLE** | Answerable for the employee's **own** onboarding documents (`hr_onboarding_documents.status` ∈ submitted/verified/rejected, via `/api/portal/onboarding/documents`), and for a reviewer via `canAccessSection(user,'employees','edit')`. **NOT answerable for offer letters** — no per-user "awaiting your signature" query exists; signing is by unguessable token, so there is no inbox. `hr_onboarding_documents.employee_id` is declared and always NULL, so documents cannot be joined to the HR record |
| 10 | **What is my credit / attendance position?** | **ANSWERABLE, with an honest null** | Derived live by `credit-ledger.ts` from `hr_attendance` + approved `hr_leave_request`. The card correctly says "no credit-hour requirement recorded" rather than "0% complete" when the runtime-added term columns are unset — **zero and unknown are different facts** |

**Bonus question the platform answers but no surface asks: "what did I say I did?"** `hr_task_log`
and `hr_daily_reports` are written by the employee and `hr_task_log` has **zero admin readers**.

**The single highest-leverage finding in this section:** four of the ten questions (1, 2, 3, 4) are
gated on one missing artefact — **a task assignment surface**. The queries, the permissions, the
components and the state graph all already exist and are correct. Nothing needs to be designed;
`createTask()` needs a caller.

---

## 3. Architecture gap report

All SQL below is **proposed, not applied**. Nothing in this document has been run against any
database. Every statement is `IF NOT EXISTS`-guarded and safe to run repeatedly.

**Delivery mechanism.** This project has no migration runner. The established, working pattern is
`ensureOnce()` (`src/lib/ensure-once.ts`) — memoise the in-flight promise per process, drop failures
from the cache so a transient hiccup does not poison the process. The model to copy is
`src/lib/work-groups.ts:82-92`, which re-asserts **every column past the primary key** with
`ADD COLUMN IF NOT EXISTS` explicitly because of the `work_email` incident.

**The rule for every ensure block below:** `CREATE TABLE IF NOT EXISTS` is a **no-op on an existing
table**. It will not add a column to a table that already exists. Therefore every column must *also*
appear as its own `ADD COLUMN IF NOT EXISTS`. This is the exact reason `work_email` and `hr_task_log`
failed.

### 3.1 Tables with no runtime DDL — the direct outage class

Seven tables exist **only** because someone applied `db/hr-schema.sql` by hand. Nothing in the
application creates them. Two are on unguarded render paths.

| Table | Named by | Unguarded reader |
|---|---|---|
| `user_face_enrollments` | `middleware.ts:388` — hard gate on **every** protected page | error swallowed → redirects **every** user to `/enroll-face` forever |
| `hr_attendance` | clock in/out, `/admin/hr/attendance` | — |
| `hr_clock_events` | clock in/out | — |
| `hr_time_logs` | `/portal/workspace`, `/admin/hr/attendance` | — |
| `hr_daily_reports` | `/portal/employee`, 3 admin surfaces | **`admin/hr/attendance/index.astro:117` — top-level `await`, no try/catch. Missing table = the page 500s** |
| `hr_payroll_runs`, `hr_payslips`, `hr_salary_structures` | `/admin/hr/payroll` | — |

```sql
-- PROPOSED. Not applied. Deliver via ensureOnce('workforce_core_v1', ...).
-- Column list mirrors db/hr-schema.sql exactly; every column is also ALTERed in below,
-- because CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists.

CREATE TABLE IF NOT EXISTS user_face_enrollments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,
  face_descriptor TEXT,
  device_info    TEXT,
  selfie_url     TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE user_face_enrollments ADD COLUMN IF NOT EXISTS face_descriptor TEXT;
ALTER TABLE user_face_enrollments ADD COLUMN IF NOT EXISTS device_info TEXT;
ALTER TABLE user_face_enrollments ADD COLUMN IF NOT EXISTS selfie_url TEXT;
ALTER TABLE user_face_enrollments ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_face_enroll_user ON user_face_enrollments(user_id);

CREATE TABLE IF NOT EXISTS hr_attendance (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL,
  date           DATE NOT NULL,
  clock_in       TIMESTAMPTZ,
  clock_out      TIMESTAMPTZ,
  work_hours     NUMERIC(6,2) NOT NULL DEFAULT 0,
  overtime_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'present',
  work_mode      TEXT,
  notes          TEXT,
  ip_address     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, date)
);
ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS work_mode TEXT;
ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS ip_address TEXT;

CREATE TABLE IF NOT EXISTS hr_daily_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  report_date DATE NOT NULL,
  work_done   TEXT NOT NULL DEFAULT '',
  progress    TEXT,
  blockers    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, report_date)
);
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS progress TEXT;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS blockers TEXT;
ALTER TABLE hr_daily_reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS hr_time_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  log_date    DATE NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  hours       NUMERIC(6,2) NOT NULL DEFAULT 0,
  task        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_time_logs_emp_date ON hr_time_logs(employee_id, log_date DESC);

CREATE TABLE IF NOT EXISTS hr_clock_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL,
  event_type    TEXT NOT NULL,
  event_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lat           NUMERIC(10,6),
  lon           NUMERIC(10,6),
  accuracy      NUMERIC(10,2),
  location_name TEXT,
  work_mode     TEXT,
  note          TEXT,
  face_photo    TEXT,
  ip_address    TEXT,
  device_info   TEXT
);
ALTER TABLE hr_clock_events ADD COLUMN IF NOT EXISTS face_photo TEXT;
```

`hr_payroll_runs`, `hr_payslips` and `hr_salary_structures` need the same treatment; their column
lists are at `db/hr-schema.sql:186`, `:215` and `:236`.

**Also required, and it is code not SQL:** `admin/hr/attendance/index.astro:110-120` must be wrapped
in a `try/catch` that degrades to an empty grid. A top-level `await` naming two tables with no
runtime DDL is the outage shape verbatim.

### 3.2 `hr_employees.work_email` — remove it, do not populate it

Zero writers. Nine readers, all in `OR` arms that look like resilience and provide none. Created at
runtime only by an unrelated page's bootstrap (`portal/employee.astro:66-68`). **Both payslip routes
depend on it via `hr-payslip.ts:24`.**

Two defensible fixes. **Prefer the second.**

```sql
-- OPTION A (defensive, cheap): guarantee the column exists so hr-payslip.ts stops being a landmine.
-- It will still be NULL for everyone, so every `work_email = ...` arm stays dead.
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS work_email TEXT;
CREATE INDEX IF NOT EXISTS idx_hr_emp_work_email ON hr_employees(lower(work_email));
```

**Option B — the correct one, no SQL at all:** delete `e.work_email` from `hr-payslip.ts:24` and
delete every `work_email` arm from the nine reader sites. A column nothing writes cannot match, so
removing it changes no behaviour and removes two 500s. Run Option A first as a safety net if the
production state is unknown, then do Option B and drop the column later.

`hr_employees.department_id` is the same class one step less severe — **one** writer
(`hr/sync.ts:70`), so anyone HR added by hand is invisible to every department-scoped query. The fix
is a `name="department"` select on the Employment tab of `/admin/hr/employees/[id].astro`, not SQL.

### 3.3 Reporting hierarchy — one nullable column is the whole org chart

`hr_employees.reporting_manager_id` holds a **`users.id`**, not an `hr_employees.id`. Joining it to
`hr_employees.id` matches zero rows and reads as "not recorded" rather than erroring — the most
likely implementation error in this codebase.

There is no chain, no skip-level, no dotted line, no history, and no way to ask "who reports to X"
except a scan. If a real hierarchy is wanted:

```sql
-- PROPOSED. Optional — only if skip-level, history or dotted lines are actually needed.
CREATE TABLE IF NOT EXISTS hr_reporting_line (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL,           -- hr_employees.id
  manager_user_id UUID NOT NULL,          -- users.id  (SAME ID SPACE AS reporting_manager_id)
  relation       TEXT NOT NULL DEFAULT 'solid',   -- solid | dotted
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to   DATE,                    -- NULL = current
  set_by_user_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reporting_emp     ON hr_reporting_line(employee_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_reporting_manager ON hr_reporting_line(manager_user_id) WHERE effective_to IS NULL;
```

The column comment must state the id space. That single ambiguity is worth more defects than the
missing table.

### 3.4 Projects, task structure and task notifications

**No `projects` table, no `project_id`, no `projectId` exists anywhere in `src/` or `db/`** —
re-verified this session by grep. No epic, sprint, milestone or workstream either.

```sql
-- PROPOSED. Deliver via ensureOnce('work_projects_v1', ...) inside src/lib/employee-tasks.ts,
-- next to ensureTaskTables(), so tasks and projects bootstrap together.

CREATE TABLE IF NOT EXISTS work_projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',   -- active | paused | done | archived
  department_id VARCHAR(50),        -- TEXT SLUG. departments.id is NOT a uuid. Never cast ::uuid.
  owner_user_id UUID,               -- users.id
  starts_on     DATE,
  target_on     DATE,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE work_projects ADD COLUMN IF NOT EXISTS description   TEXT NOT NULL DEFAULT '';
ALTER TABLE work_projects ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'active';
ALTER TABLE work_projects ADD COLUMN IF NOT EXISTS department_id VARCHAR(50);
ALTER TABLE work_projects ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE work_projects ADD COLUMN IF NOT EXISTS starts_on     DATE;
ALTER TABLE work_projects ADD COLUMN IF NOT EXISTS target_on     DATE;
ALTER TABLE work_projects ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_work_projects_dept ON work_projects(department_id);

-- Membership. Visibility must be derivable in SQL, exactly like visibleToSql().
CREATE TABLE IF NOT EXISTS work_project_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES work_projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',   -- owner | member | viewer
  added_by_user_id UUID,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, user_id)
);

-- Link tasks to projects and to each other. Nullable on purpose: an unfiled task stays valid,
-- and every existing query keeps working untouched.
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS project_id     UUID;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID;
ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS sort_rank      NUMERIC(20,10);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON employee_tasks(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_parent  ON employee_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

-- Explicit dependencies, kept out of the task row so a cycle check has somewhere to live.
CREATE TABLE IF NOT EXISTS employee_task_deps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      UUID NOT NULL REFERENCES employee_tasks(id) ON DELETE CASCADE,
  depends_on_id UUID NOT NULL REFERENCES employee_tasks(id) ON DELETE CASCADE,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);
```

**Critical caveat for whoever implements this.** `BOARD_TASK_COLUMNS` (`employee-tasks.ts:1155`) and
the legacy `TASK_COLUMNS` (`:861`) are deliberately different lists. `TASK_COLUMNS` names **only**
columns that existed before the second-pass DDL, because `myTasksView()` runs on somebody's phone and
must survive a failed ALTER. **Do not add `project_id` to `TASK_COLUMNS`.** Add it to
`BOARD_TASK_COLUMNS` only, and only inside the same non-fatal block.

**Task notifications require no schema.** `notifications` is complete and heavily populated.
`employee-tasks.ts` simply never calls `push.ts`. Adding `sendPushToUser` on assign, block,
review-request and approve makes the `watcher` role mean something. This is three imports and four
call sites.

### 3.5 Leave balances and a holiday calendar

Entitlement is a code constant; consumption is a `SUM` per calendar year. No carry-forward, no
accrual, no pro-rata, no override. And "absent" is computed against calendar days because nothing
enumerates weekends or public holidays.

```sql
-- PROPOSED. Deliver via ensureOnce('hr_calendar_v1', ...) in src/lib/hr-leave.ts.

CREATE TABLE IF NOT EXISTS hr_holidays (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date DATE NOT NULL,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'all',   -- 'all' or a departments.id SLUG (TEXT, never uuid)
  is_optional BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (holiday_date, scope)
);

CREATE TABLE IF NOT EXISTS hr_leave_balance (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL,
  leave_year    INT  NOT NULL,
  leave_type    TEXT NOT NULL,     -- casual | sick | earned | unpaid
  entitled_days NUMERIC(5,1) NOT NULL DEFAULT 0,
  carried_days  NUMERIC(5,1) NOT NULL DEFAULT 0,
  adjust_days   NUMERIC(5,1) NOT NULL DEFAULT 0,
  adjust_reason TEXT,
  set_by_user_id UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, leave_year, leave_type)
);
```

**Consumption must stay derived** from `hr_leave_request`. Storing a running balance creates a second
source of truth that drifts the first time a request is cancelled. This table holds *entitlement*
only. The same reasoning applies to credit hours, which `credit-ledger.ts` recomputes on every load —
that is the right call and should not be "optimised" into a ledger table.

While here: `hr_attendance.status` has no `half-day` value, so `credit-hours.ts:109-115` is
unreachable. Either add the value or delete the branch. Do not leave a dead path that looks live.

### 3.6 Field-level PII security

`src/lib/auth/field-security.ts` **does not exist**. There is no field-level gate for salary, PAN,
Aadhaar or bank details anywhere. The only masking is a 4-line local helper applied solely to the
employee's own view — the **admin** withdrawal queue (`hr-wallet.ts:136`) returns `account_number`,
`ifsc` and `upi_id` **unmasked**, and its view gate is
`role.indexOf('hr') >= 0` (`admin/hr/wallet/index.astro:10`) — the substring bug that `approverRole()`
deliberately fixed with an exact match twelve lines away, with a comment explaining why.

This is a **code gap, not a schema gap.** No SQL. The deliverables are:

1. `src/lib/auth/field-security.ts` — one allow-list function per surface, mirroring the existing
   `EMPLOYEE_COLUMNS` convention in `workspace-access.ts:153`.
2. Fix `admin/hr/wallet/index.astro:10` to exact role equality.
3. An audit row per sensitive-field read, following `registry.ts:475 recordStrict` — which **rolls
   back** when the audit write fails. That pattern already exists and works.

Also code, not schema: `admin/profile.astro:59-67` assigns bare values, so submitting the form with a
blank field **NULLs a stored PAN, Aadhaar or bank number**. `portal/employee/onboarding.astro:35-45`
does the same job with `COALESCE` and does not. Copy the `COALESCE` version.

### 3.7 The two `chat_messages` definitions — resolve before building anything

`chat_messages` is created with **two incompatible shapes**:

- `scripts/setup-team-chat.mjs:24-34` + `schema.ts:723` — `channel_id` FK, `sender_name`, `body TEXT NOT NULL`
- `portal/messages.astro:37-51` — `thread_id`, `ciphertext`, `iv`, `envelope`

`CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so **exactly one shape is live and the
other system's every write throws.** If the channel shape is live, every portal DM send/edit/delete
fails. If the thread shape is live, `/admin/chat` send and upload fail.

**No SQL is proposed here.** Renaming a live table is not a self-bootstrappable operation and cannot
be done without knowing the production state. This must be resolved by inspection first — and per
CLAUDE.md, that inspection is a command handed to the user, not something run here:

```
-- FOR THE USER TO RUN. Do not run this from an agent.
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'chat_messages' ORDER BY ordinal_position;
```

The correct end state is two differently-named tables (`chat_thread_messages` and
`chat_channel_messages`). The migration path depends entirely on which shape is live and whether it
holds rows.

**Independently, and fixable now:** `portal/messages.astro:282` selects `u.full_name`. **`users` has
`name`, not `full_name`** (`schema.ts:50`) — re-verified this session. The query is in a loop over up
to 25 threads with **no try/catch**, on the page the whole DM feature lives on. `employee-tasks.ts:843`
names this exact landmine and routes around it via a correlated subquery to `hr_employees` rather than
become the fifth instance. Four files still name it: `messages.astro:282`, `gamification.ts:160`,
`legal-hold.ts:247` and `:297`. **`legal-hold.ts` catches and returns `[]`, so a legal-hold screen
would report "no threads" for a missing column** — a wrong answer on a compliance surface. Fix by
selecting `u.name`; no SQL needed.

Also declared-not-created: `chat_channels.is_dm` and `chat_messages.message_code` are written by
`start-dm.ts:49` and `send.ts:43` and appear in **no** `CREATE TABLE` in the repo.

```sql
-- PROPOSED, safe on either shape.
ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS is_dm BOOLEAN NOT NULL DEFAULT FALSE;
```

`message_code` must wait until the shape collision is resolved.

### 3.8 Meetings and a staff calendar

`meet_rooms` has two incompatible definitions (`host_user_id INTEGER` vs `UUID`), its scheduling
columns are written by nothing, and the UI POSTs to `/api/meet/rooms`, **which does not exist**.

The honest fix is a new, unambiguous table rather than reconciling the two `meet_rooms` shapes:

```sql
-- PROPOSED. Deliver via ensureOnce('staff_calendar_v1', ...).
CREATE TABLE IF NOT EXISTS staff_meetings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  organiser_user_id UUID NOT NULL,          -- users.id (UUID — unlike meet_rooms.host_user_id)
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  location      TEXT,
  room_id       TEXT,                        -- optional link to a meet_rooms huddle
  recurrence    TEXT,                        -- RFC 5545 RRULE, or NULL
  status        TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | cancelled | done
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_meetings_start ON staff_meetings(starts_at);

CREATE TABLE IF NOT EXISTS staff_meeting_invitees (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES staff_meetings(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL,
  response   TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined | tentative
  responded_at TIMESTAMPTZ,
  UNIQUE (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_invitee_user ON staff_meeting_invitees(user_id);
```

That pair makes question 6 answerable:
`SELECT ... FROM staff_meetings m JOIN staff_meeting_invitees i ON i.meeting_id = m.id
WHERE i.user_id = $1 AND m.starts_at::date = CURRENT_DATE AND m.status = 'scheduled'`.

Required alongside it, and **neither is SQL**: build `src/pages/api/meet/rooms.ts` (or repoint the
four fetch call sites in `portal/meet/index.astro`), and give `meet_recordings` a writer or delete
the "Past recordings" section that can only ever be empty.

### 3.9 Announcements

No table anywhere. `discussions.is_pinned` cannot substitute — nothing writes it.

```sql
-- PROPOSED.
CREATE TABLE IF NOT EXISTS staff_announcements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  audience      TEXT NOT NULL DEFAULT 'all',  -- 'all' or a departments.id SLUG (TEXT)
  priority      TEXT NOT NULL DEFAULT 'normal',
  published_at  TIMESTAMPTZ,                  -- NULL = draft
  expires_at    TIMESTAMPTZ,
  created_by    UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS staff_announcement_reads (
  announcement_id UUID NOT NULL REFERENCES staff_announcements(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, user_id)
);
```

Publishing should call `sendPushToUser` — `notifications` already works, so an announcement lands in
the bell for free.

While here, `discussions.is_pinned` and `is_deleted` are **ordered and filtered on** and written by
nothing. Either build a pin/delete action or stop ordering by a column that is always `false`. The
board also needs moderation: its only gate is `if (!user)`, and every DB call sits in an empty
`catch`, so **a failed post redirects showing success**.

### 3.10 Learning assignment

`training_courses`, `training_lessons` and `training_modules` have **no `CREATE TABLE` anywhere in
the repo** and **two writers each with disjoint column sets** — one of each pair must be failing.
Every column named against them is unverified. The DDL lives only in the gitignored, manually-run
`.dev-scripts/migrate-training.mjs`.

Do not build on them until that file's DDL is folded into an `ensureTrainingSchema()` in `src/lib/`.
That is a mechanical port of an existing file, not new design.

Once stable, assignment is one small table:

```sql
-- PROPOSED. Depends on the training_* DDL being ported into src/ first.
CREATE TABLE IF NOT EXISTS training_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     UUID NOT NULL,
  user_id       UUID NOT NULL,
  assigned_by_user_id UUID NOT NULL,
  due_on        DATE,
  is_mandatory  BOOLEAN NOT NULL DEFAULT FALSE,
  reason        TEXT,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (course_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_training_assign_user ON training_assignments(user_id);
```

Also: `push.ts:424-440` sends `lms_enrolment` and `course_completed` notifications pointing at
`/admin/training`, **which does not exist**. The real page is `/admin/hr/training`. Those
notifications land on a dead link today.

### 3.11 Performance reviewers and goal acknowledgement

`hr_performance_reviews` has **no reviewer column**, yet `performance.astro:98` LEFT JOINs
`pr.reviewer_id`. Re-verified this session: it is not in `db/hr-schema.sql:393-410` and is written by
nothing. The query throws into a bare `catch(e){}` and **the reviews list renders empty with no
error** — a silent wrong answer, worse than a crash.

```sql
-- PROPOSED.
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS reviewer_id UUID;   -- users.id
ALTER TABLE hr_performance_reviews ADD COLUMN IF NOT EXISTS reviewer_assigned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_perf_reviewer ON hr_performance_reviews(reviewer_id)
  WHERE reviewer_id IS NOT NULL;
```

The ALTER alone does **not** make "reviews waiting on me" answerable — it needs a writer, i.e. a
reviewer picker on `/admin/hr/performance`. Until that exists the count is legitimately zero and must
read as "nobody has asked you to review anything", never as a broken widget. That is the wording
convention `4302ce3` already established.

`employee_acknowledged` / `employee_acknowledged_at` exist on **four** lifecycle tables
(`hr_probation_reviews`, `hr_employee_goals`, `hr_pips`, `hr_pip_checkins`) and **no code writes any
of them**. The columns exist; what is missing is an employee-facing surface. Until then **a PIP the
person never saw is indistinguishable from one they accepted** — a genuine fairness problem, not a
cosmetic gap. `hr_employee_goals` likewise has no portal reader at all: an employee cannot see their
own KRAs.

### 3.12 A generic approval chain

There is no `approvals`, `approval_steps` or `approval_policy` table. Approval exists in three
hardcoded shapes, and the only multi-stage one is **exploitable**: `decideRequisition()` performs no
role check and takes the stage from a hidden form field, so **any non-applicant account can approve
at both stages, including their own requisition**.

**Fix that first, in code, before any generalisation** — it is a live authorisation hole and the
table below does not close it.

```sql
-- PROPOSED. Only worth building once a second real chain exists; one chain does not justify a framework.
CREATE TABLE IF NOT EXISTS approval_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT NOT NULL,        -- 'requisition' | 'leave' | 'withdrawal' | 'task'
  entity_id    TEXT NOT NULL,
  requested_by UUID NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | withdrawn
  current_step INT  NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at    TIMESTAMPTZ,
  UNIQUE (entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS approval_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_no       INT  NOT NULL,
  approver_user_id UUID,             -- users.id, resolved at creation
  approver_rule TEXT,                -- 'reporting_manager' | 'role:hr' | 'user:<uuid>'
  decision      TEXT,                -- NULL = waiting
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  UNIQUE (request_id, step_no)
);
CREATE INDEX IF NOT EXISTS idx_approval_waiting ON approval_steps(approver_user_id)
  WHERE decision IS NULL;
```

That last partial index is what makes "what approvals need me" a single indexed query instead of
three union'd ones.

### 3.13 Gaps that are not schema

Listed separately because proposing SQL for them would be wrong.

| Gap | Where | Fix |
|---|---|---|
| **No task assignment surface** | `createTask()` has zero callers | A form. The engine, permissions and components all exist |
| **Event stream not attached** | `attachActivityFeed()` (`activity-feed.ts:192`) is never called | **One function call at boot.** Every event name in `ROUTING` is aspirational until then |
| **No background jobs** | Only `api/cron/activity-digest.ts` | Vercel Hobby crons are daily-only. Anything needing sub-daily (due-date reminders, escalation) must be request-triggered or accept daily |
| **No API layer for work or time** | Grep across `src/pages/api` returns zero matches for any time-domain table | Everything is a form POST to an `.astro` page. Fine for the web app, blocks mobile/native and any integration |
| **No device permissions inventory** | Camera used by face enrolment and clock-in selfie; geolocation by `hr_clock_events`; notifications by push | No central registry of what is requested when, and no graceful path when a permission is denied — `hasFaceEnrolled` swallowing its error into `false` is the worst case |
| **No AI infrastructure in this domain** | — | No embeddings, no vector column, no summarisation. Per the Sovereignty Constitution any addition must sit behind a swappable interface with a self-hostable default. **Nothing here needs AI to work** — every gap above is a missing table, form or function call |
| **`/admin/hr/payouts` maps to a page that does not exist** | `middleware.ts:60` | A role granted `payouts` cannot reach the payouts screen; a role granted `hr` gets it without `payouts`. Remove the mapping or create the page |
| **Substring role check** | `admin/hr/wallet/index.astro:10` — `role.indexOf('hr') >= 0` | Exact equality, as `hr-wallet.ts:154-159` already does deliberately |
| **Swallowed exceptions** | `portal/discussion.astro` (4 empty catches), `audit.ts:21`, `parent.astro:226/254`, both attendance writes | CLAUDE.md names this pattern. A failed post that redirects showing success is the worst instance |
| **`e.cause` not logged** | `src/lib/audit.ts:21` logs the raw error | `e?.cause?.message \|\| e?.message`. The real Postgres reason for a lost audit row is currently not printed |
| **Dead enum branches** | `portal/submissions/new.astro:28,29,30,45` | `user_role` has no `intern`, `employee` or `campus_ambassador`. `astro check` flags all four as `ts(2367)` |
| **Employees have no portal notification inbox** | `portal/notifications.astro:8` redirects every non-applicant to `/admin` | Rows **are** written for them; only the door is shut |

---

## 4. The declared-vs-existing risk register

Every column or table a schema file declares (or code names) that **no code writes**. This is the
list that caused three outages. Ordered by blast radius.

### Tier 1 — can take a page or the whole site down today

| # | Object | Declared at | Named by | Writer | Failure mode |
|---|---|---|---|---|---|
| 1 | **`user_face_enrollments`** (whole table) | nowhere in the application — `.dev-scripts` only | `middleware.ts:388`, a hard gate on **every** `/admin` and `/portal` path | 5 writers, but **no CREATE** | `hasFaceEnrolled` swallows the error → `false` → **every user redirected to `/enroll-face` forever.** This is the reported redirect-loop outage |
| 2 | **`hr_employees.work_email`** | `db/hr-schema.sql:51`, `:88` | `hr-payslip.ts:24` — **both** payslip doors | **ZERO** | Created at runtime only by an unrelated page's bootstrap. Where that page has not loaded, **both payslip routes 500**. Where it has, the column is NULL, so all 9 `OR` arms are permanently dead |
| 3 | **`users.full_name`** | **does not exist** — `users` has `name` | `messages.astro:282` (**unguarded loop, every page load**), `gamification.ts:160`, `legal-hold.ts:247`, `:297` | n/a | **500s `/portal/messages`** — the page the DM feature lives on. In `legal-hold.ts` it is caught and returns `[]`: a legal-hold screen reporting "no threads" for a missing column |
| 4 | **`hr_daily_reports`**, **`hr_attendance`** (whole tables) | `db/hr-schema.sql` only | `admin/hr/attendance/index.astro:110-120` — **top-level `await`, no try/catch** | writers exist, **no runtime DDL** | Missing table **500s `/admin/hr/attendance`** outright |
| 5 | **`chat_messages`** — two incompatible shapes | `setup-team-chat.mjs:24` + `schema.ts:723` vs `messages.astro:37` | both chat systems | both, into one name | One shape is live; **the other system's every write throws.** Must be resolved against production before either surface is trusted |
| 6 | **`meet_rooms`** — two incompatible shapes | `portal/meet/index.astro:14` (`host_user_id INTEGER`) vs `[id].astro:22` (`UUID`) | both | one ad-hoc INSERT | `::uuid` casts against an INTEGER column throw |

### Tier 2 — silently wrong answers (no error, no log)

| # | Object | Declared at | Named by | Writer | What the user sees |
|---|---|---|---|---|---|
| 7 | **`hr_performance_reviews.reviewer_id`** | **nowhere** | `admin/hr/performance.astro:98` LEFT JOIN | **none** | Query throws into a bare `catch(e){}` → **reviews list renders empty**. Looks like "no reviews", means "the query failed" |
| 8 | **`live_classes.start_at`, `.user_id`** | **neither exists** (table has `scheduled_at`, `host_user_id`) | `portal/parent.astro:218`, `:248` | none | Both in bare `catch (_) {}` → "Next class" permanently null, `weeklyClasses` permanently 0, **nothing in the logs** |
| 9 | **`hr_attendance.overtime_hours`** | `db/hr-schema.sql:134`, `:144` | `admin/hr/attendance/index.astro:163` `SUM()` | **ZERO** — re-verified, 4 grep hits, none a write | **The overtime total is structurally always 0** and reads as a real figure |
| 10 | **`discussions.is_pinned`, `.is_deleted`** | inline DDL | **ORDERED and FILTERED on** (`:80-81`) | **none** | Pinning and deletion appear to exist in the sort order and do not exist at all |
| 11 | **`hr_bank_account.verified`** | inline DDL | read at `hr-wallet.ts:113` | **none** | Permanently `false`. A "verified account" badge would never light |
| 12 | **`hr_salary_structures.other_deductions`** | `db/hr-schema.sql` | read at `:64`, printed at `hr-payslip.ts:145` | **absent from the INSERT column list** | **Always 0 on every payslip** |
| 13 | **`employee_acknowledged` / `_at`** ×4 tables | `hr-lifecycle.ts:57,78,101,122` | — | **none, on any of the four** | **A PIP the employee never saw is indistinguishable from one they accepted** |
| 14 | **`hr_onboarding_documents.employee_id`** | `hr-onboarding.ts:41` | — | **always NULL** (`addDoc` called without it) | Documents cannot be joined to the HR record |
| 15 | **`chat_message_receipts`** | inline DDL, written at `messages.astro:197` | **UI never reads it** — ticks are hardcoded `class='tick read'` | thin | **A read receipt tick proves nothing** |
| 16 | **`hiring_requisitions.opened_role_id`, `withdrawn`** | `hr-requisition.ts:15` | comment `:1-4`, `:45` | **none** | "Approved requisitions become open roles" exists in a comment and in no code |
| 17 | **`users.consent_given_at`, `.consent_ip`** | not in the Drizzle model | `portal/signup.astro:69-70` | attempted | `astro check` errors `ts(2769)` — **the signup consent record is not stored the way the code reads it** |
| 18 | **`meet_rooms.scheduled_at`, `duration_min`, `invitees`, `recurrence`, `passcode`, `waiting_room`** | `portal/meet/index.astro:14` | scheduler UI | **none** | Scheduling silently 404s (`/api/meet/rooms` does not exist); the quick-huddle fallback navigates anyway |

### Tier 3 — dead weight, no current harm

| # | Object | Note |
|---|---|---|
| 19 | `meet_recordings` | **No INSERT anywhere.** "Past recordings" can only ever be empty |
| 20 | `live_classes` | **No INSERT anywhere.** `/portal/liveclass` is structurally empty, so `live_class_enrollments` can never populate |
| 21 | `network_messages` | Declared and indexed at `network.ts:59-67`, **never inserted into** |
| 22 | `hr_bank_account.rzp_fund_account_id` | Never written, never read. `payWithdrawal` builds the fund account inline and discards the returned id |
| 23 | `chat_threads.cover_url` | Declared, written by nothing |
| 24 | `chat_channels.is_dm`, `chat_messages.message_code` | **Written** by `start-dm.ts:49` and `send.ts:43`, in **no CREATE TABLE in the repo**, never ALTERed in — Tier 1 if the live table lacks them |
| 25 | `notification_preferences` — six boolean columns | Legacy, read by nothing. Only `prefs` jsonb is consulted |
| 26 | `departments` UUID definition (`db/hr-schema.sql:31`) | Skipped by `CREATE TABLE IF NOT EXISTS`. **Documentation of a table that does not exist in that form** |
| 27 | `hr_leave_requests` (plural), `hr_leave_types`, `hr_leave_balances` | Orphaned second leave schema. No DDL, no writer, no reader. **Do not query these names** |
| 28 | `users.identity_verified`, `.id_doc_url`, `.reg_fee_paid` | Readers and writers, but **no CREATE or ALTER anywhere in `src` or `db`** — same class as `work_email`, currently masked by swallowing try/catch |
| 29 | `hr_employees.govt_id_type`, `govt_id_number`, `govt_id_doc_url`, `noc_doc_url`, `onboarding_submitted_at` | No CREATE, no ALTER anywhere. Written by `portal/employee/onboarding.astro:39-46` **with NO try/catch** — if absent, **the new-hire onboarding form 500s outright.** Harder failure than `work_email`, which was at least swallowed. **Promote to Tier 1 if production state is unknown** |
| 30 | `training_courses`, `_lessons`, `_modules`, `_enrollments` | **No CREATE TABLE anywhere in the repo.** Every column named against them is unverified |

**The pattern worth naming:** the safest columns in this codebase are the ones that are ALTERed in
next to their writer — `credit-ledger.ts:214 ensureTermColumns()` and `work-groups.ts:82-92`. Both
were written *after* an incident. Both re-assert every column, not just the table. **That is the
pattern; copy it.**

---

## 5. Recommended build order

Dependency-first. Each line states why it precedes the next.

### Phase 0 — stop the bleeding (no new features)

1. **Wrap `admin/hr/attendance/index.astro:110-120` in a try/catch.** A top-level `await` naming two
   tables with no runtime DDL is a live 500 on an admin page.
2. **Replace `u.full_name` with `u.name` in all four files.** `messages.astro:282` runs unguarded on
   every load of the DM page; `legal-hold.ts` returns a *wrong answer* on a compliance surface.
3. **Remove `e.work_email` from `hr-payslip.ts:24` and the 9 dead `OR` arms.** A column nothing
   writes cannot match, so removal changes no behaviour and removes two 500s.
4. **Resolve the `chat_messages` shape collision.** Hand the user the
   `information_schema` query. Nothing chat-related can be trusted until this is answered — and it is
   the only item here that cannot be fixed from source alone.
5. **Fix `decideRequisition()`.** The only multi-stage approval chain can be walked end-to-end by any
   non-applicant account, self-approval included, with the stage supplied by a hidden form field.
6. **Fix `admin/hr/wallet/index.astro:10`** to exact role equality — it leaks unmasked account
   numbers and IFSC codes to any role whose name contains "hr".

### Phase 1 — make the schema self-bootstrapping

7. **Port the Tier-1 DDL into `ensureOnce` blocks (§3.1)**, `user_face_enrollments` first — it gates
   every protected page in the product. Then attendance, daily reports, time logs, clock events,
   payroll. **Every column also as its own `ADD COLUMN IF NOT EXISTS`.** Until this lands, every
   feature built on top inherits the outage risk.
8. **Port `.dev-scripts/migrate-training.mjs` into `ensureTrainingSchema()` (§3.10).** Four tables
   with no DDL in the repo and two disjoint writers each; nothing about learning is verifiable first.

### Phase 2 — make the existing engine reachable

9. **Build the task assignment surface.** `createTask()` has zero callers. This one form turns four
   of the ten dashboard questions from structurally-empty into answered, and it needs **no schema
   change** — the engine, the permission model, the state graph and eleven components already exist.
   **Highest value-to-effort ratio in this document.**
10. **Wire `employee-tasks.ts` to `push.ts`** on assign, block, review-request and approve. Three
    imports, four call sites. Until then the `watcher` collaborator role watches nothing and assigned
    work reaches nobody who is not already looking at the page.
11. **Call `attachActivityFeed()` at boot.** One function call makes every event name in `ROUTING`
    real instead of aspirational.
12. **Open the portal notification inbox to employees** (`portal/notifications.astro:8`). Rows are
    already written for them; only the door is shut.

### Phase 3 — close the answerability gaps

13. **`staff_meetings` + `staff_meeting_invitees` (§3.8)**, plus the missing `/api/meet/rooms`.
    Question 6 is the only one with a UI already built against an endpoint that does not exist.
14. **`staff_announcements` (§3.9).** Publishing rides the notification system that already works.
15. **`reviewer_id` on `hr_performance_reviews` + a reviewer picker (§3.11).** The ALTER alone
    changes nothing; the column needs a writer before "waiting on me" means anything.
16. **A portal reader for `hr_employee_goals`, and acknowledgement surfaces for the four lifecycle
    tables.** The columns exist and are never written — a PIP the employee never saw currently looks
    identical to one they accepted.
17. **`training_assignments` (§3.10).** Depends on step 8. Until then "assigned learning" cannot
    exist; only "what I opened myself".

### Phase 4 — structure, once there is data to structure

18. **`work_projects` + `work_project_members` + task linkage (§3.4).** Deliberately after step 9:
    grouping is meaningless while the thing being grouped cannot be created. Remember
    `TASK_COLUMNS` must not name the new columns.
19. **`hr_holidays` + `hr_leave_balance` (§3.5).** Entitlement only — consumption stays derived.
    Fixes "absent" being computed against calendar days including weekends.
20. **`field-security.ts` (§3.6).** Formalises the allow-list convention that
    `workspace-access.ts:153` already follows by hand, with `recordStrict`-style audit.
21. **`approval_requests` + `approval_steps` (§3.12).** Last on purpose: one chain does not justify a
    framework. Build it when a second real chain exists — and only after step 5 has closed the hole,
    which the table does not close by itself.
22. **`hr_reporting_line` (§3.3).** Optional. Only if skip-level, dotted lines or history are
    genuinely needed; today one nullable column is the entire org chart, and it works for approvals.

---

## Verification status of this document

Reported per pipeline stage, honestly. **This document is a Markdown file. It enters no build graph
and changes no behaviour.**

| Stage | Result |
|---|---|
| **Source verification** | **EXECUTED.** Every Tier-1 and Tier-2 register entry was re-verified by grep this session, not carried over from a briefing. Confirmed independently: `createTask` has zero callers outside its own file; `work_email` appears in no `INSERT` column list or `UPDATE ... SET` anywhere; `users.full_name` is named by four files against a table that has `name`; `overtime_hours` has 4 grep hits and none is a write; `pr.reviewer_id` is joined and declared nowhere; `src/pages/api/meet/` does not exist; no `projects` table or `project_id` exists anywhere in `src/` or `db/` |
| **`astro check --minimumSeverity error`** | **EXECUTED as a baseline: 195 errors across 1448 files.** All pre-existing — I edited no TypeScript or `.astro` file, so this document cannot have changed the count. The captured tail independently confirms register entry #17's neighbour: `portal/submissions/new.astro:28` comparing `user.role` against `'campus_ambassador'`, which is not a `user_role` enum value. **I piped the run through `tail` and read only the last lines, so I have NOT reviewed the other ~194 errors and do not claim they are unrelated to this domain** |
| **Compilation** | **NOT APPLICABLE.** No source file was created or modified |
| **Prerender** | **NOT APPLICABLE.** Same reason. Note for the record: the discovery passes reported `npm run build` reaching *and completing* "prerendering static routes" with exit 0, contradicting the briefing's expectation of a `DATABASE_URL` failure on `src/pages/aaverify/addpanel.astro`. Nothing was changed to cause that |
| **Runtime** | **NOT EXECUTED.** No server started, no URL loaded, no query run. **Therefore every "populated" claim in this document is an inference from writer reachability in source, never an observation.** "Nothing writes this" is reliable (full-tree grep); "a live surface writes this" proves a path exists, not that anyone has walked it |
| **Accessibility** | **NOT EXECUTED.** No page rendered |
| **Responsive** | **NOT EXECUTED.** No page rendered |
| **Migrations** | **NOT APPLIED.** No SQL in this document has been run against any database, and none should be run by an agent. Per CLAUDE.md, schema changes are handed to the user to run |

**CLAUDE.md compliance:** no database connection was opened, no `.env*` file was read, no script that
opens a connection was run, and no file outside `docs/` was created or modified.

**The one question this document cannot answer from source:** which shape of `chat_messages` is live.
That requires an `information_schema` query, which is the user's to run.
