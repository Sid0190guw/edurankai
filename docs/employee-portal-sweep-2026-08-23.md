# The employee portal, swept for dead ends — 2026-08-23

*What this was.* A joiner wrote in to say she could not find anywhere to mark her attendance. She
was right about the symptom and the cause was already fixed by then (commit `3b43fd5`, 15:19 that
day, four hours after her screenshot) — but "the reported thing is fixed" is not the same answer as
"the portal works". So every surface under `/portal/employee`, plus the two `/portal` pages an
employee actually lands on, was read end to end: forty-three routes and the shared spine behind
them, in eight parallel lanes, each finding then checked by a second reader whose instruction was to
refute it.

**Fifty defects were found. Forty-nine were verified; forty-eight of those survived. One was
dropped by a per-lane cap of eight and has not been through the second reader — it is #9 below, and
it is marked.**

Every finding here has a symptom somebody sees on a screen. Nothing in this document is a style
note, a naming preference or a refactor.

## The three that were not defects of degree

**A table that does not exist.** `/portal` counted upcoming interviews with `FROM interviews`. There
is no such relation anywhere in this repository, and that string appeared in exactly one place; the
table is `interview_rounds` everywhere else. All four badge counts are subqueries of one statement,
so Postgres rejected the whole statement every time and every badge on the quick-access tiles read
zero — "nothing is waiting for you", including an interview tomorrow. Not intermittent. Every open,
every person, since it was written.

**A column that does not exist.** `/portal/profile` asked for `tc.created_at` on
`training_certificates`, which has `issued_at` and never had the other. The page printed "Your
certificates could not be loaded just now" to everybody, forever. It was visible in the joiner's
screenshot, four cards below the thing she wrote in about.

**A day that gets erased.** `punch()` inserts the clock event, then recomputes the whole day with
`computeDay(await punchesOn(...))` and upserts the result over `hr_attendance.clock_in`,
`clock_out` and `work_hours`. `punchesOn()` returns `[]` on a failed read as well as on an empty
day, so a transient failure in the window between the insert and the recompute overwrote a full
day's hours with zero — and returned `ok: true` with zero totals to somebody who had just worked
eight hours. The punch survives in `hr_clock_events`, so the log looked right; the row payroll reads
did not.

## And one that is not in the code at all

`hr_daily_report_revisions` is INSERTed into as the first statement inside the clock-out
transaction. No `db/*.sql` file creates it. Its only creator is an `ensureOnce()` bootstrap, and
`src/lib/ensure-once.ts` makes every such bootstrap a resolved promise in production by default —
correctly, for the connection-pressure reason written in its header.

The safety argument for that default is "every caller already tolerates a missing table, so the
failure mode is a feature with no rows". This is where that stops being true: a missing table there
does not degrade the daily report, it aborts the transaction, and **the clock-out fails**. The parent
table `hr_daily_reports` *is* in `db/hr-schema.sql`, which is exactly why nobody noticed the trail
table was not.

`db/attendance-clockout-tables.sql` creates it, along with `hr_clock_out_checks` and
`training_certificates`, and all three are now in `BOOTSTRAP_MODULES` so `/api/health` reports on
them instead of staying silent. **That file has to be run by hand against production.**

### Two corrections to the paragraph above, from re-reading it

**It is not only three tables — it is also sixteen columns.** The same two statements name
`qr_station_id`, `qr_code_raw`, `source`, `face_verified`, `face_verify_method`,
`face_verify_outcome` and `face_verified_at` on `hr_clock_events`, and nine more on
`hr_daily_reports` (`report_url`, `sharing_ack`, `revision_count`, `last_revised_at`,
`submitted_by_user_id`, `work_source`, `form_response_url`, `form_service`,
`filed_at_clock_out`). None of the sixteen is declared in any `db/*.sql`. So on a database built
from `db/` alone, **clock-IN fails too** — the first draft of this document said it was unaffected,
and that was wrong. `BOOTSTRAP_MODULES` tests for tables, not columns, so it cannot see any of them;
running the SQL file is what covers it.

**And this is probably not broken on the live database today.** The production kill switch in
`ensure-once.ts` landed 2026-08-23 at 14:48 (`effb474b`); the revisions DDL landed 2026-08-06
(`d7d43f3f`). For the seventeen days between, the bootstrap ran freely on the request path, so the
live database has most likely had all of this created already. What changed is that it will never
happen again — and `ensureOnce` swallows a failed DDL run, so "it had seventeen days" is not
evidence that it worked. The file is what makes a restored, rebuilt or newly provisioned database
correct; on one where the bootstrap already ran, it is a no-op.

A parent table that exists while the columns written to it do not is the shape that hid all of
this: every "does the table exist" check passed.

## The pattern underneath most of the rest

Thirty-four of the fifty are one shape: a read fails, the helper catches it and returns `[]` or
`null`, and the page renders the empty case as a **statement about the person**. "You have no
contracts." "Nothing is issued to you." "You have completed nothing." "There is no employee record
on this account." Each of those is a claim the code has no evidence for, printed over a query that
did not run.

This codebase already knows the answer and applies it in several places — `readAssets()`,
`readLeave()`, `readHolidays()` and `payslipsForEmployeeResult()` all return `{ ok, rows, error }`
for precisely this reason. The defects are the callers that use the older, lossier helper beside
them.


## Fixed in this pass

### 1. Two leftover header children are passed to EmployeeShell's default slot, so they render as unstyled content at the top of the page body.

`src/pages/portal/employee/profile.astro:209` — other

**What a person saw.** At the top of /portal/employee/profile, immediately under the dark bar and outside every card, a bare line of text "My profile" and a bare link "Purchases" appear flush against the left edge of the screen — duplicating the bar's own title and its own trailing "Purchases" link.

### 12. Leftover markup from the EmployeeShell header migration sits in the shell's default slot, so two stray elements render as bare text at the top of the page body.

`src/pages/portal/employee/procurement.astro:223` — other

**What a person saw.** Every visit to Purchases shows an unstyled line reading "Purchases Profile" (a bare word plus a blue-underlined default-styled link) directly under the dark top bar, flush to the left viewport edge outside the 640px content column, duplicating the page title and the Profile link the bar already shows.

### 23. /portal/employee/horizon is a fully built, requireEmployee-gated screen with zero inbound links anywhere in the repository — no nav entry, no widget href, no link from any page.

`src/pages/portal/employee/horizon.astro:32` — unreachable-route

**What a person saw.** An employee can never open "Your own time record". The page renders correctly if the URL is typed by hand, but nothing in the bottom bar, the More drawer, the workspace home, or any other portal page leads to it, so in practice the screen does not exist for the person it was written for.

### 24. /portal/employee/fusion — the employee's own intelligence profile — is linked only from two admin console pages, so the subject of the record has no door to it.

`src/pages/portal/employee/fusion.astro:55` — unreachable-route

**What a person saw.** An ordinary employee cannot reach the page that shows what the fusion engine says about them, or the form that lets them file a disagreeing note. Only somebody who can open /admin/hr/fusion (admin.access + the section grant) sees a link to it — and that link is the sentence telling HR that the employee can read it. The page's own header says "A record about you that you cannot read is a record you cannot answer", which is exactly the state it is in.

### 25. The quick-access badge query on /portal reads a table named `interviews`, which is created nowhere in the repository (db/*.sql, src/lib/db/schema.ts, any ensure*() in src/lib, or any .dev-scripts migration); the real table is `interview_rounds`.

`src/pages/portal/index.astro:331` — missing-table

**What a person saw.** All four quick-access tiles on the portal home page — Interviews, Submissions, Appeals, Credentials — permanently show no count. The four counts are subqueries in one statement, so the missing relation makes the whole statement throw (42P01) and every badge falls back to 0. An applicant with an interview scheduled tomorrow, an appeal under review and a certificate issued sees the same blank tiles as someone with nothing waiting. /portal is also where navigation.ts sends Home for anyone with no employee record, so this is the first screen those people land on.

### 30. Leftover pre-EmployeeShell header markup sits in the component's default slot and renders as stray content above the page.

`src/pages/portal/employee/projects.astro:106` — other

**What a person saw.** On /portal/employee/projects the word "Projects" and a second, unstyled blue underlined "Profile" link appear flush against the left edge of the screen directly under the dark top bar, outside the padded column, duplicating the bar's own title and trailing link.

### 31. The same leftover header markup renders stray text and a link labelled "My HR" above the project detail page.

`src/pages/portal/employee/projects/[id].astro:296` — other

**What a person saw.** On /portal/employee/projects/<id> the word "Project" and an unstyled blue underlined link reading "My HR" appear at the top-left of the page under the bar. "My HR" is a second name for the workspace that the shell deliberately retired (its back control says "Workspace"), so the product appears to have two different places called home on one screen.

### 34. The loan request POST never passes the employee's currency to requestLoan(), so every loan and salary advance is written to hr_salary_loans as INR regardless of what the employee is actually paid in.

`src/pages/portal/employee/loans.astro:102` — other

**What a person saw.** An employee whose hr_employees.currency is USD (the admin form offers USD/GBP/EUR/SGD/AED/CAD/AUD) raises a salary advance and then sees one screen contradict itself: the "Still to repay" tile reads "USD 5,000.00" (built from employee.currency at line 174) while the loan line immediately below it reads "INR 5,000.00 still to repay" and "INR 416.67 each pay run" (built from loan.currency). Worse, the deduction the page promises never appears on any payslip: payroll.ts:1505-1517 compares the loan's currency to the payslip's, finds INR vs USD, and skips the recovery entirely — so the register keeps saying money is being deducted while nothing ever is.

### 39. When readHorizonsFor() refuses access it returns set:null, and horizon.astro has no branch for that — every panel is conditional on `reading`/`cycles`, so the page renders the lede and the seven tabs and nothing else, with no error and no reason.

`src/pages/portal/employee/horizon.astro:62` — silent-blank

**What a person saw.** An employee opens Time record, sees the intro paragraph and the Week/Month/Quarter/Year tabs, and the rest of the page is blank. Clicking every tab changes nothing. There is no error, no "we could not read this", no "you do not have access" — it is indistinguishable from a feature that was never finished. This happens whenever hr_employees.user_id does not point at the signed-in account (e.g. the row was matched by email but the user_id backfill failed, or the row already carries someone else's user_id), or on any transient failure of the readEmployeeIdForUser query.

### 41. /portal/employee/horizon and /portal/employee/fusion have no nav entry and are not linked from any employee-facing page; only the two admin fusion consoles mention the fusion URL, as prose.

`src/lib/workforce/navigation.ts:721` — unreachable-route

**What a person saw.** Two finished employee surfaces — "Time record" and "What the system says about your work" — cannot be reached by any employee. Nothing in the portal bar, the drawer, or any other portal page links to them, so an employee can only see them by being told the URL and typing it. Feedback and Your record (intelligence) both have entries in the same list; these two were left out, and they are not in NAV_BACKLOG either, so nothing records the omission.

### 42. requireEmployee() denials that carry no redirect (lookup-failed, ambiguous-record, no-employee-record, inactive) are all collapsed to employeeId = '', and the page prints one hardcoded sentence claiming the account is not linked to an employee record; gate.title and gate.reason are discarded.

`src/pages/portal/employee/horizon.astro:104` — swallowed-error

**What a person saw.** A person whose employee record is closed, or whose email matches two hr_employees rows, or whose record simply could not be read during a database blip, is told "Your account is not linked to an employee record yet, so there is nothing to read from. The people desk holds that link." That is a false statement about them — they are on the register — and it sends them to HR to be added to something they are already on. The real reason ("More than one employee record uses your email address", "Your employee record is closed", "We could not load your record just now") is available on the gate and thrown away.

### 43. The page prints a hardcoded "this account does not have an employee record" claim whenever viewer.employeeId is null, including the case resolvePerfViewer explicitly flags as a failed read and supplies an honest sentence for in viewer.explanation.

`src/pages/portal/employee/feedback.astro:281` — swallowed-error

**What a person saw.** When the hr_employees lookup fails (a pooler timeout, a slow query), an employee who has a record opens Feedback and is told "There is no employee record on this account. Feedback is attached to an employee record and this account does not have one. The people desk creates the record; nothing on this page can create it for you." All four tabs are then empty. They go to HR to be created as an employee they already are. performance-scope.ts was changed specifically to stop pages saying this on a failed read, and this page reintroduces the sentence.

### 45. The clock-out write path's first statement targets hr_daily_report_revisions, a table that no db/*.sql file creates and whose only creator is an ensureOnce() bootstrap that is a no-op in production by default.

`src/lib/attendance-verify-clockout.ts:820` — missing-table

**What a person saw.** On any production database where that bootstrap has not run, pressing "Submit and clock out" always comes back with "Your work record could not be saved, so you have NOT been clocked out." The person is stranded clocked in with no other route out: the attendance page no longer renders a clock-out button (it is a link to this screen), /api/portal/attendance/punch refuses kind=clock_out with a 409, and the "I cannot complete the identity check" escape hatch does not help because this failure happens at step 5, before the punch is attempted. Clock-IN still works, because hr_clock_events is declared in db/hr-schema.sql — so a joiner can start a day and can never close it.

### 46. The "Claim them" link beside today's overtime note carries no ?date, and the overtime page defaults to yesterday.

`src/pages/portal/employee/attendance/index.astro:515` — nav-mismatch

**What a person saw.** An employee finishes their day, the attendance page says "Your punches show 1h 20m over the rostered shift today ... Claim them", and tapping it opens a screen headed with YESTERDAY's date. If yesterday had no overtime they get the flat contradiction "Your punches for this day show nothing over the rostered shift, so there is nothing to claim" and no claim form at all; if yesterday did have overtime, the claim form is pre-filled with the wrong day and the wrong hours and files a claim for a day they were not told about.

### 48. weeklyTimesheet() swallows a failed hr_attendance read and returns a fully-formed Timesheet whose days are all empty, with no flag telling the caller the read failed.

`src/lib/attendance.ts:1427` — swallowed-error

**What a person saw.** When the hr_attendance SELECT fails — a pooler timeout, or the a.break_minutes / a.source columns being absent because the schema bootstrap is off — the "This week" card on /portal/employee/attendance renders "0 hours recorded", "45 hours expected", "-45.0 difference", and every row of the table reads "Nothing recorded" with blank In and Out. An employee who clocked in every day is shown a week in which they did not work, and nothing on the screen says a read failed. This is the same shape as the "No certificates yet" defect already fixed on /portal/profile: a swallowed read rendering a definite claim about the person.

### 49. punch() recomputes the whole day from punchesOn(), which fails closed to an empty array, and then unconditionally overwrites hr_attendance.clock_in / clock_out / work_hours from that recomputation.

`src/lib/attendance.ts:1289` — swallowed-error

**What a person saw.** If the punch INSERT succeeds but the re-read that follows it fails (the read is wrapped in its own catch that returns []), the day is written back as clock_in NULL, clock_out NULL, 0 work_hours — and the punch still reports success, so the person sees "Start break recorded." while today's row in "This week" loses its In and Out times and drops to 0 worked. The raw punches are still listed under "Today's punches" directly above, so the same screen shows the punches and denies the hours. punchesOn() cannot distinguish "no punches today" from "the read failed", and this caller treats the two identically for a destructive overwrite.


## Found and NOT yet fixed

### 2. requireEmployee()'s refusal is discarded unless it carries a redirect, so a denied person gets the full internship page with every figure reading "Could not be read" and no reason anywhere.

`src/pages/portal/employee/internship/index.astro:115` — gate-without-reason

**What a person sees.** An employee whose account has no linked employee record (or whose record is closed, or matches two rows) opens /portal/employee/internship and sees Completion "Could not be read", all six tiles "Could not be read", and "Your record could not be read just now". They are never told the real cause or that HR fixes it — the sentence requireEmployee already wrote for them is thrown away.

**Suggested fix.** Only 'not-signed-in' sets `redirect` in workspace-access.ts:466; 'no-employee-record', 'inactive', 'ambiguous-record' and 'lookup-failed' all return redirect:null with a `title` and `reason`. Render `gate.title` / `gate.reason` in a card and stop before the figures, the way /portal/employee/profile.astro:215-220 already does with the same gate.

### 3. "People you are acting for" never names the person whose authority is held — DelegationSummary carries no name and the page renders none.

`src/pages/portal/employee/delegation.astro:297` — other

**What a person sees.** On /portal/employee/delegation the "People you are acting for" cards read only "Standing in until 2026-09-06" with a list of domains. An employee cannot tell whose approvals they may clear, and two delegations from two different colleagues are indistinguishable from each other.

**Suggested fix.** `d.principalEmployeeId` is on the row (delegation.ts:392). Resolve the principal's full_name — a targeted `SELECT id, full_name FROM hr_employees WHERE id = ANY(...)` over the ids in `held.rows` — and render it as the card heading, exactly as the granted list attempts on line 262.

### 4. The held-delegations list is rendered without checking `inForce`, so a delegation whose end date has passed is still shown as current.

`src/pages/portal/employee/delegation.astro:294` — other

**What a person sees.** After the end date passes, /portal/employee/delegation still shows the card under "People you are acting for" saying "Standing in until 12 August 2026" and "Anything you do here is recorded as yours, done on their authority" — on 23 August. The employee believes they can still clear the queue, but mayActFor() now returns false and every action is refused. The sibling list for granted delegations does check this and appends "(not in force)".

**Suggested fix.** grantDelegation() calls openRelationship() (delegation.ts:245), whose input type has no `effectiveTo` field, so `effective_to` is always NULL and delegationsHeldBy()'s `effective_to > NOW()` filter never excludes anything — expiry lives only in the note's `until`, which surfaces as `d.inForce`. Either filter `held.rows` on `d.inForce` and mark the rest expired (as line 263 does for granted), or add effectiveTo to openRelationship and write it.

### 5. The delegate picker is a single un-searchable SELECT capped at 300 active employees ordered by name, and the same list is the only source for resolving delegate names.

`src/pages/portal/employee/delegation.astro:115` — broken-query

**What a person sees.** On a roll of more than 300 people the "Who" dropdown only ever offers the first 300 names alphabetically, so an employee simply cannot find or select a colleague whose name sorts later — there is no search box and no paging. The same cap hits the display side: any delegation to somebody outside those 300, or to somebody since deactivated, renders in "People acting for you" as the word "Somebody", so the person cannot verify whom they are about to revoke before pressing "End this now".

**Suggested fix.** Use the scoped, keyset-paged, searchable reader this lane already has — src/lib/workforce/directory.ts directoryPage() — for the picker, and resolve delegate names by a direct lookup on the ids actually present in `granted.rows` rather than by searching the roster.

### 6. The compose panel hard-codes two /admin/mail/* links that render on the employee mount of the client, where middleware refuses every /admin path.

`src/components/MailClient.astro:609` — dead-link

**What a person sees.** An ordinary employee composing a message at /portal/employee/mail sees "Manage groups" and "Edit signature & rules" in the compose window. Tapping either navigates them out of the mail app to /portal (middleware.ts:528 redirects any non-admin off /admin/*), abandoning the message they were writing. The "Append signature" checkbox is ticked by default with no reachable place to set a signature.

**Suggested fix.** The component already takes `basePath` and already branches on it at line 203 (`if (templateId && basePath === '/admin/mail')`). Gate both anchors the same way, or route them through basePath, so the employee mount shows no control it cannot honour. This is the exact redirect-to-/admin shape the mail page's own header comment says took /portal down.

### 7. When the settings read throws, the page keeps the default values and renders them as statements of fact about the account.

`src/pages/portal/employee/security.astro:177` — swallowed-error

**What a person sees.** On a failed read of /portal/employee/security the second-step pill says "On/Off" as "Off" for somebody who has it on, the page says "0 unused codes remaining" to somebody carrying ten, the "Turn on the second step" button is disabled with "Set up an authenticator app or enrol your face first" shown to somebody who already has one, and the "turn it off" form is hidden — so neither control works while the screen asserts a security state that is not theirs.

**Suggested fix.** When `loadError` is set, suppress the pill, the remaining-codes count and the prerequisite warning entirely and render only the failure sentence — the same rule internship/index.astro's figureOf() applies (`unread` wins over any value). Note the reads run in one try block, so a throw on line 117 also leaves lines 118-120 at their defaults.

### 8. assignedEquipment() returns [] on a caught exception, and the page prints the empty case as a fact about the person.

`src/pages/portal/employee/profile.astro:451` — swallowed-error

**What a person sees.** If the procurement read fails, the "Equipment and assets" card on /portal/employee/profile tells an employee who has a company laptop recorded against them "Nothing has been recorded against you here yet" — the same sentence shown to somebody who genuinely has nothing, with no indication the read did not complete.

**Suggested fix.** Have assignedEquipment() return `{ ok, items }` (it already distinguishes the genuinely-absent procurement_orders table at profile.ts:986) and render "This could not be read just now" for ok:false, keeping "Nothing has been recorded" for the real empty case.

### 9. (NOT SECOND-READ — dropped by the per-lane cap of eight) joiningDocumentsProgress() returns null both when it cannot read and when there is nothing, and the page renders one sentence for both.

`src/pages/portal/employee/onboarding.astro:399` — swallowed-error

**What a person sees.** A joiner who has already shared three Google Drive links is told on /portal/employee/onboarding "You have not shared any documents yet" whenever the document read fails, on the one screen they have for checking whether their submissions arrived.

**Suggested fix.** joiningDocumentsProgress() (onboarding-journey.ts:2352) catches and returns null, indistinguishable from `{submitted: 0}`. Return a discriminated result and render a third sentence for the unread case — the treatment this same page already gives the checklist via journeyStatusForEmployee()'s `state: 'unavailable'`.

### 10. contractsForEmployee() catches its own database failure and returns [], so a failed read renders the empty state as a statement of fact about the person's employment record.

`src/pages/portal/employee/contract.astro:105` — swallowed-error

**What a person sees.** When the read of hr_employment_contracts fails, an employee with a live contract is told "No contract has been recorded against your employee record yet ... Ask HR to record it" — and goes to HR to ask them to record a contract that is already recorded. The page has no other state for a failed read.

**Suggested fix.** Do what documents.astro already does: separate "read succeeded and there is nothing" from "read did not happen". Either add a readContracts() variant returning { ok, rows, error } (assets.ts:472 already has exactly this pattern in readAssets()) or run a one-row probe on hr_employment_contracts and render "This could not be read just now — that is not a statement that you have no contract" when it fails. The same swallow-to-claim pattern is on support.astro:328 ("You have not raised anything yet"), procurement.astro:436 ("Nothing sent for approval yet") and referrals.astro:143-145 (stat tiles rendering 0/0/0).

### 11. employeeAssets() catches its own failure and returns [], so a failed read of asset_assignments renders as a claim that nothing is issued to this person.

`src/pages/portal/employee/assets.astro:106` — swallowed-error

**What a person sees.** When the assets read fails, somebody holding a company laptop sees "Nothing is issued to you at the moment. If you are holding something that is not listed here, tell the people desk" — the copy actively instructs them to report equipment that is already on the register, and "Handed back" reads "Nothing returned yet" at the same time.

**Suggested fix.** src/lib/assets.ts already solved this for the admin register: readAssets() returns { ok, rows, error } precisely because listAssets() returning [] rendered "Nothing on the register yet" over a failed read. Give employeeAssets()/employeeAssetHistory() the same ok-flagged variant and render the unknown state instead of the empty state.

### 13. A document added by an account whose employee record did not resolve is written with owner_employee_id NULL, and neither listDocuments() nor canRead() has an owner_user_id arm — so the row is invisible to the person who created it.

`src/pages/portal/employee/documents.astro:103` — silent-blank

**What a person sees.** The person presses "Add it as a draft", gets the green flash "Added as a draft. Send it for approval when it is ready", and the very same redirect lands on "Not available — That document is not available to you. It may be a draft belonging to somebody else, or it may not exist." It never appears in the list either, so the document they just created cannot be opened, versioned, submitted or retired from any screen.

**Suggested fix.** Add an owner arm on the account id — `OR d.owner_user_id = ${userId}::uuid` in listDocuments() and the matching check in canRead() (the column is already written) — or stop offering the Add form when myEmployeeId is null and say why.

### 14. The identity denial is resolved and then never rendered: only the not-signed-in redirect is honoured, so every other denial silently narrows the library with no explanation.

`src/pages/portal/employee/documents.astro:81` — gate-without-reason

**What a person sees.** An employee whose record is unresolvable — two records share their email address, their record is closed, or the lookup failed — sees a library containing only company-published documents, with their own drafts and their department's documents missing and no sentence anywhere saying why or who fixes it. Every sibling page in this lane (assets.astro:96, support.astro:244, contract.astro:72, procurement.astro:231, referrals.astro:133) prints the gate's title and reason in that situation; this page prints nothing.

**Suggested fix.** Render the same denial card the other five pages render, above the library: `{denial && (<div class="card"><h3>{denial.title}</h3><p>{denial.reason}</p></div>)}`, and say that only company-wide documents are listed until the record is linked.

### 15. Retiring a document removes it from the only screen in the product that lists documents, with no filter or view that can bring it back.

`src/pages/portal/employee/documents.astro:179` — other

**What a person sees.** After pressing Retire the person is told "Retired. It is kept, not deleted — what the rule used to say is worth having", but the document is then absent from the library list for its owner and for a curator alike, and the search card offers only folder and category filters. The superseded policy can only be reopened by someone who saved the ?d=<uuid> URL, so the promise on the button is not true on any screen.

**Suggested fix.** Add a status filter to the search card (or an "Include retired" checkbox) that passes includeRetired: true, at minimum for the owner and for documents.manage holders — the query option already exists and is used nowhere.

### 16. The Discard confirmation on a draft claims the request is deleted, but the handler calls cancelRequest(), which only sets status='cancelled' and keeps the row.

`src/pages/portal/employee/procurement.astro:371` — other

**What a person sees.** The person confirms a dialog saying "Everything typed into it is deleted, nobody is asked to approve anything, and it cannot be brought back", then the page reloads with the flash "Withdrawn." and the same item still listed under "Your requests" with a Withdrawn chip — item, cost and justification all still on screen. Anyone discarding a draft because it contained something they did not want visible has been told the wrong thing.

**Suggested fix.** Change the confirmation to what actually happens — the draft is marked withdrawn, stays in your list as a record, and cannot be sent for approval afterwards — or give the draft path a real delete.

### 17. The try/catch that is supposed to distinguish "nothing is waiting" from "the queue could not be read" can never fire, because pendingForApprover() catches its own errors and returns [].

`src/pages/portal/employee/schedule/approvals.astro:124` — swallowed-error

**What a person sees.** A reporting manager with interns' weekly plans routed to them opens /portal/employee/schedule/approvals during a database fault and reads the card "Nothing is waiting on you — Plans appear here only when they are routed to you or delegated to you." They close the tab. The plans stay undecided and the intern's week starts with nobody having agreed to it.

**Suggested fix.** Pass the callback the engine already provides and that only src/lib/workforce/loaders.ts:566 currently uses: `let readFailed = false; const all = await pendingForApprover(String(user.id), { onError: () => { readFailed = true; } });` then set queueError when readFailed is true. scheduleForRecord(), capacityForWeek() and outstandingHours() also all swallow internally and return null/{ok:false}, so the surrounding catch is dead for every call inside it.

### 18. "Withdraw this week" stamps hr_timesheets.withdrawn_at but never cancels the approval instance, so the week is still live in the approver's queue.

`src/pages/portal/employee/timesheet.astro:139` — other

**What a person sees.** An employee presses "Withdraw this week", reads "Timesheet withdrawn.", and the row below it then renders the two facts side by side: "Waiting for approval · withdrawn". Their manager still sees that week on /portal/approvals and can approve a timesheet the person retracted — after which submitTimesheet() refuses any correction with "That week has already been approved. It cannot be rewritten".

**Suggested fix.** Do what withdrawSchedule() (eims-schedule.ts:1515) already does for the same gesture: after the UPDATE, call cancelWorkflow(instanceId, user, 'Withdrawn by the person who submitted it'), and when that call fails return a warning the page prints — "the week is withdrawn, but your manager may still see it on their queue" — rather than the flat "Timesheet withdrawn."

### 19. A plan still in 'proposed' state for a week that has since passed is filtered out of both renderers, so it appears nowhere on the page.

`src/pages/portal/employee/schedule/index.astro:199` — silent-blank

**What a person sees.** An intern proposes next week's plan; the manager never decides it; the week goes by. The plan is now invisible on /portal/employee/schedule — no "waiting on a decision" line, no "Withdraw this plan" button, and it is not in "Earlier plans and decisions" either. It is still pending in the manager's queue and its hours still count as `awaiting` against that week's ceiling, but the person who filed it has no screen that admits it exists.

**Suggested fix.** Render undecided past-week proposals in their own always-present block above the plannable weeks — state, hours, and the same Withdraw / Send-it-again controls — rather than dropping them. Minimally, change the history filter to `(s.state !== 'proposed' || weeks.indexOf(s.weekStart) === -1) && weeks.indexOf(s.weekStart) === -1` so a stranded proposal at least reaches the list.

### 20. The request history uses listLeave(), which routes through safe() and returns [] on any read failure, so the page prints a claim about the person instead of admitting it could not read.

`src/pages/portal/employee/leave.astro:217` — swallowed-error

**What a person sees.** An employee with a pending leave request opens /portal/employee/leave during a database fault and reads "Your requests — Nothing requested yet." The Cancel control for their live request is gone with it. The natural response is to file the request again, which applyLeave()'s overlap guard then refuses with a clash message about a request the page just told them does not exist.

**Suggested fix.** Switch to readLeave({ employeeId }), which exists in the same module (hr-leave.ts:1363) for exactly this and returns { ok, rows, error }. Render "Nothing requested yet." only when ok is true, and the error sentence otherwise.

### 21. timesheetFor() returns null both when a week was never submitted and when the read failed, and the page renders only the first meaning.

`src/pages/portal/employee/timesheet.astro:164` — swallowed-error

**What a person sees.** An employee whose week is sitting with their manager opens the timesheet during a read failure and is told "Not submitted yet. The hours below are what your punches recorded; change any of them before you send it." The hours they typed are replaced by clock prefills, the button reverts from "Resubmit for approval" to "Send for approval", and the "Withdraw this week" control disappears — the page contradicts the state their manager is looking at.

**Suggested fix.** Give timesheetFor a read result that separates the two ({ ok, sheet, error }), or wrap the call here and hold a `readFailed` flag; when it is set, render the honest "we could not read this week" notice this page already has markup for (the `!now` .bad block at line 233) and suppress the submit form rather than offering a fresh one.

### 22. The "Holidays coming up" empty state asserts a cause the page cannot know, and is reached both when today's date could not be read and when the holiday query itself failed.

`src/pages/portal/employee/leave.astro:220` — swallowed-error

**What a person sees.** An employee sees "No holidays are recorded for the next three months. That is almost certainly because the calendar has not been filled in yet ... until HR records them, every day inside a leave request is charged to your allowance as an ordinary day" on a company whose holiday calendar is fully recorded. They either delay booking leave across a holiday or tell HR to fix a calendar that is already correct. Unlike /portal/employee/timesheet, which prints "We could not read today's date from the database", this page says nothing when today() returns null.

**Suggested fix.** Call readHolidays() (holidays.ts:140), which returns { ok, list, error } for this exact reason, and render the "the calendar has not been filled in yet" paragraph only when ok is true. Add the missing `{gate.ok && !now && ...}` notice so a failed date read is stated rather than silently falling back to `new Date().getFullYear()` for the balance year on line 214.

### 26. When requireEmployee() denies without a redirect, the page renders nothing about the denial and instead blames an unconfigured evidence-type catalogue.

`src/pages/portal/employee/evidence.astro:72` — gate-without-reason

**What a person sees.** An employee whose hr_employees row is not linked, whose email is on two records, or whose lookup timed out opens /portal/employee/evidence and sees "No evidence types are configured yet, so there is nothing to choose from. Tell HR" plus "Nothing filed yet". They are never told the real reason, and are sent to HR to chase a configuration problem that does not exist while their already-filed evidence appears to have vanished.

**Suggested fix.** requireEmployee() only sets `redirect` for the not-signed-in case, which is already handled by the `if (!user)` line above it. Render the denial the way the sibling pages do — reports/index.astro and projects/[id].astro both do `const denial = gate.ok ? null : gate` and print `denial.title` / `denial.reason` — so 'No employee record is linked to this account', 'More than one employee record uses your email address' and 'We could not load your record just now' each reach the screen, and suppress the 'no evidence types' / 'Nothing filed yet' copy when there is no employee id to read against.

### 27. The Completed and Skills tabs ignore `pathRead === 'unreadable'`, so a failed learning-path read renders as a claim that the person has completed nothing.

`src/pages/portal/employee/learning.astro:511` — swallowed-error

**What a person sees.** When the learning read fails, the Completed tab says "Nothing completed yet" to somebody who has finished assigned courses (their completions come from the assignment rows, and the page itself says a completion often has no certificate number), and the Skills tab says "Nothing you have completed here can back a level yet" and hides the evidence-backed skill form. Nothing on either tab says a read failed.

**Suggested fix.** `completions` and `evidenceCourses` are both derived from `ordered`, which is empty when `pathRead === 'unreadable'`. Gate the two empty-state sentences on `pathRead === 'ok' && certRead === 'ok'`, and render the existing `.broke` banner ("We could not read your learning just now") on the Completed and Skills tabs too — performance-learning.ts carries the read state for exactly this reason.

### 28. A failed employee-record lookup renders the same sentence as genuinely having no record, telling the person HR has not created their record.

`src/pages/portal/employee/learning.astro:349` — swallowed-error

**What a person sees.** When readEmployeeIdForUser() fails (a pooler timeout), every tab collapses to "There is no employee record on this account — HR creates the record; nothing on this page can create it for you", so a person who is on the register is told they are not and sent to HR.

**Suggested fix.** Print `viewer.explanation` the way performance.astro does (`<p class="scope">{viewer.explanation}</p>`), and only show the "HR creates the record" wording when the explanation is the genuine no-record one.

### 29. The Team-tab manager review form has no inputs for goals_score, skills_score, attitude_score or reviewer comments, but saveManagerReview() SETs all four unconditionally, so every portal save nulls them.

`src/pages/portal/employee/performance.astro:227` — other

**What a person sees.** Sub-scores and reviewer comments entered on /admin/hr/performance (Goals Achievement, Skills, Attitude, Reviewer comments) are blank the next time that review is opened, once the manager has pressed "Save draft" or "Submit review" on the portal Team tab. The Fusion evidence statements built from those scores ("Scored 4 of 5 against agreed goals in <cycle>") disappear with them.

**Suggested fix.** Either add the four controls to the portal form, or make saveManagerReview() preserve absent fields — e.g. `goals_score = COALESCE(${...}::numeric, goals_score)` and the same for skills_score, attitude_score and reviewer_comments — so a caller that does not collect a field cannot erase it.

### 32. The evidence POST renders its result in place instead of redirecting, and submitEvidence() has no de-duplication, so a resubmit files the work twice.

`src/pages/portal/employee/evidence.astro:87` — other

**What a person sees.** After filing evidence, a refresh or a back-then-forward (the browser's "Confirm form resubmission") files the identical link a second time. The intern's "What you have filed" list shows the same item twice with the hours counted twice, and the same duplicate lands in the mentor's verify queue.

**Suggested fix.** Follow the post-redirect-get pattern every sibling page in this lane already uses (reports/index.astro, performance.astro, learning.astro): redirect to PATH with the message in the query string so a refresh cannot resubmit. A uniqueness guard on (employee_id, url, occurred_on) in submitEvidence() would close the remaining window.

### 33. The optional second activity slot is silently discarded when its hours field is left empty, and the page still reports success.

`src/pages/portal/employee/evidence.astro:99` — other

**What a person sees.** Somebody who picks a second kind under "Also evidence of (optional)" but leaves "Hours on that" blank sees "Filed. Your mentor can see it now", and the filed card then lists only the first activity. Nothing tells them the second one was dropped, and the mentor never sees it.

**Suggested fix.** When `kind_b` is set but `hours_b` is not a positive number, refuse the submission with a sentence naming the missing field (the same way submitEvidence refuses zero hours on every activity), rather than dropping the slot and reporting success.

### 35. getBalance() returns 0 on a failed ledger read, and this page turns that 0 into a definite statement about the person's money without any probe of whether the read succeeded.

`src/pages/portal/employee/payslips.astro:196` — swallowed-error

**What a person sees.** When hr_wallet_txn cannot be read, an employee who has net pay sitting in their wallet opens /portal/employee/payslips and is told "Your wallet is empty ... There is nothing waiting there to withdraw." They stop looking for money that is there. The sibling page wallet.astro already knows this is wrong and guards it with an explicit `ledgerReadable` probe (wallet.astro:116-127) before it will print a figure; this page has no such probe.

**Suggested fix.** Do what wallet.astro does: run the same one-row `SELECT 1 FROM hr_wallet_txn WHERE employee_id = ...` probe before rendering the note, and when it fails say the wallet could not be read rather than that it is empty. Or give getBalance() a discriminated result (`{ ok, balance, ... }`) the way payslipsForEmployeeResult() and bonusesForEmployee() already do on this same page.

### 36. catalogueFor() returns an empty catalogue on any read failure, and the page renders that emptiness as a positive claim that the company has no benefits and that the person is enrolled in nothing.

`src/pages/portal/employee/benefits.astro:147` — swallowed-error

**What a person sees.** If hr_benefits cannot be read (or the schema ensure fails), every employee is told "No benefits have been published yet — HR has not recorded any benefits in this system" (line 180), when in fact the catalogue is full. Separately, if only enrolmentsForEmployee() fails, someone actively enrolled in medical cover loses the "You are enrolled in" card entirely (line 228) and their benefit shows the "Ask to join this" button as though they had never elected it — so they re-elect something they already hold. The page has a `lookupFailed` warning for the identity read and nothing at all for the catalogue read.

**Suggested fix.** Give catalogueFor() the discriminated shape the rest of this lane uses (`{ ok, entries, subject, reason }`, like payslipsForEmployeeResult in payroll.ts:2242), and branch on it here: on a failed read say the catalogue could not be read and that this is not a statement about entitlement, instead of "No benefits have been published yet".

### 37. When the page has already determined the wallet ledger is unreadable, the withdrawal form still renders and asserts a hard maximum of zero, contradicting the balance panel three inches above it.

`src/pages/portal/employee/wallet.astro:220` — other

**What a person sees.** On a ledger read failure the balance card says "Not known right now" and "This is deliberately not a zero: money may well be in there" (line 164-169) — and directly beneath it the withdrawal form is labelled "Amount (max ₹0.00)" with `min=1 max=0`, so any amount the employee types is rejected by the browser with a native message about the value having to be less than or equal to 0. The one screen tells them both that the balance is unknown and that they may withdraw nothing, and gives no reason for the second.

**Suggested fix.** Gate the form body on `ledgerReadable`: keep the card rendered (house pattern — never make a panel vanish) but replace the amount field with the reason it is unavailable, e.g. "Your balance could not be read just now, so a withdrawal cannot be checked against it. Nothing is lost — try again in a few minutes."

### 38. The approver's "Waiting on you to decide" queue is nested inside the {employee && ...} branch, so it disappears whenever the viewer's own employee record is denied — even though the queue is resolved from their user id and is entirely independent of that record.

`src/pages/portal/employee/expenses.astro:176` — silent-blank

**What a person sees.** A reporting manager who hits the gate's 'ambiguous-record' denial (two hr_employees rows share their email address — workspace-access.ts:486-489 refuses rather than picking) opens Expenses and sees only "More than one employee record uses your email address". The claims routed to them for decision — which pendingForApprover() has already returned, since `inbox` is read from user.id at line 145 regardless — are rendered nowhere, with no mention that a queue exists. Meanwhile the claimant's own screen keeps printing "Step 1: <that manager> · pending" until it escalates.

**Suggested fix.** Move the `{inbox.length > 0 && ...}` block out of the `{employee && ...}` wrapper so it renders on its own condition, and when `inbox.length > 0` but `employee` is null, render it above the denial card with a line saying the decisions below belong to this sign-in and are unaffected by the record problem.

### 40. The Privacy tab tells the employee a correction request "goes to a person" who will answer it, but nothing in the product ever reads emp_intel_correction except this same page — openCorrections() and decideCorrection() have zero callers.

`src/pages/portal/employee/intelligence.astro:162` — other

**What a person sees.** An employee disputes a statement on their record, is told "Filed. A person picks this up, and you will see their answer and their reason here", and the request then sits under "What you have asked to be corrected" showing status Open forever. No admin or HR screen anywhere lists it, so nobody ever sees it and no answer can ever appear. The only action that ever changes it is the employee withdrawing their own request.

**Suggested fix.** Either build the people-desk queue that calls openCorrections()/decideCorrection(), or — until it exists — change the confirmation and the section copy to say where the request currently goes (an audit row only) instead of promising an answer that cannot arrive.

### 44. feedbackRecipients() catches any query failure and returns [], and the page renders that as "Nobody is in reach yet" with copy explaining that the organisation chart has not been populated — a claim that contradicts the graphEmpty notice the same page suppresses when the graph IS initialized.

`src/pages/portal/employee/feedback.astro:307` — swallowed-error

**What a person sees.** On a failed recipients query, a manager with direct reports opens Feedback > Give and sees no form at all, just "Nobody is in reach yet — the people you can write about are the ones the organisation chart already connects you to... On a chart that has not been populated, that list is empty." The chart is populated (the "chart has not been set up" notice above does not appear, because viewer.initialized is true), so the two panels tell the reader opposite things and the person is sent hunting for an org-graph problem that does not exist.

**Suggested fix.** Have feedbackRecipients() return an ok flag alongside the rows (the pattern readEmployeeIdForUser and myTasksView already use) and render "we could not read who is in reach just now" when ok is false, keeping "Nobody is in reach yet" for a genuinely empty list.

### 47. The corrections POST handler renders its success flash in place instead of redirecting, and requestCorrection() has no per-(employee, day) uniqueness, so a reload files a second request and a second approval.

`src/pages/portal/employee/attendance/corrections.astro:162` — other

**What a person sees.** After "Send for approval", a pull-to-refresh or a back-navigation on a phone re-posts the form. The person's own "Your requests" list then shows the same day twice, and their reporting manager's "Waiting on you" queue shows the same correction twice and must decide it twice. The file's own comment at corrections.astro:250-253 states "every write here ends in a redirect", which is not true of any of the three actions.

**Suggested fix.** Redirect after every successful write (`return Astro.redirect(PATH + '?ok=sent')` etc.) the way clock-out.astro:187 and worklog.astro:55 already do, and refuse a second live correction for a day that already has an undecided one.

### 50. The punch POST handler renders its flash in place rather than redirecting, so the punch screen is left on a POST response.

`src/pages/portal/employee/attendance/index.astro:215` — other

**What a person sees.** After clocking in with the no-JavaScript path or the native fallback, a pull-to-refresh or a back-navigation re-submits the punch and the screen answers with a red "You are already checked in for today." (or "No break is running." after ending a break) — which reads as the tracker having gone wrong on the one screen people open twice a day. The comment at index.astro:286-289 justifies the placement of composeWorkspace with "every write on this page ends in a redirect", which is not true of this handler.

**Suggested fix.** Redirect after a successful punch (`return Astro.redirect(PATH + '?done=' + kind)`) and render the confirmation from the query string, matching clock-out.astro:187.
