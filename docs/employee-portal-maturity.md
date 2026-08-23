# Employee Portal Maturity Matrix

Date: 2026-08-16. Scope: 75 portal surfaces across 10 domains.

**Method.** Source-only static audit. No database connection, no `.env*` read, no script execution.
Schema facts come from `db/*.sql` and `src/lib/db/schema.ts`; behaviour facts come from reading the page
file and every library function it calls. Scores below have already survived an adversarial challenge pass —
where a score moved, the correction is recorded in the domain notes rather than re-litigated here.

**Scoring legend.**

| Token | Meaning |
| --- | --- |
| YES | The axis is satisfied and the citation proves it. |
| PARTIAL | Satisfied on one path and not on another, or satisfied in a way that can silently fail. |
| NO | Not satisfied. |
| UNKNOWN | Cannot be established from source alone. |

**Axis definitions used.** BUILT = renders something real. FUNCTIONAL = the primary action completes end to
end and persists. INTEGRATED = data crosses a domain boundary by code. AUTOMATED = something happens with no
human clicking (cron, trigger, event consumer). INTELLIGENT = derived insight, not an if/else. SECURE =
server-side authorization on the GET render *and* every mutation, scoped to this user's own records.
AUDITED = an audit record on the success path *and* that write cannot fail silently. MOBILE = usable
one-handed on a phone. ACCESSIBLE = labels tied to inputs, landmarks, keyboard reach, focus states.

**Caveat that governs two whole columns.** MOBILE and ACCESSIBLE were judged by reading CSS rules, media
queries, touch-target minimums and markup — not by loading a page on a handset and not by running a screen
reader. A page scored MOBILE=YES has responsive rules, 44px controls and contained table overflow in its
source; it has not been thumbed. A page scored ACCESSIBLE=PARTIAL has a named, cited markup defect; it has
not been driven with assistive technology. Treat both columns as "the source does not disqualify it",
not as "verified in use".

---

## Scoreboard

75 pages x 9 axes = 675 scored cells. Counts are exact; the arithmetic is stated so it can be rechecked.

| Axis | YES | PARTIAL | NO | UNKNOWN | YES % | Weighted % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BUILT | 73 | 0 | 2 | 0 | 97.3 | 97.3 |
| MOBILE | 64 | 8 | 0 | 3 | 85.3 | 90.7 |
| INTEGRATED | 56 | 15 | 4 | 0 | 74.7 | 84.7 |
| FUNCTIONAL | 47 | 27 | 1 | 0 | 62.7 | 80.7 |
| SECURE | 43 | 20 | 12 | 0 | 57.3 | 70.7 |
| ACCESSIBLE | 19 | 49 | 4 | 3 | 25.3 | 58.0 |
| INTELLIGENT | 7 | 27 | 41 | 0 | 9.3 | 27.3 |
| AUDITED | **0** | 35 | 39 | 1 | **0.0** | 23.3 |
| AUTOMATED | 4 | 11 | 60 | 0 | 5.3 | 12.7 |

Arithmetic: `YES % = YES / 75`. `Weighted % = (YES + 0.5 x PARTIAL) / 75`, with UNKNOWN counted as zero.
The two columns are reported side by side because they disagree in a way that matters: FUNCTIONAL looks
healthy weighted (80.7) and mediocre unweighted (62.7), and the 27 PARTIALs are exactly the "the UI exists,
the business process does not" cases this audit was commissioned to find.

**Three facts the table states plainly.**

1. **AUDITED has zero YES across all 75 pages.** Not one. Every audit write in the product funnels through
   `src/lib/audit.ts:63-66`, which catches its own failure and `console.error`s it, so the second clause of
   the axis ("the audit write cannot silently fail") is unsatisfiable by construction. 39 pages write no
   audit record at all.
2. **AUTOMATED is 4 YES out of 75.** The only earned ones are `/portal/wallet` (payments reconcile cron),
   `/portal/face-data` (face-retention cron), `/portal/notifications` (two crons write the table it reads)
   and `/portal/employee/mail` (inbound poll + snooze wake). Everything else that looks automated is
   reconcile-on-page-load.
3. **BUILT is 97.3% and FUNCTIONAL unweighted is 62.7%.** That 35-point gap is the shape of the problem the
   owner described. Pages are built. Processes are not finished.

### Domain maturity ranking

Score = `(YES + 0.5 x PARTIAL) / (pages x 9)` for each domain.

| Rank | Domain | Pages | Cells | Points | Maturity |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | Time, attendance, shifts & calendar | 10 | 90 | 62.5 | 69.4% |
| 2 | Pay, payslips, wallet, loans, expenses, credits | 7 | 63 | 42.5 | 67.5% |
| 3 | Projects, reports, worklog, workspace, procurement | 7 | 63 | 41.5 | 65.9% |
| 4 | Benefits, documents, contract, assets, evidence | 5 | 45 | 29.0 | 64.4% |
| 5= | Leave, approvals & delegation | 3 | 27 | 16.5 | 61.1% |
| 5= | Performance, learning, knowledge, referrals, internship | 6 | 54 | 33.0 | 61.1% |
| 7 | Wellbeing, health & women's health | 8 | 72 | 42.5 | 59.0% |
| 8 | Team, organization, support, messages, notifications, mail | 8 | 72 | 42.0 | 58.3% |
| 9 | Portal shell, navigation, auth entry, search & PWA | 9 | 81 | 44.5 | 54.9% |
| 10 | Onboarding, profile, identity, security & record access | 12 | 108 | 55.0 | 50.9% |

The ranking inverts the intuitive one. Attendance — the domain with the most moving parts — is the most
mature, because its writes are consumed by payroll and its rules are re-checked at the write. The identity
and onboarding domain is last, and it holds the single worst security finding in the audit.

---

## The matrix

Columns: BLT = built, FNC = functional, INT = integrated, AUT = automated, INL = intelligent, SEC = secure,
AUD = audited, MOB = mobile, ACC = accessible.

### Time, attendance, shifts and calendar

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal/employee/attendance | YES | YES | YES | NO | PARTIAL | YES | PARTIAL | YES | YES | RETAIN |
| /portal/employee/attendance/approvals | YES | YES | YES | PARTIAL | NO | PARTIAL | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/attendance/clock-out | YES | YES | YES | PARTIAL | NO | YES | PARTIAL | YES | YES | REFACTOR |
| /portal/employee/attendance/corrections | YES | YES | YES | NO | NO | PARTIAL | PARTIAL | YES | YES | RETAIN |
| /portal/employee/attendance/overtime | YES | PARTIAL | PARTIAL | NO | PARTIAL | YES | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/attendance/roster | YES | YES | YES | NO | NO | YES | NO | YES | YES | REFACTOR |
| /portal/employee/timesheet | YES | PARTIAL | PARTIAL | NO | PARTIAL | YES | PARTIAL | YES | PARTIAL | MERGE |
| /portal/employee/schedule | YES | YES | PARTIAL | NO | YES | YES | PARTIAL | YES | PARTIAL | RETAIN |
| /portal/employee/schedule/approvals | YES | YES | YES | PARTIAL | YES | NO | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/calendar | YES | YES | YES | NO | PARTIAL | YES | NO | YES | YES | RETAIN |

### Leave, approvals and delegation

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal/employee/leave | YES | YES | YES | NO | PARTIAL | YES | NO | YES | PARTIAL | REFACTOR |
| /portal/approvals | YES | YES | YES | NO | PARTIAL | PARTIAL | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/delegation | YES | PARTIAL | YES | NO | NO | NO | PARTIAL | YES | PARTIAL | REBUILD |

### Pay, payslips, wallet, loans, expenses, credits

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal/employee/payslips | YES | PARTIAL | YES | NO | PARTIAL | PARTIAL | NO | YES | PARTIAL | REFACTOR |
| /portal/employee/wallet | YES | PARTIAL | YES | PARTIAL | PARTIAL | NO | NO | PARTIAL | YES | REFACTOR |
| /portal/employee/loans | YES | YES | YES | PARTIAL | PARTIAL | PARTIAL | PARTIAL | YES | PARTIAL | RETAIN |
| /portal/employee/expenses | YES | YES | YES | PARTIAL | YES | YES | PARTIAL | YES | PARTIAL | RETAIN |
| /portal/employee/credits | YES | YES | YES | PARTIAL | YES | YES | PARTIAL | YES | PARTIAL | RETAIN |
| /portal/employee/credits/approvals | YES | YES | YES | NO | PARTIAL | NO | PARTIAL | YES | YES | REFACTOR |
| /portal/wallet | YES | PARTIAL | YES | YES | PARTIAL | PARTIAL | NO | PARTIAL | NO | REFACTOR |

### Benefits, documents, contract, assets, evidence

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal/employee/benefits | YES | PARTIAL | YES | NO | PARTIAL | PARTIAL | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/documents | YES | PARTIAL | YES | NO | NO | PARTIAL | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/contract | YES | YES | YES | NO | NO | YES | NO | YES | PARTIAL | RETAIN |
| /portal/employee/assets | YES | YES | YES | NO | NO | PARTIAL | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/evidence | YES | YES | YES | NO | YES | YES | PARTIAL | YES | YES | RETAIN |

### Onboarding, profile, identity, security and record access

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal/face-data | YES | PARTIAL | YES | YES | PARTIAL | YES | PARTIAL | YES | PARTIAL | RETAIN |
| /portal/face-setup | YES | YES | YES | NO | NO | PARTIAL | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/enroll-face | YES | YES | YES | NO | NO | PARTIAL | NO | PARTIAL | NO | REMOVE |
| /portal/employee/profile | YES | YES | YES | NO | NO | YES | PARTIAL | YES | YES | RETAIN |
| /portal/employee/security | YES | YES | PARTIAL | NO | NO | YES | NO | YES | PARTIAL | RETAIN |
| /portal/security | YES | PARTIAL | PARTIAL | NO | NO | PARTIAL | NO | PARTIAL | PARTIAL | MERGE |
| /portal/employee/onboarding | YES | YES | YES | NO | PARTIAL | NO | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/onboarding | YES | YES | YES | PARTIAL | NO | YES | PARTIAL | YES | PARTIAL | MERGE |
| /portal/profile | YES | PARTIAL | PARTIAL | NO | NO | PARTIAL | NO | YES | PARTIAL | REFACTOR |
| /portal/my-record-access | YES | YES | YES | NO | NO | YES | NO | YES | PARTIAL | REFACTOR |
| /portal/activate | NO | PARTIAL | NO | NO | NO | PARTIAL | NO | UNKNOWN | UNKNOWN | REMOVE |
| /portal/totp-setup | NO | NO | NO | NO | NO | YES | NO | UNKNOWN | UNKNOWN | DEPRECATE |

### Performance, learning, knowledge, referrals, internship

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal/employee/performance | YES | YES | YES | NO | PARTIAL | NO | PARTIAL | YES | YES | REFACTOR |
| /portal/employee/learning | YES | YES | YES | NO | PARTIAL | YES | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/knowledge | YES | YES | PARTIAL | NO | NO | YES | PARTIAL | YES | PARTIAL | RETAIN |
| /portal/employee/referrals | YES | PARTIAL | YES | NO | NO | YES | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/internship | YES | PARTIAL | YES | NO | YES | PARTIAL | NO | YES | PARTIAL | RETAIN |
| /portal/achievements | YES | PARTIAL | YES | NO | NO | NO | NO | YES | PARTIAL | MIGRATE |

### Projects, reports, worklog, workspace, procurement

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal/employee/projects | YES | YES | YES | NO | PARTIAL | YES | UNKNOWN | YES | PARTIAL | REFACTOR |
| /portal/employee/projects/[id] | YES | YES | YES | NO | PARTIAL | NO | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/reports | YES | YES | YES | NO | PARTIAL | YES | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/employee/reports/team | YES | YES | YES | NO | PARTIAL | YES | PARTIAL | YES | PARTIAL | RETAIN |
| /portal/employee/procurement | YES | YES | YES | NO | PARTIAL | YES | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/worklog | YES | PARTIAL | PARTIAL | PARTIAL | NO | PARTIAL | NO | YES | PARTIAL | MERGE |
| /portal/workspace | YES | YES | YES | NO | PARTIAL | YES | NO | YES | PARTIAL | REFACTOR |

### Team, organization, support, messages, notifications, mail

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal/team | YES | PARTIAL | YES | NO | NO | YES | NO | YES | PARTIAL | RETAIN |
| /portal/team-groups | YES | YES | YES | PARTIAL | NO | YES | NO | YES | PARTIAL | REFACTOR |
| /portal/organization | YES | PARTIAL | YES | NO | NO | YES | NO | YES | YES | RETAIN |
| /portal/employee/support | YES | PARTIAL | YES | NO | NO | YES | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/messages | YES | YES | PARTIAL | NO | NO | YES | NO | YES | PARTIAL | REFACTOR |
| /portal/notifications | YES | YES | YES | YES | NO | YES | NO | YES | PARTIAL | REFACTOR |
| /portal/employee/mail | YES | YES | YES | YES | NO | YES | NO | YES | PARTIAL | RETAIN |
| /portal/mail | YES | PARTIAL | NO | NO | NO | NO | NO | PARTIAL | NO | REMOVE |

### Wellbeing, health and women's health

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal/wellbeing | YES | PARTIAL | NO | NO | NO | PARTIAL | NO | PARTIAL | NO | REFACTOR |
| /portal/wellness | YES | YES | PARTIAL | NO | YES | YES | NO | YES | YES | RETAIN |
| /portal/wellness/consult | YES | PARTIAL | YES | NO | PARTIAL | YES | NO | YES | YES | REFACTOR |
| /portal/wellness/consultant | YES | YES | YES | NO | NO | YES | NO | YES | YES | RETAIN |
| /admin/wellness | YES | YES | YES | NO | PARTIAL | YES | NO | YES | YES | RETAIN |
| /admin/wellness/consultants | YES | YES | YES | NO | NO | PARTIAL | NO | YES | YES | REFACTOR |
| /founder/admin/wellness | YES | YES | YES | NO | PARTIAL | YES | NO | YES | YES | MERGE |
| /aquintutor/campus/wellness | YES | PARTIAL | PARTIAL | NO | NO | NO | NO | PARTIAL | PARTIAL | REBUILD |

### Portal shell, navigation, auth entry, search and PWA

| Route | BLT | FNC | INT | AUT | INL | SEC | AUD | MOB | ACC | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /portal | YES | PARTIAL | YES | NO | NO | YES | NO | YES | PARTIAL | REFACTOR |
| /portal/employee | YES | PARTIAL | YES | NO | PARTIAL | YES | PARTIAL | YES | YES | RETAIN |
| /portal/login | YES | YES | YES | NO | NO | PARTIAL | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/signup | YES | YES | YES | PARTIAL | NO | PARTIAL | PARTIAL | YES | PARTIAL | REFACTOR |
| /portal/forgot | YES | PARTIAL | PARTIAL | NO | NO | NO | NO | YES | PARTIAL | REPLACE |
| /portal/search | YES | YES | YES | NO | NO | YES | NO | YES | YES | RETAIN |
| /portal/feed | YES | PARTIAL | PARTIAL | NO | PARTIAL | NO | NO | PARTIAL | PARTIAL | REBUILD |
| /portal/logout | YES | YES | PARTIAL | NO | NO | YES | NO | UNKNOWN | UNKNOWN | RETAIN |
| /portal/sign-out | YES | YES | PARTIAL | NO | NO | YES | NO | YES | PARTIAL | RETAIN |
---

## Dead ends: UI that promises what the backend does not deliver

Thirty-two confirmed. Ranked by how badly a real employee is misled, weighting three things: does the person
act on the false belief, does money or a legal right depend on it, and would they ever find out.

### Tier 1 — the person acts on it, money or a right depends on it, and nothing tells them

**1. Biometric erasure is real in the database and undone by the product within one click.**
`/portal/face-data` promises "You can turn it off and delete what is held at any time, and keep your account"
(face-data.astro:53-56). The delete is genuinely rigorous: `src/lib/auth/face-erasure.ts:170-193` DELETEs the
row rather than deactivating it and reads back to confirm. Then `src/middleware.ts:180` makes every `/portal/`
path protected, `src/middleware.ts:133-171` `isExempt()` lists `/enroll-face`, `/portal/face-setup`,
`/portal/enroll-face` and `/portal/sign-out` — and **not** `/portal/face-data` — and
`src/middleware.ts:503-509` bounces any signed-in user without an enrolment straight into re-enrolment. The
page's own "Back to portal" link (face-data.astro:153-155) is the trigger. The retention cron carries the same
defeat: `face-erasure.ts:326-360` deletes a dormant user's template and notifies them with `actionUrl`
`/portal/face-data` (face-erasure.ts:351) — a page they can no longer open without enrolling a new face. The
product's only genuine automation in that domain is a loop that deletes and re-collects biometric data.

**2. Overtime settled as "Paid with my salary" is approved and never paid.**
`src/pages/portal/employee/attendance/overtime.astro:342` offers
`<option value="pay">Paid with my salary</option>` and tells the employee it records the hours for payroll to
read. On approval `src/lib/attendance.ts:2350` writes `hr_attendance.overtime_hours` and, for `comp_off`
only, credits the leave ledger (`attendance.ts:2356-2385`). A case-insensitive grep for `overtime` across
`src/lib/payroll.ts` returns **zero** hits: payroll reads neither `overtime_hours` nor
`hr_overtime_requests`. The only readers of the column are attendance report aggregates
(`attendance.ts:2782`, `:2836`) and the admin attendance grid. Claim, approve, get nothing, and no screen
says so.

**3. "Mark paid" can pay nobody, and the employee is told the money has left.**
`RAZORPAYX_ACCOUNT_NUMBER` is registered severity `optional` (`src/lib/deployment-readiness.ts:146`). When it
is unset, `src/lib/hr-wallet.ts:870-871` skips the gateway branch entirely (the `if` requires KEY && SECRET &&
ACCOUNT && a stored account number), writes the wallet debit, sets `status='paid'` with `payout_ref = null`,
and pushes the employee "has left for your bank account" (`hr-wallet.ts:940-947`). The reference field that
would make this honest carries no `required` attribute (`src/pages/admin/hr/wallet/index.astro:259`). The
employee's own page promises the opposite: "paid to your bank via the payment gateway"
(`/portal/employee/wallet.astro:238`).

**4. A private consultation note reaches a human only by habit.**
`/portal/wellness/consult:201` tells her "It goes to one wellness consultant, who reads it and writes back on
this page". `createConsultRequest` (`src/lib/wellness.ts:1578-1610`) notifies nobody. `upsertConsultant`
(`wellness.ts:1774-1800`) notifies nobody. `routeConsultToConsultant`'s notify is guarded
`if (routedBy && routedBy !== consultantUserId)` (`wellness.ts:1971-1980`) and its only caller passes the same
id twice (`consultant.astro:104`), so it never fires. The urgency ladder ("Looked at first",
`wellness.ts:1553`) only changes an `ORDER BY` (`wellness.ts:1922`). If no consultant has been appointed the
form still renders and still submits — the picker is simply omitted (`consult.astro:347`). Compounding it,
withdrawing discards the result: `consult.astro:118-121` calls `cancelConsultRequest` and redirects to
`?withdrawn=1` unconditionally, while `wellness.ts:1664-1677` returns `ok:false` on exception and its UPDATE
carries `AND status IN ('open','assigned')`, so once a consultant has replied the withdrawal matches zero rows
and her message is still readable — under a confirmation saying it is gone.

**5. Post visibility is collected and ignored.**
`/portal/feed` composer offers Public / Followers only / Course classmates / Unlisted (feed.astro:915), stores
the choice (`:219`, `:232`), and reads the feed with `SELECT id, author_user_id, ... FROM feed_posts ORDER BY
created_at DESC LIMIT 200` (feed.astro:274) — no `WHERE`, and `visibility` is not even in the SELECT list, so
no client-side filter is possible either. A post marked "Followers only" is served to every signed-in account.

**6. "This clock-out is marked for a person to look at" has no person.**
`clock-out.astro:346` renders that sentence and `attendance/index.astro:134` paints an amber "needs a look"
badge on every unverified punch. `unreviewedClockOutChecks()`
(`src/lib/attendance-verify-clockout.ts:1093`) has zero callers anywhere in `src/`;
`hr_clock_out_checks.reviewed_at` and `.review_note` (declared `:221-223`) have zero writers; there is no
`reviewClockOut` function at all, and no admin surface reads `face_verified` or `hr_clock_out_checks`. The
advisory-only design is correct — the human half of it was never built.

### Tier 2 — a real process stalls, and only a page-load by the right person unsticks it

**7. Asset requests are approved and nothing is ever issued.**
Employee raises `category=asset_request` at `/portal/employee/support`; `helpdesk.ts:789` opens a workflow
instance routed through `org_relationships`; the manager approves via `decideInstance`
(`support.astro:242-261`). `/admin/assets/index.astro:160` states in user-facing copy "this register issues
what was approved" and never queries `helpdesk_tickets` or `workflow_instances`, has no approved-but-unissued
queue, and `assignAsset()` (`src/lib/assets.ts:726-800`) never checks that an approval exists. The approval
does gate resolution (`helpdesk.ts:1073-1084` refuses to resolve an unapproved asset request), so it is not
inert — but nothing delivers.

**8. A benefit election is approved, the employee is push-notified, and the page keeps saying "waiting".**
`requestEnrolment` inserts `state='pending'` and starts a workflow (`src/lib/benefits.ts:1033-1070`). On
approval `workflow.ts:2564` fires `notifyRequester` ("Benefit election approved") and then
`settleDomainRecord` at `workflow.ts:2900` returns early for every domain except `leave` and `fee_waiver`.
The only writer of `state='active'` is `syncEnrolmentApprovals()` (`benefits.ts:1152-1200`), whose sole caller
is a top-level `await` on a page render: `/admin/hr/benefits/enrolments.astro:120`. Same shape for contracts:
`syncContractChanges()` (`src/lib/contracts.ts:737-800`) is called only from
`/admin/hr/contracts/index.astro:182`, so `/portal/employee/contract` keeps showing the old terms and
"Waiting for approval" after the approver has approved.

**9. Delegation keeps none of the three promises the page makes.**
The page says "An end date is required... This ends by itself." `openRelationship` has no `effectiveTo`
parameter (`src/lib/org-graph.ts:1428-1437`) and its INSERT omits the column (`:1478-1486`), while
`inForce()` treats `effective_to IS NULL` as in force forever (`org-graph.ts:283-288`). It says "What they
may do" over domain checkboxes enforced by `mayActFor()` (`src/lib/delegation.ts:408-423`), which has no
caller anywhere in `src/` — the consumer that admits a delegate, `workflow.ts:1668-1676`, asks only whether a
`temporary_delegate` edge exists. And "End this now" prints "Ended. They can no longer act for you."
(`delegation.astro:99`) from an unconditional `ok:true` (`org-graph.ts:1499-1519` never inspects the row
count).

**10. Work captured in the field reaches a table with no processor.**
`/portal/worklog` says "syncs to the team automatically when you are back online" and asks for Hours. The row
lands in `offline_work` and stops: it never becomes an `hr_time_logs` block, never touches `hr_attendance`,
never enters credit-hours. The only readers are `GET /api/offline/mine` (the same user) and
`/admin/offline-work`, which renders the jsonb as a `key: value` string dump
(`src/pages/admin/offline-work.astro:58-63`). The repo's own registry admits it:
`src/lib/workforce/widgets.ts:812-814` — "The payload is opaque jsonb and reaches no other table".

**11. The hour log that "fills in a block you forgot" changes none of the figures above it.**
`/portal/workspace` writes `hr_time_logs`; `src/lib/credit-ledger.ts` reads only `hr_attendance`
(`:229`, `:301`) and `hr_leave_request` (`:92`, `:285`) and never `hr_time_logs`. So Attendance %, Days
worked, Approved leave, Still to earn and the credit headline all stay put. Worse, the refusal text for
entries older than seven days points at a process that does not exist: `workspace.astro:169-173` says to ask
HR "so there is a record of who changed what", and repo-wide the only writers of `hr_time_logs` are
`workspace.astro:181/194` and `portal/employee.astro:497/514` — both self-service. `widgets.ts:735` already
records this.

**12. Two approval flows with no consumer.** `hr_timesheets`/`hr_timesheet_entries` are read only by
`attendance.ts`'s own readers (`:2489`, `:2496`, `:2524`) — payroll, credits and intern-hours never touch
them, so an approved week changes nothing (`/portal/employee/timesheet`, which says so honestly at
timesheet.astro:442). `eims_schedules` has zero readers outside `src/lib/eims-schedule.ts` — not the
calendar, not the credit ledger — while `/portal/employee/schedule:167` tells the intern "it is the weekly
credit record that shows how that week came out".

### Tier 3 — visible staleness, dead columns, and copy that overstates

| # | Route | The UI implies | What actually happens | Evidence |
| ---: | --- | --- | --- | --- |
| 13 | /portal/employee/referrals | The reward pill shows the current reward state | It is a stale cache; `refreshRewardState()` has one caller, an admin page | referrals.ts:651-681; admin/recruitment/referrals.astro:62 |
| 14 | /portal/employee/referrals | Submitting a referral reaches the hiring side | Zero notification calls in the module; the row waits for a page render | referrals.ts:311-395 |
| 15 | /portal/mail | Snooze for 1 hour / 3 hours / tomorrow / next week | `snooze_until` is written and read by nothing; no un-snooze | mail.astro:157; list queries 224-246 |
| 16 | /portal/notifications | Archive, delivery analytics | `is_archived`, `seen_at`, `clicked_at` have zero writers; the page filters on a column nothing can set | notifications-schema.ts:25-27; notifications.astro:152 |
| 17 | /portal/notifications | An "Announcements" lane | No announcements table exists; permanently empty by construction | notifications.astro:72-82 |
| 18 | /portal/wellbeing | "reminders in the background" | `setInterval` timers that die with the tab; no push subscription, no server schedule | wellbeing.astro:391-394, :408 |
| 19 | /portal/wellbeing | "We track your focus alongside your learning" | Nothing leaves the device; line 154 of the same page admits it | wellbeing.astro:99 vs :154 |
| 20 | /portal/wellbeing | "Day streak" as a focus achievement | Increments on page load whether or not a session ran | wellbeing.astro:208-212 |
| 21 | /portal/employee/contract | "Renewal review: DATE" | `contractsDueForRenewal()` is read only by an admin page; no cron, no reminder | contracts.ts:323-345 |
| 22 | /portal/employee/assets | "Reported. The desk can see it" | `reportDamage()` sends no notification; `assignAsset()` in the same file does | assets.ts:862-913 vs :777-792 |
| 23 | /portal/employee/assets | "Due back DATE" | Printed raw with no comparison to today; three months overdue looks identical | assets.astro:139 |
| 24 | /portal/employee/documents | Share this document with a colleague | The form asks for a raw `hr_employees` UUID; no picker exists in the portal | documents.astro:497-500 |
| 25 | /portal/employee/documents | "Retention date passed" | `retentionDue()` has one call site, this line; no queue, no digest, no cron | documents.astro:335 |
| 26 | /portal/employee/documents | A Publish button | Rendered for drafts that were never submitted, where publish always refuses | documents.astro:483; documents.ts:880-882 |
| 27 | /portal/profile | Hero CTA "Your professional profile - Edit" | `/portal/profile/edit.astro:7` redirects non-applicants to `/admin`, which bounces back | profile.astro:102 |
| 28 | /portal/profile | "Password - Change" | Points at `/portal/forgot`, the forgotten-password flow | profile.astro:186 |
| 29 | /portal/employee/learning | A recorded skill level is worth recording | `src/lib/match.ts`, `person-360.ts`, `capability-coverage.ts` have zero importers; only an admin heatmap reads the table | group finding |
| 30 | /portal/employee/learning | Training calendar "Sign up" | Writes `hr_training_signups`; no notification, no invite, no reminder, no audit | performance-learning.ts:846-885 |
| 31 | /portal/achievements | Your XP, level and badges | Every `awardXp()` caller is a learner route; no employee learning event awards XP | group finding |
| 32 | /portal/employee/procurement | "Discard... it cannot be brought back" | `cancelRequest` sets `status='cancelled'`; the row reappears below as "Withdrawn" | procurement.ts:1278-1281 |

**Two more that are not page-level but bite every page.** A pending approval rung is rendered as
"escalatable after N hours" (`procurement.astro:322` renders `step.dueAt`) while
`src/lib/workflow.ts:1916-1923` states there is deliberately no sweep and `stepsAwaitingEscalation()`
escalates nothing. And `src/lib/attendance-lapse.ts` is 24KB of finished, tested logic for the
nine-working-days auto-pause with 5- and 7-day warnings and appeals; its only references in `src/` are the
file itself and its test.
---

## Security findings

Twelve pages score SECURE=NO and twenty score PARTIAL. Everything below was confirmed by opening the
statement that does or does not carry the ownership predicate. Where a claim rests on inference it is marked
UNVERIFIED with the check that would settle it.

### S1 — CRITICAL. Account takeover of any employee's HR record via unverified self-signup

**Route** `/portal/employee/onboarding`. **Parameter** the signed-in account's own `users.email` — no id is
posted, which is why it does not read as an IDOR.

`src/pages/portal/employee/onboarding.astro:17` resolves the employee record with
`SELECT * FROM hr_employees WHERE user_id = ${user.id} OR lower(personal_email) = ${email} OR lower(email) =
${email} LIMIT 1` — no `ORDER BY`, no ambiguity refusal, no `is_active` filter.
`onboarding.astro:83-113` then writes `bank_account_number`, `bank_ifsc`, `pan_number`, `govt_id_number`,
`govt_id_doc_url` and emergency contact to `WHERE id = ${emp.id}`. The address is attacker-chosen and never
verified: `src/pages/portal/signup.astro:81` inserts the `users` row with no verification token, and
`email_verified` is written in exactly one file in the repo (`src/pages/portal/claim/[token].astro:105`) and
read by no login path. `db/hr-schema.sql:50-51` declares `personal_email TEXT` and `work_email TEXT` with no
unique constraint; the table's only UNIQUE is `employee_code` (`db/hr-schema.sql:47`). Rows whose address has
no account are the normal case — `src/lib/auth/workspace-access.ts:274-278` says so — so the "an account with
this email already exists" check at signup.astro:63 does not block registering one.

**Chain:** sign up with a target employee's `personal_email`, open `/portal/employee/onboarding`, read their
record and overwrite their payroll bank account before the next run.

**The fix already exists three files away.** `workspace-access.ts:281-285` does the same lookup with
`LIMIT 2` and `:432-435` refuses on `matches.length > 1`, with a comment naming the exact harm.

### S2 — CRITICAL. Unauthenticated read of another person's archived mail, self-escalating

**Route** `/portal/mail`. **Parameter** `?t=<uuid>` plus form field `thread_id`.

`mail.astro:252-259` runs `SELECT * FROM portal_mail_threads WHERE id = ${openId}::uuid` and
`SELECT ... body_html, body_text, ciphertext FROM portal_mail_messages WHERE thread_id = ${openId}::uuid`
with no join to `portal_mail_thread_state` and no user predicate. The list queries immediately above
(`:224-246`) *are* scoped `s.user_id = ${user.id}`, which is why it reads as safe on a skim. The render gate
requires at least one legacy state row (`mail.astro:134`) — and the attacker can mint one: the POST handlers
at `:147-153` (toggle_star), `:154-161` (move) and `:162-169` (snooze) each `INSERT INTO
portal_mail_thread_state (user_id, thread_id, ...)` with `thread_id` straight from the form and no ownership
check. So an account with zero rows POSTs `action=move` with any thread uuid, which both clears the gate and
grafts that thread into its own inbox list, after which `?t=` returns the bodies.

Same page, same severity class: `mail.astro:592` renders `set:html={m.body_html || fallbackHtml}` —
unsanitized HTML from a table other users wrote while its send path still worked — and attachments render
`<a href={a.dataUrl}>` from a jsonb column with no scheme check. Stored XSS.

### S3 — HIGH. `escalateStep()` has no authorization, and two portal pages call it raw

**Routes** `/portal/employee/credits/approvals` (`approvals.astro:74-77`) and
`/portal/employee/schedule/approvals` (`approvals.astro:70`). **Parameter** form field `step_id`.

`src/lib/workflow.ts:2748-2753` states it in the source: "NO ENTITLEMENT CHECK HERE, AND THE CALLER MUST
PROVIDE ONE... Any NEW caller must bring its own gate; there is none inside this function." Its only guards
are `step.decision === 'pending'` (`:2771`) and not-already-escalated (`:2778`); `actorId` is used solely for
the audit diff (`:2833`). Neither portal caller brings a gate — both sit behind `requireEmployee`, i.e. every
active employee — and neither constrains the posted step to its own domain, so a `leave`, `expense`,
`procurement` or `invoice` step id is accepted just as readily. A successful call INSERTs a new approver from
the subject's reporting chain (`:2818`) and `notifyApprover` (`:2830`) pushes "SUBJECT is waiting on your
decision" to somebody who was never routed it — a privacy leak on leave in particular. The returned error
strings are an oracle ("That step is already approved", "There is nobody above them in the organization
graph"). The four admin callers sit behind admin gates, which has been masking this.

Fix once, in the engine: call `mayAct()` inside `escalateStep`. The module even ships the domain guard the
credits page does not use (`credit-week-ledger.ts:1065` `stepIsCreditDecision()`).

### S4 — HIGH. A withdrawal can name a bank account that is not yours

**Route** `/portal/employee/wallet`. **Parameter** form field `bank_account_id` (wallet.astro:59-60).

`requestWithdrawal`'s `INSERT ... SELECT` (`src/lib/hr-wallet.ts:472-486`) guards the AMOUNT against the
balance, carefully and atomically, and says nothing about the payee: `${bankAccountId}` is written with no
subquery tying it to the employee. `hr_bank_account` and `hr_withdrawal` are created with **no foreign key**
(`hr-wallet.ts:100-115`), so no constraint catches it. On release, `payWithdrawal` LEFT JOINs
`hr_bank_account` on that id (`:826`) and posts holder/IFSC/account number as the payout fund account
(`:877`). A uuid matching nothing is worse in a different way: the join yields nulls, the gateway branch is
skipped, and the request is marked paid via `manual` with `payout_ref` null while the wallet is still debited
(`:869`, `:928-931`). The `<select>` renders only the caller's own accounts, which is presentation, not
enforcement — every comparable id in this cluster (`claim_id`, `loan_id`, `settles_advance_id`) is re-checked
server-side and this one is not. **Fix:** `AND EXISTS (SELECT 1 FROM hr_bank_account WHERE id =
bankAccountId AND employee_id = employeeId)` inside the same INSERT, plus the FK.

### S5 — HIGH. Six unscoped goal writers on the performance page

**Route** `/portal/employee/performance`. **Parameters** form fields `goal_id` and `kr_id`.

Every receiving statement is keyed on the id alone: `goals.ts:484-490` INSERT INTO `hr_goal_key_results`
with `${goalId}` and no owner check; `goals.ts:530-534` `UPDATE hr_goal_key_results ... WHERE id =
${keyResultId}::uuid`; `goals.ts:578-583` `UPDATE hr_employee_goals ... WHERE id = ${goalId}::uuid`;
`goals.ts:607` `DELETE FROM hr_goal_key_results WHERE id = ${keyResultId}::uuid`; `hr-lifecycle.ts:509-513`
`UPDATE hr_employee_goals SET status/outcome_notes WHERE id = ${goalId}` with no actor parameter at all.
The page passes the form fields through untouched (`performance.astro:160`, `:172`, `:181`, `:186`, `:193`).
Any authenticated employee holding another person's goal or key-result UUID can add a key result to it,
overwrite its value, delete it, set its progress, or close it as "missed" with arbitrary notes. The correct
check exists in the same file and is called by no writer: `goals.ts:341-348` `getGoalFor(viewer, goalId)`.
The review half of the same handler is scoped correctly (`performance.ts:640-642`, `:686-697`), so this is a
check the authors know how to apply and did not.

### S6 — HIGH. Any signed-in employee can sever any edge in the organization graph

**Route** `/portal/employee/delegation`. **Parameter** hidden form field `id`.

`delegation.astro:96-101` posts it into `endDelegation`; `src/lib/delegation.ts:293-301` checks only
`isUuid`; `org-graph.ts:1499-1519` `closeRelationship` UPDATEs `WHERE id = $1 AND effective_to IS NULL AND
effective_from < $2` — no type, no subject, no object. Posting the UUID of a `reporting_manager` or
`department_head` row closes it, and that graph is what routes every approval (`hr-wallet.ts:676-680`,
`workflow.ts:1668-1676`). `closeRelationship` discards the row count and always returns `ok:true`, so the
page prints "Ended. They can no longer act for you." either way.

Related privilege escalation on the same page: because `effective_to` is never written and the granted domain
list is never consulted, a delegation granted for "calendar" alone confers the principal's entire approval
queue, permanently (`delegation.ts:236-243`, `:408-423`; `org-graph.ts:1008-1030`, `:283-288`;
`org-graph-schema.ts:143` declares the column with no DEFAULT and there is no trigger).

### S7 — HIGH. Learner email addresses published on a company-wide leaderboard, opt-out by default

**Route** `/portal/achievements`. Not an IDOR — a disclosure on the GET render.
`src/lib/gamification.ts:245` selects `COALESCE(u.name, u.email, 'Learner') AS display_name`;
`achievements.astro:251` renders it through `shortName()`, which splits on whitespace and returns a
single-token string unchanged (`achievements.astro:47-52`), so a full address prints unmasked. The board is
unfiltered by org, department or relationship (`achievements.astro:15`), and `setLeaderboardOptOut`
(`src/lib/xp.ts:432-439`) only writes a row when somebody ticks the box, so the default for everyone who has
never opened the page is "published". One-line fix: drop the `u.email` arm of the COALESCE.

### S8 — HIGH. Unauthenticated bulk enumeration of who applied for what

**Route** `/portal/forgot`. **Parameter** form field `email`.
`src/middleware.ts:152` exempts the page from every gate. `forgot.astro:37-41` returns that address's
application numbers, role titles and dates on an unauthenticated POST, and `:44-47` falls through to a
`users` lookup so the response distinguishes "has applications" / "has an account only" / "nothing" — a clean
three-way oracle. No rate limit, no challenge, no logging anywhere; the project's own limiter
(`countAttempt` / `passwordAttemptsBlocked`, used at `login.astro:230`, `:269`) is not imported here.

### S9 — HIGH. Self-appointment into the wellness consultant pool reaches unassigned disclosures

**Route** `/admin/wellness/consultants`. `consultants.astro:79-93` resolves any account by typed email and
calls `upsertConsultant({ isActive: true })` with no check that the appointee is not the acting
administrator. `wellness.ts:1758-1770` then returns true from `isWellnessConsultant`, which is the only gate
on `/portal/wellness/consultant:81`. From there `routeConsultToConsultant`'s WHERE is `id = ... AND status =
'open'` (`wellness.ts:1962-1965`) with no restriction on which requests a pool member may take, and
`listAssignedConsults` returns `q.message` in full (`wellness.ts:1818-1826`). The page's own stated mitigation
— "adding yourself to the pool would put your name on the requester's form" (`consultants.astro:14-17`) —
holds only for requests where she picked a consultant (`wellness.ts:1591-1601`), i.e. not for the routing
queue, which is where the reach is widest. Nothing in the chain writes an audit record.

### S10 — MEDIUM. IDOR on the assign-task write

**Route** `/portal/employee/projects/[id]`. **Parameter** the URL segment `id` plus `action=assign-task`.
Nine of the ten write branches call `projectAuthority(actor, projectId)` (`projects.ts:1990`, `:2166`,
`:2244`, `:2308`, `:2355`, `:2413`, `:2473`, `:2557`, `:2648/2709`). The tenth
(`projects/[id].astro:228-239`) does not, and the DB gate it relies on
(`src/lib/employee-tasks.ts:2494-2502`) authorises the *assignee* relationship, not the project: its first arm
is `e.user_id::text = ${assigner}`. So any employee can POST `action=assign-task` naming themselves, against
any project uuid, and write `employee_tasks.project_id` for a project they cannot open. Write-only pollution
— `projectDetail` still gates reads on `maySee` — but the task then appears in that project's list and
progress count to its real owner.

### S11 — MEDIUM. Three portal pages resolve identity by email with no ambiguity guard

`/portal/employee/benefits:61-65`, `/portal/employee/documents:58-61`, `/portal/employee/assets:45-48` —
each `... OR email = ${user.email}) AND is_active = true LIMIT 1`, no ORDER BY, no `lower()`, against columns
with no unique constraint (`db/hr-schema.sql:50-51`). On documents the mis-resolved id feeds an EDIT check:
`documents.astro:66` assigns `myEmployeeId`, passed as the third argument to `addVersion`,
`submitForApproval`, `publishDocument`, `retireDocument`, `shareDocument`, `unshareDocument` (`:93`, `:99`,
`:105`, `:111`, `:117`, `:126`) into `documents.ts:606-616` `mayEdit`, whose second arm is
`doc.ownerEmployeeId === employeeId`. Four more of the same shape sit on the money pages:
`payslips.astro:35-39`, `wallet.astro:29` (which then makes the guess permanent with
`UPDATE hr_employees SET user_id = <me> WHERE id = <the guessed row>` at `:34-40`), `loans.astro:59-63`,
`api/portal/expenses/submit.ts:60-63`.

### S12 — MEDIUM. Two ids in one POST, one authorised and one not

**Route** `/portal/employee/attendance/corrections`. `corrections.astro:180` correctly re-checks
`instance_id` through `decideInstance` -> `mayAct` (`workflow.ts:2478-2485`). The same POST carries
`correction_id` (`:196`), passed to `applyCorrection` (`:198`) with nothing checking it belongs to that
instance, to the actor, or to the actor's queue. Bounded by `attendance.ts:1789`, which re-reads that
correction's own workflow and refuses unless it says `approved`, so the ceiling is forcing early application
of somebody else's already-approved correction.

### S13 — MEDIUM. Unscoped company-wide settlement sweep triggered by one approval click

**Route** `/portal/employee/attendance/approvals:86`. `applyApprovedOvertimeClaims(null, 20)` — `null` yields
an empty scope at `attendance.ts:2413` (`isUuid(employeeId) ? ... : sql''`), so the SELECT at `:2415-2421`
sweeps `hr_overtime_requests` company-wide and `:2350`/`:2364` write `hr_attendance.overtime_hours` and the
comp-off ledger for employees this actor has no relationship to. `approvals.astro:88` then echoes the count
of other people's claims back to whoever pressed the button. The engine guard at `:2338-2343` bounds the
damage to premature application. The scoped form was available and used on the sibling page
(`overtime.astro:189`).

### S14 — MEDIUM. Health-adjacent PII accepted from anonymous visitors

**Route** `/aquintutor/campus/wellness`. The frontmatter contains no `Astro.locals.user` read and no
redirect; `src/pages/api/aquintutor/wellness/counselling.ts:35-58` and
`.../sleep-signup.ts:23-36` have no session check, and the only throttle is `tooFast()` keyed on
`clientAddress` (`counselling.ts:42`). Anyone on the internet can insert a mental-health topic plus 2000
characters of free text and a contact address. The tables are bootstrapped by CREATE-TABLE-IF-NOT-EXISTS DDL
that runs on every render, including for an anonymous visitor (`wellness.astro:9-39`). Anonymity handling
itself is correct — the display name is dropped at the boundary (`counselling.ts:44`) rather than stored and
filtered later.

### S15 — MEDIUM. Authenticated portal HTML is cached to disk and never purged at sign-out

`public/sw.js:61` exempts only `/api/` and `/admin` from caching; every other same-origin basic GET is
written to PAGE_CACHE (`sw.js:76-97`) and served from cache after a 3.5s network timeout or offline. That
includes `/portal/employee/payslips`, `/portal/employee/profile` and the employee home. `vercel.json:33-41`
sets `no-store` for `/admin/(.*)`; `vercel.json:66-73` gives `/portal/(.*)` only an `X-Robots-Tag`. And
nothing clears it: `caches.delete` appears at `src/pages/admin/profile.astro:328` and in three service
workers, and in no portal path — `logout.ts` touches only the cookie and the sessions row. Sign out on a
shared phone, go offline, and the previous account's cached pages render.

### Lower-severity and hygiene findings

| ID | Route | Finding | Evidence |
| --- | --- | --- | --- |
| S16 | /portal/employee/benefits | `cancelEnrolment` carries no ownership predicate of its own; the only check lives in the page, keyed on the soft-resolved id | benefits.ts:1094-1099 |
| S17 | /admin/wellness/consultants | `set_active` takes `user_id` from the form unvalidated; bounded because the statement is UPDATE-only so it cannot mint a consultant | consultants.astro:65-67; wellness.ts:1802-1812 |
| S18 | /portal/worklog | `offline_work.client_id` is a GLOBAL primary key and both writers use `ON CONFLICT DO NOTHING`; a user can squat another user's client id and suppress their entry while the page prints "Entry saved." | api/offline/sync.ts:13, :38; worklog.astro:44-48 |
| S19 | /portal/employee/documents | The decide action accepts any workflow instance id with no domain filter, so the library's buttons are a general decision endpoint for all twenty domains (mayAct still gates) | documents.astro:143-144 vs :204 |
| S20 | /portal/employee/evidence | `task_a` is stored as `activity_id` with only a length clean; neutralised downstream by the owner check at eims-evidence.ts:1429-1435 | evidence.astro:94-99 |
| S21 | /portal/employee/credits, /portal | State-changing writes on a GET render: credits creates workflow instances and notifies approvers; `/portal:62` UPDATEs `users.access_status` inside a bare catch | credits.astro:64-76; index.astro:62 |
| S22 | /founder/admin/wellness | Borrows the legal-hold gate without the `logAccess()` CLAUDE.md requires, and that gate never checks `user.isActive` unlike `can()` | legal-hold.ts:405-409 vs permissions.ts:1441 |
| S23 | /portal/organization | The focused reporting chain climbs out of the viewer's scope: `getReportingChain` has no scope predicate | org-graph.ts:1048-1086 |
| S24 | group-wide | No CSRF token on any portal form; the sole defence is `sameSite:'lax'` on the session cookie | src/lib/auth/cookie.ts:33-35, :43-45 |
| S25 | /portal/sign-out | Ends the current session only; `invalidateAllUserSessions` exists, is exported, and is called from nowhere in this flow, while the copy addresses "this phone is not yours" | session.ts:67-74; sign-out.astro:70-73 |
| S26 | /portal/employee | A delete that matches zero rows still redirects to "Time log deleted"; no RETURNING, no rowcount check | employee.astro:507-520 |
| S27 | /portal/login | The biometric audit rows and `last_used_at` update both end `.catch(() => {})` | login.astro:130, :150, :192, :199 |
| S28 | /portal/signup | Account enumeration: "An account with this email already exists", unauthenticated and unthrottled | signup.astro:62 |

**UNVERIFIED, and what would settle it.** (a) Whether `RAZORPAYX_ACCOUNT_NUMBER` is actually set in the
deployed environment — S3's blast radius depends on it and reading env files is out of scope; the check is
`/admin/hr/wallet`, which already renders "manual settlement" when it is unset
(`admin/hr/wallet/index.astro:181`). (b) How many `hr_employees` rows carry a null `user_id`, which is what
makes S1 and S11 reachable in practice; that is a production count and was not taken. (c) Whether any
scheduler exists outside the repository — a database cron, a server crontab, an external pinger. Every
AUTOMATED=NO in this document is a claim about `vercel.json`, `.github/workflows/` and `db/*.sql`, all three
of which were read.

---

## Orphaned and unreachable surfaces

### Structurally unreachable for an employee

Four pages open with `if (user.role !== 'applicant') return Astro.redirect('/admin')`, and
`src/middleware.ts:414-417` sends an account without `admin.access` from `/admin` straight back to `/portal`.
For any employee these are a bounce, not a page: `/portal/visvambhara:12`, `/portal/requests/index.astro:7`,
`/portal/wallet.astro:11`, `/portal/profile/edit.astro:7`. `src/lib/workforce/navigation.ts:1030`
(NAV_BACKLOG `visvambhara.loop`, `profile.edit`) records this deliberately rather than handing people a loop
— but `/portal/profile.astro:102` links to `profile/edit` as its hero call to action anyway.

### No inbound link anywhere in the source

| Route | Only reference |
| --- | --- |
| /portal/employee/benefits | `src/lib/ask/employee.ts:488` and `src/lib/assistant/answer.ts:134` — reachable only by asking the assistant a question matching `/benefit\|insurance\|gratuity/i` |
| /portal/employee/credits/approvals | A notification URL at `src/lib/workflow.ts:1064`; the approver's queue is reachable only by clicking the notification before it scrolls away |
| /portal/enroll-face | No UI link at all; only an error string at `admin/users.astro:190` and a hardcoded line in a chat prompt (`api/ai/chat.ts:29,39`) |
| /founder/admin/wellness | Only its own header comment; `grep -rn 'founder/admin/wellness' src/` returns one hit |
| /portal/my-record-access | One inbound link in the whole product: `src/pages/portal/workspace.astro:1104` |

### Nav coverage

The employee bar is server-composed: `navigation.ts:145` NAV_DESTINATIONS projected by `buildWorkspaceNav`
(`:1147`) into 4 slots where the last is always the More drawer (`BAR_CAPACITY=4`, `:1057`), so only three
ranked entries reach the thumb bar. 23 of the 38 `/portal/employee/*` pages have a nav entry; 15 do not, of
which 13 are reachable 2-3 clicks deep through in-page tabs (attendance/{clock-out,corrections,roster},
credits, evidence, internship, schedule + schedule/approvals, reports + reports/team, projects/[id], mail,
onboarding) and 2 are the true orphans above. The 12 learner surfaces (achievements, crm, doubts, feed,
flashcards, groups, hackathons, jobs, library, notes, parent, resume-builder) are linked only from the footer
of `/portal/index.astro:1064-1148`, and `/portal/index.astro:74` redirects every employee away before that
footer renders — invisible to employees by construction. `/portal/search` is drawer-only by design
(`navigation.ts:466`) and its audience is `worksHere` (`:469`), so an applicant gets no search box at all.

### One feature at two paths

| Pair | Why it is a duplicate | What differs |
| --- | --- | --- |
| /portal/security vs /portal/employee/security | Same engine, same tables | The non-staff copy cannot require a second step and cannot obtain recovery codes, so a lost phone there is an unresolvable lockout |
| /portal/onboarding vs /portal/employee/onboarding | Two steps of one journey; the employee page embeds the other's progress numbers and links to it twice under two labels | Credentials vs joining details |
| /founder/admin/wellness vs /admin/wellness | Identical `programmeHealth()` output, duplicated k-anonymity logic | Gate only; the unreachable copy will drift first |
| /portal/mail vs /portal/employee/mail | The archive is a second mailbox grown because the real one had no UI mount | `portal_mail_*` vs `mail_box`/`mail_messages` |
| /portal/enroll-face vs /portal/face-setup | Third door into `user_face_enrollments` | The orphan writes no `identity_verifications` row where its API twin writes one on both accept and refuse |
| /portal/employee/timesheet vs the attendance week view | Renders the same week | The timesheet approval has no consumer |
| /portal/worklog vs /portal/workspace hour log | Both capture hours | One writes `offline_work` (no processor), one writes `hr_time_logs` (read only by an admin grid) |

**Explicitly NOT a duplicate:** `/portal/wallet` and `/portal/employee/wallet` share no table
(`account_credit_ledger` vs `hr_wallet_txn`), no unit, no audience and no gate. Merging them would put a
learner's top-up credit and an employee's net pay in one balance with no exchange rate anywhere in the
codebase — the defect `hr-wallet.ts:166-188` documents having already fixed once. The route *name* should
change, not the data.

### Ambiguous audience

`/portal/achievements` sits in the staff portal and is fed entirely by learner routes — every `awardXp()`
caller is an `/api/aquintutor/*` handler or `/api/tests/submit.ts`, so a staff member who completes every
assigned course reads 0 XP, Level 1, no badges, under a footer explaining that XP comes from answering
classmates' doubts. `/portal/feed` is a learner reel with an AR pipeline living at a `/portal` URL.
`/portal/wellbeing` and `/portal/wellness` share a word and have opposite security postures;
`navigation.ts:479-500` already renamed the former "Focus and wellbeing" to stop that collision, and the same
care has not been taken between `/portal/wellness` (employee, women-only, gated on `hr_employees`) and
`/aquintutor/campus/wellness` (learner, fully public intake).

---

## Transformation verdicts

| Verdict | Count |
| --- | ---: |
| REFACTOR | 36 |
| RETAIN | 25 |
| MERGE | 5 |
| REBUILD | 3 |
| REMOVE | 3 |
| REPLACE | 1 |
| MIGRATE | 1 |
| DEPRECATE | 1 |
| **Total** | **75** |

### RETAIN (25) — correct as built; extend, do not rewrite

| Route | Reason |
| --- | --- |
| /portal/employee/attendance | Writes a record payroll actually consumes and re-checks every rule at the write |
| /portal/employee/attendance/corrections | The page cannot approve anything itself; approvals land in the row payroll reads |
| /portal/employee/schedule | The outstanding-hours derivation is real cross-domain inference, enforced at the write |
| /portal/employee/calendar | Read-only aggregation that owns no data and degrades honestly |
| /portal/employee/loans | The only chain in its group that closes: request, approve, disburse, deduct, stop at zero |
| /portal/employee/expenses | Moves real money, authorization correct at every entry point, advance netting is genuine |
| /portal/employee/credits | Built on a measurement rather than a status column |
| /portal/employee/contract | Read-only by design, gated before the first query, states unflattering truths |
| /portal/employee/evidence | The one page whose promise the backend fully keeps, mentor loop included |
| /portal/face-data | Deletes rather than deactivates and refuses to claim success it cannot confirm |
| /portal/employee/profile | Real writes, session-only scoping, per-field audit that excludes values |
| /portal/employee/security | Native forms, rate-limited disable, codes rendered in the same response |
| /portal/employee/knowledge | Authorization in the WHERE clause of every read; escape-first markdown renderer |
| /portal/employee/internship | Three hour columns never collapsed into one number |
| /portal/employee/reports/team | Scope from the org graph per relationship; no roster parameter exists |
| /portal/team | Best-scoped page in the product; deliberately excludes gender, salary and wellness |
| /portal/organization | No role-name fallback anywhere; person rows select five columns and no more |
| /portal/employee/mail | The mailbox that should exist, with the gate composed once and reused by the endpoints |
| /portal/wellness | The reference implementation: server-side gate, owner-scoped WHERE, stated confidence |
| /portal/wellness/consultant | Membership re-read per request, content-free queue, failed read never shown as empty |
| /admin/wellness | Aggregate-only, k-anonymity enforced in three independent places |
| /portal/employee | The reference implementation for authorization: one decider above the boundary |
| /portal/search | Scope in the query, no post-filtering, honest unavailability |
| /portal/logout | GET made safe without breaking existing call sites; partial failure surfaced |
| /portal/sign-out | Names who is signed in, which is the actual failure mode |

### REFACTOR (36) — sound structure, named local defects

Attendance: `/portal/employee/attendance/approvals` (unscoped settlement sweep, no focus ring, no nav),
`/portal/employee/attendance/clock-out` (promises a reviewer that does not exist),
`/portal/employee/attendance/overtime` (half the feature is a promise),
`/portal/employee/attendance/roster` (five mutating actions and a hard DELETE with no audit),
`/portal/employee/schedule/approvals` (fix `escalateStep`).
Leave: `/portal/employee/leave` (add audit, emit the declared event, add a sweep),
`/portal/approvals` (pass `onError` to all three readers; surface the orphaned workflow instance).
Money: `/portal/employee/payslips` (one line in a dependency), `/portal/employee/wallet` (scope the payee,
audit the bank change, condition the release copy), `/portal/employee/credits/approvals` (gate escalate),
`/portal/wallet` (label, live region, non-JS path, real refund or drop the word).
Records: `/portal/employee/benefits` (schedule the reconcile; key the elect form on state not existence),
`/portal/employee/documents` (person picker; a destination for the retention flag),
`/portal/employee/assets` (notify the desk; separate unreadable from absent).
Identity: `/portal/face-setup` (make Skip skip; give ID review an operator queue),
`/portal/employee/onboarding` (use `requireEmployee`; notify the desk; nudge overdue steps),
`/portal/profile` (three links point elsewhere than they say),
`/portal/my-record-access` (read `audit_log` too; link it from four pages).
Growth: `/portal/employee/performance` (route six writers through `getGoalFor`),
`/portal/employee/learning` (focus ring, 16px inputs, audit the signup),
`/portal/employee/referrals` (refresh the reward state on read; notify on submit; PRG).
Work: `/portal/employee/projects` (h1, main, the overdue nudge),
`/portal/employee/projects/[id]` (gate assign-task; a portal route to attach spend),
`/portal/employee/reports` (aria-live, main, the outstanding sweep),
`/portal/employee/procurement` (the sweep it advertises; a Discard confirmation that matches the handler),
`/portal/workspace` (audit the hour log; restore focus-visible).
Comms: `/portal/team-groups` (login redirect points at another product; audit the invite link),
`/portal/employee/support` (build issuance or stop routing asset requests),
`/portal/messages` (keyboard-operable switches; key-loss warning; audit `wrap_keys`),
`/portal/notifications` (order by priority; acknowledge distinct from read; wire or drop three columns).
Health: `/portal/wellbeing` (real buttons, tied labels, dialog semantics, three corrected sentences),
`/portal/wellness/consult` (notify the pool; read the withdrawal result),
`/admin/wellness/consultants` (audit the appointment; refuse self-appointment; notify the appointee).
Shell: `/portal` (split router from applicant dashboard; move the GET-render UPDATE),
`/portal/login` (read `next` through `safeNextPath`; tie labels; role=alert),
`/portal/signup` (close enumeration; add address verification).

### MERGE (5)

| Route | Merge into | Reason |
| --- | --- | --- |
| /portal/employee/timesheet | The attendance week view | Renders the same week; its approval has no consumer |
| /portal/security | /portal/employee/security | One feature at two paths where the non-staff copy has no recovery codes |
| /portal/onboarding | /portal/employee/onboarding | Step two of one journey, already embedded and double-linked |
| /portal/worklog | The workspace hour log | Or make the offline queue drain into `hr_time_logs` |
| /founder/admin/wellness | /admin/wellness | Same output, duplicated suppression policy, zero inbound links |

### REBUILD (3)

`/portal/employee/delegation` — the time box is not persisted where it is enforced, the scope list is
enforced by dead code, and ending a delegation is an unauthorised write against the whole org graph.
`/aquintutor/campus/wellness` — two unauthenticated mental-health forms inside a hardcoded brochure whose
three service promises have no backend.
`/portal/feed` — a privacy control that is collected and ignored has to be enforced or removed before
anything else ships there.

### REPLACE (1)

`/portal/forgot` — the function it performs, confirming an address exists and disclosing what it applied to,
should not exist. Replace with a constant-response flow and fold in the working reset at `/forgot-password`.

### REMOVE (3)

`/portal/enroll-face` — a third unlinked door into the most security-critical table in the product; redirect
it to `/portal/face-setup`. `/portal/activate` — its one side effect duplicates `middleware.ts:408` and its
failure mode is a silent mislead. `/portal/mail` — patch the read and the `set:html` today regardless of the
migration timetable, then remove once `portal_mail_*` is migrated.

### MIGRATE (1)

`/portal/achievements` — sound engineering pointed at another product's ledger. Move it to the learner
product, or feed it from employee course completions.

### DEPRECATE (1)

`/portal/totp-setup` — already correctly a 302. Keep it indefinitely so links in old messages resolve. Its
history is the pattern this audit was hunting: a write to a table no sign-in path read, under an
unconditional success message.
---

## What this means for the build order

**The weakest axis is AUDITED, and it is weak for one reason in one file.** Zero pages out of 75 score YES,
and that is not 75 independent omissions. `src/lib/audit.ts:63-66` wraps its INSERT in a try/catch ending
`console.error('Audit log failed:', err)` and returns normally, so no caller can ever learn that the audit row
did not land. Thirty-five pages write an audit record on the success path and are held at PARTIAL solely by
that swallow. Changing `logAudit` to return a discriminated result — and giving it a durable failure channel,
even a counter row — moves the ceiling for all thirty-five at once: every attendance approval, every workflow
decision (`workflow.ts:2159`), clock-out (`attendance-verify-clockout.ts:902`), leave decisions
(`hr-leave.ts:1701`), expenses, loans, credits, benefits, documents, assets, evidence, procurement, projects,
daily reports, helpdesk and profile. It also un-deadens code that already exists and cannot run: the "it could
not be written to the audit log" warning branches at `hr-leave.ts:1704-1712` and `delegation.ts:270-276` are
unreachable today precisely because the function they guard never rejects. This is the single highest-count
fix in the document, it touches one file, and it makes twelve other findings observable rather than
theoretical.

**But it is not the first thing to do, because two findings are exploitable now.** S1
(`/portal/employee/onboarding:17`) is unauthenticated-identity write access to another person's payroll bank
account, reachable by signing up with their address; S2 (`/portal/mail:252-259`) is an unauthenticated read of
another person's mail bodies that mints its own precondition through the state-write handlers. Neither needs a
design decision. S2 is a `JOIN portal_mail_thread_state s ON s.thread_id = t.id AND s.user_id = ${user.id}`
plus an ownership check before the three `INSERT INTO portal_mail_thread_state` branches, plus stripping the
`set:html`. S1 is a one-line substitution described below. Do those two before anything on this list, and do
S7 (`gamification.ts:245`, drop the `u.email` arm of the COALESCE) at the same time because it is one token
and it is publishing addresses today.

**The second-highest-leverage shared fix is a single identity resolver.** Seven pages hand-roll
`WHERE (work_email = $e OR personal_email = $e OR email = $e) ... LIMIT 1` with no `ORDER BY` and no
ambiguity guard, against columns `db/hr-schema.sql:50-51` declares without a unique constraint. The correct
version already exists and is already used by nine other pages:
`src/lib/auth/workspace-access.ts:281-285` selects `LIMIT 2` and `:432-435` refuses rather than guessing,
with a comment naming the harm. Replacing the seven hand-rolled lookups with `requireEmployee()` closes S1
outright and downgrades S11 across `/portal/employee/benefits`, `/portal/employee/documents` (where the
mis-resolved id feeds `mayEdit`, i.e. write authority over another person's drafts),
`/portal/employee/assets`, `/portal/employee/payslips`, `/portal/employee/wallet` (which currently makes the
guess permanent with an UPDATE), `/portal/employee/loans` and `api/portal/expenses/submit.ts`. Seven pages,
one import, and it also fixes the `/portal/employee/payslips` "Open" button that 403s on a payslip the same
person is looking at, because `hr-payslip.ts:71-76` resolves by `user_id` only while the list resolves by
email fallback.

**The third shared fix is one line in the workflow engine and it closes an entire class.**
`escalateStep()` (`workflow.ts:2748-2790`) documents that it performs no entitlement check and that callers
must bring one; the four admin callers are gated and the two portal callers are not, so any active employee
can escalate any pending step in any of the twenty workflow domains onto a senior person's queue and push
them a notification naming the subject. Putting `mayAct()` inside `escalateStep` fixes
`/portal/employee/credits/approvals`, `/portal/employee/schedule/approvals` and hardens the four admin
surfaces in the same change. While that file is open, the same pass should close S13's blast radius by
passing `employeeId` instead of `null` at `attendance/approvals.astro:86` — the scoped form is used correctly
on the sibling page.

**AUTOMATED is the axis with the most systemic room, and the fix is a dispatcher, not sixty crons.** Sixty
pages score NO and only four YES. What exists today is a large set of correct, idempotent, self-scoped
reconcilers that fire only when the right human opens the right page:
`applyApprovedCorrections`/`applyApprovedOvertimeClaims` (attendance), `syncScheduleDecisions`,
`syncCreditDecisions`/`reconcileCreditWeeks`/`routePendingCreditWeeks`, `syncLoanApprovals`,
`syncEnrolmentApprovals` (benefits, one caller and it is an admin page render),
`syncContractChanges` (contracts, same), `refreshRewardState` (referrals, same),
`linkReferralsToApplications`, `applyApprovedClaims` retry (expenses), `stepsAwaitingEscalation` (a read that
escalates nothing). One scheduled route that walks that list nightly would lift AUTOMATED on roughly twenty
pages and, more importantly, would remove the class of bug where a person is push-notified that their
election, contract change or reward was approved while their own page still says "waiting" — because
`settleDomainRecord` (`workflow.ts:2867-2900`) writes back to exactly two domains and returns early for the
other eighteen. Either extend `settleDomainRecord` per domain or run the reconcilers on a schedule; do not
leave the current arrangement, where the person with the least reason to open a screen is the person whose
record goes unprocessed.

**ACCESSIBLE is the axis where the split is by author, not by difficulty.** 49 PARTIAL, 19 YES, 4 NO. The
workforce-set pages are genuinely good — `/portal/employee`, `/portal/search`, `/portal/employee/evidence`,
`/portal/wellness` and the attendance family have `for=`-tied labels, landmarks, `aria-current`,
`:focus-visible` restored after `outline:none`, and forced-colors handling. The auth pages and several
standalone pages are not: `/portal/login:416,443,447`, `/portal/signup` and `/portal/forgot` all use bare
styled `<label>` elements with sibling inputs and no `for=`, so on the two forms every employee must pass
through, no label is tied to any field. Five pages in the records group emit their own `<!doctype html>` with
no `<main>` and no `<h1>` at all. The lift here is not a framework: it is (a) a shared form-field partial
that emits `label[for]` + `input[id]`, (b) using `BaseLayout` (which already provides the skip link and
`<main id="main">` at `:168-170`) on the eleven pages that hand-roll their own document, and (c) a single
`:focus-visible` rule in `workforce.css` so that eight pages stop suppressing focus with nothing in its
place. That is three changes covering roughly thirty PARTIALs.

**INTELLIGENT at 9.3% YES is the honest number and should not be chased.** Seven pages earn it and the
reasons are instructive: `/portal/employee/schedule` intersects approved leave with the approved plan per
date; `/portal/employee/credits` prorates a weekly requirement by excused days and keeps "not measurable"
as a third state; `/portal/employee/evidence` composes claimed / verified / recognised against a per-person
ceiling; `/portal/wellness` derives a cycle prediction from the person's own gaps with a stated confidence;
`/portal/employee/expenses` nets an advance against the claim that follows it and closed a defect that was
paying twice; `/portal/employee/internship` sums `min(verified, that week's ceiling)` per week. Every one of
those is arithmetic over the user's own rows that produces a fact existing nowhere in the database. Nothing
in the remaining 68 pages needs a model; several of them need the derived sentence the seven already prove is
buildable — "N days remain after your pending request", "this asset is 94 days overdue", "your reward has
been approved and is waiting on payroll". Treat INTELLIGENT as the last axis, after AUDITED and AUTOMATED,
because a derived insight over an unreconciled record is worse than no insight.

**Sequence.** (1) S1, S2, S7 — hours, no design decisions. (2) `mayAct()` inside `escalateStep`, and the
scoped `applyApprovedOvertimeClaims` call — one file each. (3) `requireEmployee()` across the seven
hand-rolled lookups, which also fixes the payslip 403. (4) `logAudit` returns a result and fails loudly —
one file, thirty-five pages move. (5) The reconcile dispatcher, or `settleDomainRecord` per domain — this is
the one that stops the product telling people something was approved while their own screen says otherwise.
(6) The three accessibility changes. (7) Then, and only then, the dead-end cleanup in Tier 1 order: either
teach payroll to read `overtime_hours` or remove the pay option; either build the clock-out review queue or
stop saying a person will look; either enforce feed visibility or remove the control; either notify the
consultant pool or stop promising a reader. Every one of those is a choice between building the second half
and deleting the promise, and both are acceptable answers — leaving the sentence up is not.

---

## Unverified

This was a source-only audit. The following could not be established and would need someone with access to
close.

**Runtime configuration.** No `.env*` file was read, by rule. So: whether the payout gateway credentials are
present in production (which decides whether S3's "Mark paid" pays a bank or nobody), whether `CRON_SECRET`
matches between the deploy platform and the repository secret, and whether any declared cron is actually
firing. `src/lib/auth/cron-auth.ts:67-68` trims the secret, so the known whitespace trap is neutralised in
code — that is a statement about the code, not about the deployment. `vercel.json` declares sixteen to
seventeen cron entries, which is worth one `vercel inspect <url> --logs` before anything new is scheduled,
because every AUTOMATED=YES in this document rests on two of those entries.

**Production data shape.** How many `hr_employees` rows carry a null `user_id`, and whether any two rows
share an email address, is what turns S1 and S11 from a missing guard into an active exposure.
`src/lib/auth/workspace-access.ts:288-299` documents the collision as a real state in this data; the count
was not taken and should be, by the user, with a single query they run themselves.

**Anything outside the repository.** A database-level scheduler, a server crontab, an external uptime pinger
or a queue consumer running elsewhere would falsify the AUTOMATED findings. Three sources were read to rule
it out inside the tree — `vercel.json`, `.github/workflows/` (only `ci.yml`, `imap-poll.yml`,
`task-reminders.yml`) and `db/*.sql` (the only `CREATE TRIGGER` anywhere is an `updated_at` touch at
`db/mail-platform-schema.sql:908`) — and that is the limit of what source can prove.

**MOBILE and ACCESSIBLE, both columns, all 75 rows.** Scored from CSS rules, media queries, touch-target
minimums and markup. Not one page was loaded on a handset and no screen reader was run. Specifically
unverified: whether the 44px minimums survive at 320px on the pages with wide tables; whether the
`overflow-x: auto` containers actually contain their content rather than pushing the body; whether the
`role="switch"` divs on `/portal/messages:1073,1077` and `/portal/wellbeing:181-184` are as inoperable in
practice as the markup implies; and whether the `1px` border-colour focus indicator on
`/portal/employee/learning:396` meets contrast in either theme. A single pass with a keyboard and a screen
reader on the ten highest-traffic pages would settle more of this than any further reading.

**Exploitability versus reachability.** S3 (`escalateStep`) and S5 (goal writers) require the attacker to
hold a UUID they were not shown. The check is absent either way and both are reported as findings, but the
practical blast radius depends on how ids leak — through a manager's own queue, a notification payload, a
shared link — and that was not traced. S10 (assign-task) needs no id the attacker does not already have,
which is why it is ranked above them despite being write-only pollution.

**Two claims deliberately left as judgement, not fact.** `/portal/employee/assets` FUNCTIONAL is scored YES
on mechanism (the two writes and the event row all land) while its success copy says "The desk can see it"
and no notification is sent; under a strict copy-versus-behaviour reading it is PARTIAL. And
`/portal/employee/internship` INTELLIGENT=YES rests on the recognised-hours derivation, not on the if-chain
that produces the note sentences; a stricter reader could call it PARTIAL. Both are flagged here rather than
silently resolved.
