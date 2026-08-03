import type { User } from '@/lib/db/schema';

export type Permission =
  | 'admin.access'
  | 'roles.view' | 'roles.edit'
  | 'applications.view' | 'applications.edit' | 'applications.score'
  | 'events.view' | 'events.edit'
  | 'products.view' | 'products.edit'
  | 'content.view' | 'content.edit'
  | 'users.view' | 'users.edit'
  | 'settings.view' | 'settings.edit'
  // Offer-letter verification requests (the QR two-path flow). These were referenced by
  // /admin/offer-verifications before they existed here, so can() returned false for EVERY role
  // including super_admin and the console redirected everyone away — firms could be charged for a
  // verification that no human could then open and answer.
  | 'offers.view' | 'offers.edit'
  // Money leaving the company. /api/admin/payments/refund and refund-manual used to be gated by
  // `user.role !== 'applicant'` — the exact test warned against in canAccessSection() below — on an
  // endpoint that issues a REAL Razorpay refund. Every internal role passed it, including the
  // `editor` the 2026 offer-signing promotion handed to every intern, and /api/* is not covered by
  // the /admin middleware gate, so nothing else stood in front of that URL.
  //
  // The refund console itself (/admin/finance) has always been super_admin + hr, so these are
  // granted to exactly those two: the capability records the policy the product already had, it
  // does not invent a new one. `payments.refund` is SENSITIVE in registry.ts — granting it to a
  // custom role must be provably on the record.
  | 'payments.view' | 'payments.refund'
  // APPROVALS AND PEOPLE. docs/workforce-os/AUTHORIZATION_FIRST.md:68-74 names CanApproveLeave,
  // CanApprovePayroll, CanManageEmployees and CanManageDepartments as the vocabulary a widget must
  // declare instead of a role name. None of them existed anywhere — not here, not in
  // BUILTIN_PERMISSIONS — which is the whole reason src/lib/hr-wallet.ts, src/lib/hr-leave.ts,
  // src/lib/workforce/composer.ts and src/lib/auth/workspace-access.ts still compare role STRINGS:
  // there was nothing to translate into. Written in this file's existing dotted style rather than in
  // the spec's CamelCase, because two naming conventions for one concept is how a check ends up
  // asking for a permission that nobody granted.
  //
  // MECHANISM, NOT POLICY. Every grant in PERMS_BY_ROLE below reproduces the authority the code
  // enforced when the keys were added, derived from the checks listed above the matrix.
  //
  // NOW ASKED FOR, in the money and time-off engines, each holding the same population it did as a
  // role-name test: hr-wallet.ts approverRole()/pendingWithdrawalsForApprover()/payWithdrawal() and
  // hr-leave.ts pendingLeaveForApprover(). The two PAGE gates (/admin/hr/wallet, /admin/hr/leave)
  // still ask canAccessSection() on purpose — see the note at the end of this block, and the comment
  // at the top of each page.
  //
  // AND IN THE WORKSPACE GATES: `employee.manage` is what requireHr() admits on and what
  // Workspace.isHr is resolved from; `department.lead` is what requireTeamLead() and the composer's
  // leadsDepartment ask for. Both through holdsCapability() in src/lib/auth/workspace-access.ts,
  // which asks can() — this matrix — and never the registry, so the WILDCARD a super_admin holds
  // cannot turn the founder into a department-scoped team lead. Every one of those gates admits the
  // same accounts it admitted as a role-name test.
  | 'leave.approve'
  | 'payouts.approve' | 'payouts.pay'
  // RENAMED from `employees.manage` (shipped in 6a0b03b) to the canonical singular spelling. The
  // grant set is byte-for-byte the same (super_admin + hr) and both call sites in
  // src/lib/auth/workspace-access.ts moved with it, so this changes the SPELLING and nothing else.
  // The reason it was worth a rename: every other people key in the ratified vocabulary is singular
  // (employee.view / employee.create / employee.edit), and one plural outlier is how a check ends up
  // asking for a permission nobody granted.
  //
  // A stale `employees.manage` row is left behind in permission_catalogue on any database that has
  // already booted this module. It is inert — nothing asks for it, and the two gates that used to
  // ask went through can() (PERMS_BY_ROLE) rather than the registry, so no custom-role grant of it
  // ever did anything. Removing the row needs a database change and is listed as a follow-up.
  | 'employee.manage'
  // NOT REMOVED, DELIBERATELY, AND AGAINST THE SPRINT BRIEF'S DEFAULT. See the block headed
  // "WHY department.lead IS STILL HERE" below the matrix. Short version: deleting it changes who may
  // open a team-lead surface, and there is no organisational data to resolve leadership from.
  | 'department.lead'
  | 'audit.view'

  // =============================================================================================
  // THE `role !== 'applicant'` FAMILY. Every key in this group replaces the exact test
  // canAccessSection()'s docblock warns against, and every one of them is granted to EXACTLY the ten
  // non-applicant built-in roles — including partner, teacher and technical_moderator, which hold no
  // admin.access and which src/middleware.ts bounces off /admin entirely.
  //
  // THAT WIDTH IS NOT AN ENDORSEMENT. It is what the code enforces today, and this sprint changes
  // HOW authorization is asked, never WHO may do what. Recording the population as a capability is
  // what makes narrowing it a reviewable, one-line policy decision instead of an archaeology
  // project across nine files. Each of these is reported as too wide in the accompanying findings.
  //
  // WHY NOT AN EXISTING KEY. There is no capability in this union whose holders equal "every
  // internal role". content.edit is super_admin + hr + marketing + editor; admin.access is the seven
  // console roles. Converting any of these call sites to either would REMOVE access from real
  // accounts — a narrowing dressed up as a mechanism swap, which is the defect this sprint exists to
  // remove rather than to commit.
  //
  // CONVERT WITH can(), NOT hasPermission(). can() reads this matrix only. The registry adds the
  // super_admin WILDCARD (identical here) and any custom-role grant, including keys spelled by the
  // legacy section matrix as `<page_key>.<action>` — so a registry-based conversion of, say,
  // tests_restricted.view would silently admit every custom role holding that section checkbox.
  // =============================================================================================

  // The company mailbox: poll it over IMAP with stored credentials, send from it, probe an SMTP or
  // IMAP connection, read its DNS posture. Five routes under src/pages/api/mail/ share one test.
  | 'mail.manage'
  // AquinTutor lesson authoring, split the way payouts.approve / payouts.pay is split: writing a
  // lesson and making it live to learners are two powers even though the same ten roles hold both
  // today. Eight routes ask `lessons.author`; publish.ts alone asks `lessons.publish`.
  | 'lessons.author' | 'lessons.publish'
  // Generating interview templates from an uploaded document — LLM spend, and authority over what
  // candidates are asked. Deliberately NOT folded into lessons.author: teaching material and
  // candidate assessment are different business actions with different intended populations.
  | 'interviews.author'
  // Triggering a scheduled bulk job by hand: the XP league settlement (promotions, demotions and
  // reward writes across every learner) and the streak push fan-out. Both routes ALSO accept
  // CRON_SECRET, which is not a role and stays as its own arm.
  | 'jobs.run'
  // Reading restricted internal research (the Viśvambhara deep modules gated in src/middleware.ts).
  | 'research.restricted.view'

  // =============================================================================================
  // THE super_admin CLUSTER. Five surfaces whose only gate is a literal role comparison against
  // 'super_admin', each granted below to super_admin and to nobody else. No existing key is a
  // semantic match: users.view/users.edit are exact-population but describe ACCOUNTS, and an audit
  // line saying somebody changed an account when they published an applicant's profile or exported
  // every resume on file is a log that misdescribes what happened.
  //
  // SUPER_ADMIN'S WILDCARD LIVES IN THE REGISTRY, NOT IN can(). A new key that is not written into
  // the super_admin array below answers FALSE for the founder. That omission made an entire console
  // unreachable on this project once already.
  // =============================================================================================

  // Publishing an applicant's profile to the public web, and editing its content (/admin/profiles).
  | 'profiles.manage'
  // Opening resume submissions. READING them, one at a time, on a screen — no longer the CSV of every
  // one of them, which moved to `reports.export` below.
  | 'resumes.view'
  // BULK EXPORT. Taking a whole dataset out of the product in one request — the ?export=csv arm of
  // /admin/resumes today, which returns an unpaginated file of every submission on file including
  // guests who never made an account.
  //
  // WHY IT IS ITS OWN KEY. `resumes.view` gated BOTH opening the screen and downloading the whole
  // table, and those are not the same act: reading one person's submission because they asked you to
  // is ordinary, and walking out with every name, email, phone and LinkedIn in the database is not.
  // One weakened line therefore exported the entire dataset. Viewing must never automatically confer
  // bulk export, so the export arm now asks for BOTH keys and the view path asks for neither more nor
  // less than it did before.
  //
  // THE NAME IS THE RATIFIED ONE. `reports.export` is the vocabulary's spelling for "take a dataset
  // out in bulk" — it is the worked example in registry.ts registerPermission() and on
  // /admin/team/roles — so it is used here rather than inventing `resumes.export`. It is deliberately
  // NOT resume-specific: it is the key any future bulk-export arm should ask for alongside whatever
  // permission gates reading that data, so there is one answer to "who may take data out".
  //
  // POPULATION UNCHANGED. Granted below to super_admin and to nobody else, which is exactly who could
  // reach ?export=csv before this key existed (the page gate was, and remains, super_admin-only
  // `resumes.view`). Nobody gains the export; nobody loses it.
  //
  // NO SECTION SPELLS IT. There is no `reports` section in src/lib/admin-sections.ts, so
  // seedCatalogueRows() derives no `reports.*` key and the section matrix cannot produce this one by
  // accident — but page_key is free text, so the call site uses can() (PERMS_BY_ROLE alone), never
  // hasPermission(), for the same reason resumes.view does.
  | 'reports.export'
  // Putting spendable balance on an account by email (/admin/credits). Money creation.
  | 'credits.grant'
  // Re-driving a captured payment into a materialised application (/admin/paid-stuck).
  | 'payments.retry'
  // Precise personal location data about identifiable applicants (src/lib/applicant-location.ts).
  | 'locations.view'

  // =============================================================================================
  // THE REST. Each is derived from its own call site; the derivation is written beside the grant.
  // =============================================================================================

  // The salary screen: base_salary, payslips, payroll runs. super_admin + hr, matching the literal
  // role list on /admin/hr/payroll today.
  // ALSO GATES the salary-component catalogue (/admin/hr/payroll/components), which is where the
  // rates for provident fund, state insurance, professional tax and withholding are now SET BY AN
  // ADMINISTRATOR instead of being hardcoded inside the payroll run. That is the same authority this
  // key already describes — "set salaries, generate payslips" — expressed on a screen rather than in
  // a constant, so no second key is invented for it.
  | 'payroll.manage'
  // READING EVERY EXPENSE, TRAVEL AND ADVANCE CLAIM IN THE COMPANY (/admin/hr/payroll/claims),
  // together with the approval chain each one is walking and the wallet withdrawals routed alongside
  // them.
  //
  // A NEW POWER, WHICH IS WHY IT IS A NEW KEY, and there is no population to preserve: before
  // src/lib/expenses.ts there was no claim table anywhere in this codebase and no surface that could
  // list one. So the rule that applies is the one requisitions.approve and community.moderate were
  // settled by — GRANT TO THE NARROWEST DEFENSIBLE HOLDER and write down why. That is super_admin +
  // hr, the two roles that already hold payroll.manage and payouts.approve, i.e. the people who
  // already see what every employee is paid. Nobody else holds it and nothing is widened.
  //
  // IT CONFERS NO APPROVAL, AND MUST NOT BE READ AS ONE. Deciding a claim happens in
  // src/lib/workflow.ts, where the `expenses` and `travel` domains deliberately declare
  // `capability: null` — only the person the Organization Graph ROUTED to, or their in-force
  // delegate, may decide. Holding this key means watching the queue, not acting on it. Mapping those
  // domains onto a standing capability would hand every holder authority over every claim in the
  // company, which is exactly the per-user reach that per-row routing exists to remove.
  //
  // SENSITIVE in registry.ts: a claim names what a colleague spent money on, medical claims included,
  // so a grant of it is written strictly and rolled back if the audit row cannot be written.
  | 'expenses.review'
  // A restricted exam's question bank. Named to match the `tests_restricted` SECTION KEY that
  // already exists in src/lib/admin-sections.ts ("Restricted Exams — Designated-authority only")
  // rather than inventing a second spelling for the same authority. See the dedupe note below.
  | 'tests_restricted.view'
  // Responding to an emergency: reading the SOS queue and live staff locations, and closing an
  // active SOS in somebody else's name (/admin/sos).
  | 'safety.respond'
  // Approving a hiring requisition (src/lib/hr-requisition.ts decideRequisition).
  | 'requisitions.approve'
  // Acting on the live-classroom moderation queue (src/lib/moderation.ts).
  | 'community.moderate'
  // =============================================================================================
  // PROCUREMENT — the purchasing console and the vendor list.
  //
  // NEITHER OF THESE APPROVES ANYTHING, and that is the load-bearing part. A purchase request is
  // approved by the people the ORGANIZATION GRAPH names for that requester — their reporting
  // manager, their department head, and an executive sponsor at or above the amount declared on the
  // chain — resolved per ROW by src/lib/workflow.ts. That engine's `procurement` domain carries
  // `capability: null` on purpose, so NO key in this union confers standing authority over somebody
  // else's purchase request, and neither of these two is a way to acquire one. Only the person the
  // graph routed to, or their in-force delegate, may decide.
  //
  //   procurement.view    open /admin/procurement: every request in the company, the approval chain
  //                       each is in, and the orders raised against them.
  //   procurement.manage  raise a purchase order against an ALREADY-APPROVED request, confirm a
  //                       receipt (including the asset tag), and add or retire a vendor.
  //
  // SPLIT ON THE EXACT PRECEDENT OF payouts.approve / payouts.pay: the same two roles hold both
  // today, and they are still two keys, so that a future grant can separate reading the purchasing
  // record from committing the company to a supplier without a code change.
  //
  // GRANTED TO super_admin AND hr, which is who holds the equivalent authority over company money
  // today: `hr` is the only built-in role below super_admin carrying `finance` and `payouts` in
  // ROLE_SECTIONS, and /admin/finance has been super_admin + hr since it was written. This records
  // the population the product already has; it does not invent a wider one.
  //
  // THE CONSOLE ALSO ACCEPTS canAccessSection(user, 'finance', 'edit'), for the same reason
  // /admin/hr/leave/workflow accepts the `leave` section: a CUSTOM role holding the finance section
  // resolves through the registry as `finance.edit` and NEVER as `procurement.view`, so gating on
  // the capability alone would remove access from every custom role that has it today. Accepting
  // either is the documented way to convert without narrowing.
  //
  // WHAT THESE KEYS DELIBERATELY DO NOT GATE: an employee raising a purchase request for themselves
  // and watching it move. That is a self-scoped fact about the signed-in person, narrowed in the
  // WHERE clause by their own user id, and gating it would lock out exactly the people it is for —
  // an employee's account frequently carries the `applicant` role, which holds nothing at all.
  | 'procurement.view' | 'procurement.manage'
  // =============================================================================================
  // WORKPLACE SERVICES - helpdesk, asset register, document library.
  //
  // THERE IS NO EQUIVALENT AUTHORITY TO PRESERVE, and that is a fact about the codebase rather than
  // an assumption: before these three modules there was no ticket table anywhere, no asset register
  // (only hr_separation.assets_returned - one boolean, with nothing behind it), and no company
  // document library at all. src/lib/workforce/navigation.ts NAV_BACKLOG stated the last of those
  // in as many words. So there is no population to reproduce, and the rule that applies is the one
  // requisitions.approve and community.moderate were settled by: GRANT TO THE NARROWEST DEFENSIBLE
  // HOLDER and write down why, rather than reproduce an accident or invent a wide grant.
  //
  // NARROWEST DEFENSIBLE = super_admin + hr, matching the two new admin sections ('helpdesk',
  // 'assets') added to ROLE_SECTIONS below, so the sidebar, the page gate and the capability all
  // admit the same people. UNLIKE requisitions.approve and community.moderate, every key here is
  // ENFORCED at its call sites from the day it ships: the admin surfaces refuse without it, and
  // every write re-checks it against the posted id rather than the rendered one.
  //
  // WHAT THESE KEYS DELIBERATELY DO NOT GATE: an employee raising a ticket, seeing the assets
  // issued to them, or reading a document shared with them. Those are self-scoped facts about the
  // signed-in person, resolved from their own hr_employees row and narrowed in the WHERE clause.
  // Gating them on a capability would lock out exactly the people they exist for - an employee's
  // account frequently carries the `applicant` role, which holds nothing at all.
  // =============================================================================================

  // Every ticket on every desk: read it, assign it, move it through its states, resolve and close
  // it. An IT ticket carries device and account detail and an HR ticket carries whatever somebody
  // felt unable to say to their own manager, so this is not a read to hand out widely.
  | 'helpdesk.manage'
  // The asset register: record an asset, issue it to somebody, take it back, log damage, retire it.
  // It is also a claim about a person ("Priya holds laptop LAP-014"), which is why it is one named
  // authority rather than an open hardware list.
  | 'assets.manage'
  // The company document library: folders, categories, retention, and sharing a document beyond the
  // people it was shared with. NOT the power to APPROVE a document - that is routed per document
  // through the Organization Graph by src/lib/workflow.ts, and holding this key confers no approval
  // over anybody. Publishing what an approval already settled is this key; deciding it is not.
  | 'documents.manage'
  // =============================================================================================
  // WORKING TIME AND AGGREGATE REPORTING (src/lib/attendance.ts, src/lib/analytics-workforce.ts).
  //
  // NEITHER OF THESE APPROVES ANYTHING. An attendance correction is routed per ROW through
  // src/lib/workflow.ts in the `attendance` domain, whose definition carries `capability: null` — so
  // no key in this union confers standing authority over one, and holding either of these puts
  // nobody on an approval route. The reporting manager the ORGANIZATION GRAPH names decides it, and
  // their in-force delegate may stand in.
  // =============================================================================================
  //
  // DEFINING WORKING TIME: shifts, who is rostered on which one, the holiday list, and the QR
  // stations a punch may be scanned at (/portal/employee/attendance/roster).
  //
  // POPULATION, DERIVED FROM THE AUTHORITY IT SITS BESIDE. None of these objects existed before, so
  // there is no rule to preserve exactly, and the settled approach for that case — the one
  // requisitions.approve, community.moderate and the workplace-services keys above were decided by —
  // is GRANT TO THE NARROWEST DEFENSIBLE HOLDER AND WRITE DOWN WHY. That is whoever already
  // administers attendance: the `attendance` section in ROLE_SECTIONS below, held by `hr` alone among
  // the built-in roles, plus super_admin who is unrestricted there. Those two, and nobody else.
  //
  // WHY NOT AN EXISTING KEY. `employee.manage` means "administer people records", and a shift pattern
  // is not a people record; reusing it would hand rostering to a population chosen for a different
  // power and make a future narrowing of either impossible without moving the other.
  // `department.lead` is a SCOPING signal about one department, not authority over the organization's
  // working-time definitions.
  //
  // EVERY EMPLOYEE STILL READS THEIR OWN SHIFT AND THE HOLIDAY LIST without holding this. Those are
  // facts about their own working life, and the read half of that screen is gated on their employee
  // record rather than on this key.
  | 'attendance.roster.manage'
  // OPENING THE WORKFORCE ANALYTICS CONSOLE (/admin/analytics): headcount, department, attendance,
  // leave, recruitment and performance — AGGREGATE ONLY, suppressed below the platform minimum group
  // size, with no row-per-person query behind any of it and no drill-down to one.
  //
  // POPULATION: super_admin + hr, the same two who hold `employee.manage` and can therefore already
  // read every individual employee record one at a time on /admin/hr/employees. So this grants
  // sight of nothing new — it offers the aggregate instead of the row, which is the NARROWER
  // artefact.
  //
  // ITS OWN KEY RATHER THAN employee.manage, BECAUSE THE AUDIT LINE MATTERS. "Opened the analytics
  // console" and "administered an employee record" are different acts, and a log that describes one
  // as the other misdescribes what happened. It also means a future grant of read-only aggregate
  // reporting to, say, a department head need not come bundled with the power to edit people's
  // records.
  //
  // THE PAGE MUST ASK FOR IT, AND DOES. src/middleware.ts has no section key for /admin/analytics,
  // so the only structural gate on that URL is canOpenAdmin() — which admits every admin-capable
  // role, including the `editor` that offer letters once handed to interns. can(user,
  // 'analytics.view') on the page is therefore the real gate rather than a second belt.
  //
  // WHAT NO GRANT OF THIS EVER BUYS: individual health or wellness data. Nothing behind this
  // capability queries wellness_* at all — that is enforced by the absence of the query in
  // src/lib/analytics-workforce.ts, not by a permission check somebody could widen later.
  | 'analytics.view'
  // =============================================================================================
  // THE EMPLOYEE REFERRAL PROGRAMME (src/lib/referrals.ts).
  //
  // TWO KEYS, AND NEITHER OF THEM APPROVES A PAYMENT. A referral reward is decided by the people the
  // ORGANIZATION GRAPH names for the referrer, routed per ROW through src/lib/workflow.ts in the
  // `recruitment` domain — whose definition carries `capability: null`, so no key in this union
  // confers standing authority over somebody else's reward. `referrals.reward` is the power to
  // RECORD an amount and to SEND it for approval; the decision belongs to the routed approver or
  // their in-force delegate, and releasing the money is still `payouts.pay` in the payouts console.
  //
  //   referrals.view    open /admin/recruitment/referrals: every referral, who referred whom, the
  //                     candidate's name, email and CV link, and where the reward has got to.
  //   referrals.reward  record that a referral earns an amount, and send that amount into approval.
  //
  // HOW THE GRANTS WERE DERIVED, given that no referral programme existed to preserve a population
  // from. Each key is matched to the EXISTING key whose holders already hold the same class of
  // information or authority, so nobody gains a power they did not already have in another form:
  //
  //   referrals.view   -> the holders of `applications.view` (super_admin, hr, recruiter, reviewer,
  //                       department_head). A referral record is a candidate's name, email address
  //                       and CV link — exactly the class of data those five already read on
  //                       /admin/applications, and the referral console is a view of the same
  //                       pipeline from a different end. Granting it more narrowly would hide from a
  //                       reviewer a candidate whose full application they can already open.
  //   referrals.reward -> the holders of `payouts.approve` (super_admin, hr). Putting a number on a
  //                       payment that will later leave the company is money-adjacent, and those two
  //                       are who the product already trusts with that class of act. `recruiter`
  //                       deliberately does NOT hold it: a recruiter may see the programme and may
  //                       not price it.
  //
  // AN EMPLOYEE SUBMITTING A REFERRAL HOLDS NEITHER, AND MUST NOT NEED TO. That surface
  // (/portal/employee/referrals) is self-scoped to the signed-in person's own referrals and is gated
  // on HAVING AN EMPLOYEE RECORD, which is a fact about a row rather than a capability. Gating it on
  // a key would lock out exactly the people the programme is for — an employee's account frequently
  // carries the `applicant` role, which holds nothing at all.
  //
  // ASK FOR THESE WITH can(), NEVER hasPermission(). `referrals` is not a section key in
  // src/lib/admin-sections.ts, so seedCatalogueRows() derives nothing — but page_key is free text, so
  // a hand-typed row could spell `referrals.view`, and a registry-based check would then admit a
  // custom role nobody deliberately granted candidate contact details to.
  | 'referrals.view' | 'referrals.reward'

  // =============================================================================================
  // PERFORMANCE, SKILLS AND LEARNING. Three keys, and each one is deliberately NARROW because the
  // authority they do NOT carry is the whole point of the design.
  //
  // WHAT THESE KEYS ARE NOT. None of them makes anybody a manager. "Sees this person's goals",
  // "writes their appraisal", "assesses their skills", "assigns them a course" are per-ROW facts
  // resolved from the Organization Graph (src/lib/org-graph.ts isReportingManager /
  // getDirectReports / getReviewers / isResponsibleFor), exactly as the note above this matrix says
  // a reporting-manager authority must be. Granting one of these in order to "cover managers" would
  // hand every holder authority over every employee — the widest change available in this file, and
  // the precise regression Phase 1 removed.
  //
  // So each key means "across the whole organization, without a relationship" — the HR desk's job.
  //
  // NEITHER APPROVES AN APPRAISAL. src/lib/workflow.ts declares the `appraisal` domain with
  // `capability: null`, so only the person the graph ROUTED to (the department head), or their
  // in-force delegate, may sign one off. `performance.manage` gates RUNNING a cycle and calibrating
  // it; making it standing authority on that chain would let the calibration desk approve its own
  // calibration, which is not a second look.
  //
  // POPULATION, DERIVED NOT INVENTED. All three are granted to super_admin + hr, which is exactly
  // who can reach the surfaces they gate today: /admin/hr/performance and /admin/hr/training fall
  // under the `hr` and `training` sections in PATH_SECTION (src/middleware.ts), and ROLE_SECTIONS
  // below gives both sections to `hr` alone (super_admin is unrestricted). Nobody gains anything.
  //
  // ASK FOR THESE WITH can(), NEVER hasPermission(). There is no `performance`, `skills` or
  // `learning` section in src/lib/admin-sections.ts, so seedCatalogueRows() derives nothing — but
  // page_key is free text, so a hand-typed row could spell one of them and a registry-based check
  // would admit a custom role nobody deliberately granted appraisal ratings to.
  // =============================================================================================

  // Run appraisal cycles for the whole organization: open a cycle, move it between self-assessment,
  // manager review and calibration, adjust a rating for somebody who does not report to you, and
  // record an outcome. A reporting manager writes their OWN reports' reviews through the graph.
  | 'performance.manage'
  // Maintain the skill catalogue, and record a skill level for somebody who is not your report. An
  // employee always records their own; a manager records their reports'. Neither needs this.
  | 'skills.manage'
  // Assign a course to anybody in the organization, and schedule the training calendar. A manager
  // assigns to their own reports through the graph; this is the org-wide version.
  | 'learning.assign';

// Exported so a read-only console can SHOW the matrix instead of a second, hand-typed copy of it
// drifting away from the real one (/admin/access-preview). Nothing outside this file may decide
// access from it — use can(), which is the single test every other caller already uses.
//
// ---------------------------------------------------------------------------------------------
// HOW THE FIVE APPROVAL/PEOPLE GRANTS BELOW WERE DERIVED. Read this before changing one of them.
//
// Each was taken from the checks that enforce the authority today, not from what the shape of the
// permission suggests it ought to mean:
//
//   leave.approve     src/lib/hr-leave.ts decideLeave -> approverRole() (hr-wallet.ts:189);
//                     pendingLeaveForApprover() seesAll (hr-leave.ts:106);
//                     /admin/hr/leave gate canAccessSection('leave','edit') and ROLE_SECTIONS below.
//   payouts.approve   src/lib/hr-wallet.ts decideWithdrawal -> approverRole();
//                     pendingWithdrawalsForApprover() seesAll (hr-wallet.ts:163);
//                     /admin/hr/wallet gate canAccessSection('payouts','edit').
//   payouts.pay       src/lib/hr-wallet.ts payWithdrawal, which used to narrow approverRole()'s
//                     answer to 'admin' | 'super_admin' | 'hr_head' — a reporting manager may
//                     APPROVE a withdrawal and may NOT release the money. Two keys, because it is
//                     two powers; payWithdrawal now asks for this one directly.
//   employee.manage   src/lib/auth/workspace-access.ts requireHr(); /admin/hr isHrDesk;
//                     /admin/hr/completion/[id] isHrDesk; middleware gates /admin/hr/employees on
//                     the 'employees' section, which only `hr` holds in ROLE_SECTIONS.
//                     (Spelled `employees.manage` until this commit. Same two roles, new spelling.)
//   department.lead   src/lib/auth/workspace-access.ts requireTeamLead() (role must be exactly
//                     'department_head'); src/lib/workforce/composer.ts leadsDepartment.
//
// THE 'admin' ARM IN THOSE CHECKS IS DEAD and is deliberately not reproduced here. 'admin' is not a
// value of userRoleEnum (src/lib/db/schema.ts:10-16), so no account can hold it and no grant can
// correspond to it. Dropping a dead arm removes nothing from anybody.
//
// TWO AUTHORITIES DELIBERATELY NOT EXPRESSED AS ROLE GRANTS, because they are not role-shaped:
//
//   1. THE REPORTING MANAGER. approverRole() returns 'reporting_manager' when
//      hr_employees.reporting_manager_id equals the user's id. That is a RELATIONSHIP to one
//      employee, not a role, and it is per-row: the same person may decide Ravi's leave and not
//      Priya's. A role grant cannot say that, so any conversion of approverRole() must keep that
//      arm as the row-level check it already is. Granting leave.approve to a role in order to
//      "cover managers" would hand every manager authority over every employee — a policy change,
//      and the widest one available here.
//   2. SUPER_ADMIN IS NOT A TEAM LEAD. requireTeamLead() refuses super_admin today, so
//      department.lead is granted to department_head ONLY. It is a SCOPING signal (which department
//      am I confined to), not a rank, and adding it to super_admin would confine the founder to one
//      department rather than widen anything.
//
// CUSTOM ROLES ARE A THIRD PATH THIS MATRIX CANNOT SEE. /admin/hr/leave and /admin/hr/wallet gate on
// canAccessSection(), which honours a custom role holding the 'leave'/'payouts' section — and the
// registry resolves those rows as `leave.edit` / `payouts.edit`, NEVER as `leave.approve`. So a
// conversion that swaps canAccessSection() for a bare can(..., 'leave.approve') would REMOVE access
// from every custom role that has it today. Convert by accepting either, or by granting the new key
// to those roles first and verifying it landed.
//
// ---------------------------------------------------------------------------------------------
// WHY department.lead IS STILL HERE, against an instruction to delete it.
//
// The ruling was right about the architecture: Team Lead and Department Head are ORGANISATIONAL
// RELATIONSHIPS, not RBAC permissions, and a capability that encodes a relationship is a category
// error — "leads one department" must never be spelled the same way as "may administer departments",
// because the second is a permission a person holds and the first is a fact about one row.
//
// It cannot be carried out yet, because THE ORGANISATIONAL DATA DOES NOT EXIST. requireTeamLead()
// must resolve "is this user the assigned head of THIS department" from org data. There is no such
// column anywhere: `departments` in src/lib/db/schema.ts:80-90 is (id, name, icon, ...) and in
// db/hr-schema.sql:31-38 is (id, name, code, description, is_active, created_at). Neither carries a
// head. hr_employees.reporting_manager_id is declared at db/hr-schema.sql:55 and written by zero
// lines of application code. The ONLY signal in the product is the pair
// users.role = 'department_head' + users.assigned_department_id, written together by /admin/users —
// and the leadership half of that pair is a role name, which is exactly what may not be asked.
//
// So every available way to remove this key changes who may open a team-lead surface:
//   - drop the check                -> every signed-in account with an assigned department becomes a
//                                      team lead. The widest change available in this file.
//   - resolve from `departments`    -> the column does not exist, so requireTeamLead() denies
//                                      EVERYONE, including the department heads it exists for.
//   - substitute department.manage  -> explicitly forbidden by the ruling, and it would mean that
//                                      administering departments confers leading one.
//
// THE GOVERNING RULE DECIDES IT: a conversion that gives or removes access for any role does not
// ship, it gets reported. So the key stays exactly as it is, held by department_head and by nobody
// else, and the three call sites (workspace-access.ts lookupWorkspace/requireTeamLead,
// workforce/composer.ts leadsDepartment) are untouched.
//
// RECOMMENDED ARCHITECTURE, for approval: add `departments.head_user_id UUID REFERENCES users(id)`
// via ADD COLUMN IF NOT EXISTS inside an ensureOnce() (no migrations exist on this project),
// backfill it from the existing (role='department_head', assigned_department_id) pairs so nobody
// loses access on the deploy, give /admin/departments a field to set it, then rewrite
// requireTeamLead() to ask "does departments.head_user_id = this user, for the department being
// asked about" and delete department.lead in the same change. That sequence keeps the population
// identical at every step, which is the only way this key can leave without an outage.
//
// ---------------------------------------------------------------------------------------------
// TWO NAMES CHOSEN OVER THE ONES THE AUDIT ASKED FOR, so the vocabulary stays single-valued.
//
//   tests.restricted.view -> tests_restricted.view
//     `tests_restricted` is ALREADY a section key in src/lib/admin-sections.ts:57, labelled
//     "Restricted Exams" with the hint "Designated-authority only" — the same authority, already
//     spelled, already seeded into permission_catalogue as tests_restricted.view/.edit/.delete/
//     .export by seedCatalogueRows(). Adding `tests.restricted.view` beside it would be two names
//     for one power, which is the drift this sprint exists to remove. Collision with a
//     section-derived key is the NORM here, not an exception: users.view, roles.edit, content.edit,
//     events.view, products.edit, settings.edit, applications.score and audit.view are every one of
//     them both a union member and a section-derived key.
//
//   employees.manage -> employee.manage
//     The canonical vocabulary is singular for people keys. Identical grant set.
//
// AND TWO KEPT SEPARATE THAT LOOK LIKE DUPLICATES BUT ARE NOT:
//   lessons.author / lessons.publish — same ten roles today, two different powers, split on the
//     exact precedent of payouts.approve / payouts.pay above: approving a withdrawal and releasing
//     the money are held by the same people and are still two keys, so that a future grant can
//     separate them without a code change. Nine call sites, two keys — not a key per call site.
//   lessons.author / interviews.author — writing teaching material and writing the questions a
//     candidate is judged on are different business actions on different surfaces.
//
// ---------------------------------------------------------------------------------------------
// HOW THE SIXTEEN NEW GRANTS BELOW WERE DERIVED. Every one from READING the call site.
//
//   `role !== 'applicant'` at the call site -> granted to all TEN non-applicant built-in roles:
//     mail.manage              src/pages/api/mail/{imap-poll:46,56, verify:19, imap-test:18,
//                              test:20, dns-check:43}
//     lessons.publish          src/pages/api/aquintutor/lessons/[id]/publish.ts:8
//     lessons.author           lesson-blocks/{index:8, reorder:8, [id]:8+21, upload:33};
//                              lessons/[id]/{meta:9, versions:9+20, request-review:8};
//                              courses/[id]/labs.ts:9+19
//     interviews.author        src/pages/api/aquintutor/interview/generate-from-doc.ts:30
//     jobs.run                 src/pages/api/aquintutor/{league-settle.ts:111, streak-nudge.ts:95}
//                              (each ALSO accepts CRON_SECRET — a separate arm, not a role)
//     research.restricted.view src/middleware.ts:230, where only `applicant` is asked for an
//                              approved visvambhara_access_requests row and every other role passes
//                              unchecked. The applicant arm is a ROW, not a role, and must stay.
//
//   `role === 'super_admin'` at the call site -> granted to super_admin ONLY:
//     profiles.manage          src/pages/admin/profiles/index.astro:8, [userId].astro:7
//     resumes.view             src/pages/admin/resumes/index.astro:8, [id].astro:7
//     reports.export           SPLIT OUT of resumes.view, not derived from a new call site. The
//                              ?export=csv arm of /admin/resumes/index.astro now asks for
//                              resumes.view AND this; every other arm of that page is untouched.
//                              Same single holder (super_admin), so the export population is
//                              identical before and after — the split narrows what a FUTURE grant of
//                              resumes.view would hand over, not what anybody holds today.
//     credits.grant            src/pages/admin/credits.astro:9 (the `'admin'` arm is DEAD — 'admin'
//                              is not a value of userRoleEnum, so no account can hold it)
//     payments.retry           src/pages/admin/paid-stuck.astro:8 (same dead arm, in array form)
//     locations.view           src/lib/applicant-location.ts:427
//
//   Everything else, one at a time:
//     payroll.manage           /admin/hr/payroll/index.astro:10 lists ['super_admin','hr'] literally
//                              -> those two. A custom role holding the `payroll` section passes
//                              middleware.ts:59 and is then refused by that line, so it has no access
//                              today and must gain none: convert with can(), never
//                              canAccessSection('payroll','edit'), which would ADD it.
//     tests_restricted.view    /admin/tests/[id].astro:25 reads super_admin || hr — but `hr` does not
//                              hold the 'tests' section in ROLE_SECTIONS, so middleware redirects hr
//                              BEFORE that line runs. Observed population is super_admin alone, and
//                              that is what is granted. Reproducing the dead `hr` arm as a grant
//                              would hand hr a question bank it cannot reach today.
//     safety.respond           /admin/sos.astro has NO role check and no PATH_SECTION entry, so
//                              canOpenAdmin() alone stands in front of live staff GPS. NOT
//                              population-preserving: see the loud note on the grant itself.
//     requisitions.approve     src/lib/hr-requisition.ts:86 checks NOBODY. No rule to preserve.
//     community.moderate       src/lib/moderation.ts:78 checks NOBODY. No rule to preserve.
// ---------------------------------------------------------------------------------------------
/**
 * The six keys that replace a `role !== 'applicant'` test, written ONCE and spread into all ten
 * non-applicant roles below.
 *
 * Declared here rather than typed out ten times because ten hand-maintained copies of one population
 * is ten chances for them to disagree, and "these six keys are held by exactly the same people" is
 * the fact that makes the conversions safe. Declared ABOVE PERMS_BY_ROLE because `const` is not
 * hoisted and a later declaration has taken pages down on this project.
 *
 * Deliberately NOT granted to `applicant`, which is the entire content of the test being replaced.
 */
const INTERNAL_ROLE_KEYS: Permission[] = [
  'mail.manage',
  'lessons.author', 'lessons.publish',
  'interviews.author',
  'jobs.run',
  'research.restricted.view',
];

export const PERMS_BY_ROLE: Record<User['role'], Permission[]> = {
  super_admin: [
    'admin.access',
    'roles.view', 'roles.edit',
    'applications.view', 'applications.edit', 'applications.score',
    'events.view', 'events.edit',
    'products.view', 'products.edit',
    'content.view', 'content.edit',
    'users.view', 'users.edit',
    'settings.view', 'settings.edit',
    'offers.view', 'offers.edit',
    'payments.view', 'payments.refund',
    // Already holds every one of these: approverRole() answers 'super_admin' first, and
    // getViewableSectionKeys()/canAccessSection() return "unrestricted" for this role. Not
    // 'department.lead' — requireTeamLead() refuses super_admin today and that must not move.
    'leave.approve', 'payouts.approve', 'payouts.pay', 'employee.manage',
    'audit.view',
    ...INTERNAL_ROLE_KEYS,
    // THE super_admin CLUSTER. Each of these is granted here and NOWHERE ELSE, because each replaces
    // a literal `user.role !== 'super_admin'` redirect. There is no WILDCARD in can() — an omission
    // here answers false for the founder and closes the surface to everybody.
    'profiles.manage', 'resumes.view', 'credits.grant', 'payments.retry', 'locations.view',
    // BULK EXPORT — split out of resumes.view, granted to the SAME single role that could already
    // reach /admin/resumes?export=csv. Before: super_admin (via resumes.view), nobody else. After:
    // super_admin, nobody else. Every other role's export set is unchanged at empty. Adding it to a
    // second role here would be a widening, and it is the one edit to this line that must not be made
    // without a decision on the record.
    'reports.export',
    // /admin/hr/payroll lists ['super_admin','hr'] literally.
    'payroll.manage',
    // EXPENSE, TRAVEL AND ADVANCE CLAIMS — a read of the whole queue, and no authority to decide one.
    // No prior population to preserve: there was no claim table before src/lib/expenses.ts.
    'expenses.review',
    // /admin/tests/[id] admits super_admin || hr, but hr never reaches the line (no 'tests' section).
    'tests_restricted.view',
    // NOT population-preserving, and granted narrowly on purpose — see the note on `hr` below.
    'safety.respond',
    // NO RULE EXISTS TO PRESERVE at either call site. Granted to the narrowest defensible holder and
    // reported: enforcing them is a policy decision, and neither call site may be converted until a
    // human has made it.
    'requisitions.approve', 'community.moderate',
    // PROCUREMENT. A read of the purchasing record, and the authority to commit an ALREADY-APPROVED
    // request to a supplier. Neither decides an approval — routing does that, per request, from the
    // Organization Graph. No prior population to preserve: there was no purchasing module.
    'procurement.view', 'procurement.manage',
    // WORKPLACE SERVICES. No prior authority to preserve - there was no helpdesk, no asset
    // register and no document library anywhere in this codebase. Granted to the narrowest
    // defensible holder, and enforced at every call site from day one.
    'helpdesk.manage', 'assets.manage', 'documents.manage',
    // WORKING TIME AND AGGREGATE REPORTING. Narrowest defensible holders, matching whoever already
    // administers attendance and whoever already reads every employee record one at a time. Neither
    // key approves anything: an attendance correction routes per row from the Organization Graph.
    'attendance.roster.manage', 'analytics.view',
    // REFERRALS. Matched to the holders of applications.view and payouts.approve respectively — see
    // the derivation above the union. Neither key approves a payment.
    'referrals.view', 'referrals.reward',
    // PERFORMANCE, SKILLS AND LEARNING. These three were DOCUMENTED as "granted to super_admin + hr"
    // in four places — the union comment above, and the gate headers of /admin/hr/performance/cycles,
    // /skills and /learning — but were listed under `hr` alone. can() reads PERMS_BY_ROLE and has no
    // wildcard branch for super_admin, so the founder was refused every write on all three consoles:
    // the page opened (admin.access passes) and then every save redirected back with the "you do not
    // hold this desk" panel. Adding them here makes the code match the population every one of those
    // comments already claims. Nobody but super_admin gains anything, and super_admin is unrestricted
    // in the section filter these pages also sit behind.
    'performance.manage', 'skills.manage', 'learning.assign'
  ],
  hr: [
    'admin.access',
    'roles.view', 'roles.edit',
    'applications.view', 'applications.edit', 'applications.score',
    'events.view', 'events.edit',
    // HR issues the offer letters, so HR answers the verifications that come back against them.
    'offers.view', 'offers.edit',
    // /admin/finance has been super_admin + hr since it was written; the refund buttons on it are
    // HR's. Recorded here so the endpoint can ask for the ability instead of for the role name.
    'payments.view', 'payments.refund',
    // The exact role 'hr' — never a substring — is what approverRole() reads as 'hr_head', what
    // pendingLeaveForApprover()/pendingWithdrawalsForApprover() treat as "sees every request", what
    // payWithdrawal() accepts for releasing money, and what requireHr() and isHrDesk admit. It is
    // also the only built-in role carrying 'leave', 'payouts', 'employees' and 'hr' in ROLE_SECTIONS
    // below, which is what the middleware and both page gates actually enforce. Same four abilities,
    // named instead of spelled.
    'leave.approve', 'payouts.approve', 'payouts.pay', 'employee.manage',
    'content.view',
    ...INTERNAL_ROLE_KEYS,
    // /admin/hr/payroll/index.astro:10 names 'hr' in its literal list, and `hr` is the only built-in
    // role holding the 'payroll' section in ROLE_SECTIONS, so it reaches the page and passes the
    // line. Exact population, named instead of spelled.
    'payroll.manage',
    // The claims queue. Same reasoning as the super_admin grant above: HR already sees every salary
    // and already decides every withdrawal on /admin/hr/wallet, so a read of the claim queue adds no
    // reach they do not have. It still confers no approval — routing decides that, per claim.
    'expenses.review',
    // NOT POPULATION-PRESERVING, AND THE ONLY GRANT IN THIS FILE THAT ISN'T. /admin/sos.astro has no
    // role check at all (its only test is `if (!user)`) and no PATH_SECTION entry, so TODAY every
    // admin-capable role reaches it: super_admin, hr, recruiter, reviewer, department_head,
    // marketing, editor, plus any custom role granted admin.access. Behind it are the names, emails
    // and LIVE GPS coordinates of every account seen in the last ten minutes, and a POST that closes
    // somebody else's emergency. `marketing` and `editor` are the roles the 2026 offer-signing
    // promotion handed to interns.
    //
    // Reproducing that population would be recording an accident as a policy. Narrowing it is a
    // POLICY DECISION A HUMAN MUST MAKE, so the key is granted to the narrowest defensible holders —
    // super_admin and hr — and /admin/sos.astro IS NOT CONVERTED in this commit. Converting it would
    // remove recruiter, reviewer, department_head, marketing, editor and every custom admin.access
    // role from an emergency screen. Get that approved first; the grant is ready and inert until
    // then.
    'safety.respond',
    // `hr` is the only built-in role holding the 'hr' and 'training' sections in ROLE_SECTIONS, so it
    // is the only non-super_admin role that reaches /admin/hr/performance and /admin/hr/training
    // today. Exact population, named instead of spelled — nobody gains and nobody loses.
    'performance.manage', 'skills.manage', 'learning.assign',
    // PROCUREMENT. `hr` is the only built-in role below super_admin holding the `finance` and
    // `payouts` sections in ROLE_SECTIONS, and /admin/finance has been super_admin + hr since it was
    // written — so the people who already handle company money handle the purchasing record too.
    // The console accepts EITHER this key or the `finance` section, so no custom role that can open
    // /admin/finance today is shut out of the purchasing console tomorrow.
    'procurement.view', 'procurement.manage',
    // WORKPLACE SERVICES. The people desk already answers, informally, the questions these
    // three modules formalise - who is holding which laptop, what the joining paperwork says,
    // and whatever an employee could not raise with their own manager. `hr` is also the only
    // built-in role holding the matching 'helpdesk' and 'assets' sections in ROLE_SECTIONS
    // below, so the sidebar, the page gate and the capability admit exactly the same accounts.
    'helpdesk.manage', 'assets.manage', 'documents.manage',
    // WORKING TIME AND AGGREGATE REPORTING. `hr` is the only built-in role holding the `attendance`
    // section in ROLE_SECTIONS below, so it is already the role that administers attendance; and it
    // holds employee.manage, so it can already read every employee record one at a time. Both keys
    // record authority this role has in substance today. Neither puts anybody on an approval route.
    'attendance.roster.manage', 'analytics.view',
    // REFERRALS. `hr` holds payouts.approve, so it holds referrals.reward: putting a number on a
    // referral bonus is the same class of act as approving a withdrawal, and the same two accounts
    // already do it. It still approves nothing — the reward routes through the workflow engine.
    'referrals.view', 'referrals.reward'
  ],
  recruiter: [
    'admin.access',
    'roles.view',
    'applications.view', 'applications.edit', 'applications.score',
    // A recruiter can see who is checking a candidate's letter, but answering on the record is
    // HR's call — read-only here.
    'offers.view',
    // The referral programme is a view of the hiring pipeline from the employee end, holding the
    // same class of candidate detail this role already reads on /admin/applications. NOT
    // 'referrals.reward': a recruiter may see the programme and may not price it.
    'referrals.view',
    ...INTERNAL_ROLE_KEYS
  ],
  reviewer: [
    'admin.access',
    'roles.view',
    'applications.view', 'applications.score',
    // Same reasoning as recruiter, one step narrower: a reviewer already opens the full application
    // of anybody in this list, so hiding the referral that produced it would be a distinction
    // without a difference. No reward authority.
    'referrals.view',
    ...INTERNAL_ROLE_KEYS
  ],
  department_head: [
    'admin.access',
    'roles.view', 'roles.edit',
    'applications.view', 'applications.edit', 'applications.score',
    // The ONLY holder of this key, and the only role requireTeamLead() admits. It grants no approval
    // authority: department_head holds no HR section in ROLE_SECTIONS and approverRole() returns
    // nothing for it, so a department head can decide a request today only by being that employee's
    // reporting manager — a row-level fact this matrix cannot and must not encode.
    //
    // NOT a licence to see the department either. composer.ts adds `engagement !== 'internship'`
    // and requireTeamLead() refuses an intern record outright; both conditions are per-PERSON, they
    // survive this grant, and a conversion must keep them.
    'department.lead',
    // Holds applications.view, so it holds this: a department head reads the applications for their
    // own hiring and the referral console is the same pipeline seen from the employee end.
    'referrals.view',
    ...INTERNAL_ROLE_KEYS
  ],
  marketing: [
    'admin.access',
    'content.view', 'content.edit',
    'events.view', 'events.edit',
    'products.view', 'products.edit',
    ...INTERNAL_ROLE_KEYS
  ],
  editor: [
    'admin.access',
    'roles.view',
    'events.view', 'events.edit',
    'products.view', 'products.edit',
    'content.view', 'content.edit',
    ...INTERNAL_ROLE_KEYS
  ],
  // The only role that holds nothing, and the only one every key above is withheld from. This empty
  // array is the whole meaning of the `role !== 'applicant'` tests being replaced.
  applicant: [],
  // AquinTutor-scoped roles hold NO main-admin permission (no admin.access), so
  // the middleware confines them to /aquintutor/admin. Their abilities live in
  // their own panels (partner = host courses, teacher = author, moderator = review).
  //
  // THEY ARE NO LONGER EMPTY, AND THAT IS NOT A WIDENING. Every key added here is one these three
  // roles ALREADY pass today, because the check at the call site is `role !== 'applicant'` and they
  // are not applicants — including the lesson-authoring cluster, which is the surface they exist
  // for, and mail.manage and jobs.run, which they should almost certainly not hold. Writing the
  // grants down is what makes that second fact reviewable instead of invisible; taking it away is a
  // policy change and is reported rather than made here.
  //
  // None of these keys is admin.access, so src/middleware.ts still bounces all three off /admin,
  // canOpenAdmin() still refuses them, and ROLE_SECTIONS still gives them no section at all.
  partner: [...INTERNAL_ROLE_KEYS],
  teacher: [...INTERNAL_ROLE_KEYS],
  technical_moderator: [...INTERNAL_ROLE_KEYS]
};

export function can(user: User | null, perm: Permission): boolean {
  if (!user || !user.isActive) return false;
  // Roles not in the matrix (e.g. a partner/teacher scope) get NO built-in
  // permissions — they are confined to their own panel, never the main admin.
  return (PERMS_BY_ROLE[user.role] || []).includes(perm);
}

export function requireAdmin(user: User | null): User {
  if (!user || !can(user, 'admin.access')) {
    throw new Error('UNAUTHORIZED');
  }
  return user;
}

// Helper: human-readable role labels
export const ROLE_LABELS: Record<User['role'], string> = {
  super_admin: 'Super Admin',
  hr: 'HR',
  recruiter: 'Recruiter',
  reviewer: 'Reviewer',
  department_head: 'Department Head',
  marketing: 'Marketing',
  editor: 'Editor',
  applicant: 'Applicant',
  partner: 'AquinTutor Partner',
  teacher: 'AquinTutor Teacher',
  technical_moderator: 'AquinTutor Moderator'
};

// Roles that need a department assignment
export const DEPARTMENT_SCOPED_ROLES: User['role'][] = ['department_head', 'reviewer', 'recruiter'];

// =========================================================================
// Dynamic role system (additive)
// =========================================================================
// Custom roles created via /admin/team/roles. Used alongside the hardcoded
// PERMS_BY_ROLE matrix above. Existing pages keep using can(); new pages
// can opt into userCanAccess() for fine-grained, admin-configurable perms.

import { db } from '@/lib/db';
import { userRoleAssignments, rolePermissions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

export type PermissionAction = 'view' | 'edit' | 'delete' | 'export';

/**
 * Returns true if the user has ANY custom role granting the specified action on the page.
 * If user has no custom roles, returns false (caller can fall through to legacy can()).
 */
export async function userCanAccess(userId: string, pageKey: string, action: PermissionAction): Promise<boolean> {
  const userRolesRows = await db.select({ roleId: userRoleAssignments.roleId })
    .from(userRoleAssignments)
    .where(eq(userRoleAssignments.userId, userId));
  if (userRolesRows.length === 0) return false;

  const roleIds = userRolesRows.map(r => r.roleId);
  const perms = await db.select().from(rolePermissions)
    .where(and(inArray(rolePermissions.roleId, roleIds), eq(rolePermissions.pageKey, pageKey)));

  for (const p of perms) {
    if (action === 'view' && p.canView) return true;
    if (action === 'edit' && p.canEdit) return true;
    if (action === 'delete' && p.canDelete) return true;
    if (action === 'export' && p.canExport) return true;
  }
  return false;
}

// Default section access per built-in role (used when a user has NO custom role
// assigned). super_admin is unrestricted. Keys come from src/lib/admin-sections.ts.
const ROLE_SECTIONS: Record<string, string[]> = {
  hr: [
    'dashboard', 'applications', 'offers', 'messages', 'dms', 'discussion',
    'hr', 'employees', 'leave', 'attendance', 'payroll', 'payouts', 'training', 'finance',
    'helpdesk', 'assets',
    'roles', 'departments', 'interviews', 'interviews_manual', 'interviews_ai',
    'events', 'content', 'custom_offer',
  ],
  recruiter: [
    'dashboard', 'applications', 'offers', 'messages', 'dms',
    'roles', 'interviews', 'interviews_manual', 'interviews_ai',
    'tests', 'tests_proctoring', 'custom_offer',
  ],
  reviewer: [
    'dashboard', 'applications', 'interviews', 'interviews_manual', 'interviews_ai',
    'tests', 'tests_proctoring',
  ],
  department_head: [
    'dashboard', 'applications', 'offers', 'roles',
    'interviews', 'interviews_manual', 'interviews_ai', 'custom_offer',
  ],
  marketing: [
    'dashboard', 'content', 'products', 'events',
    'hei_institutions', 'hei_stories',
  ],
  editor: [
    'dashboard', 'content', 'products', 'events', 'lms', 'custom_offer',
  ],
  applicant: [],
  // These three were ABSENT from this map, and absence means "no section filtering" — so if any of
  // them ever reached the admin sidebar they would have seen all 108 entries, the widest view in the
  // product, purely because nobody had written a line for them. They are confined to
  // /aquintutor/admin by canOpenAdmin() and the middleware, so this was latent rather than live,
  // but a gap that depends on a separate guard never being changed is not a gap worth keeping.
  //
  // /admin/access-preview surfaced it. That is what the page is for: an unrestricted role reads as
  // "108 entries" on screen instead of hiding in an omission nobody would grep for.
  //
  // Empty means empty. Their abilities live in their own panels, never the main admin.
  partner: [],
  teacher: [],
  technical_moderator: [],
};

/**
 * The section keys a BUILT-IN role gets when the person has no custom role assigned — the tail of
 * getViewableSectionKeys(), lifted out so it can be answered for a role rather than for a person.
 * Pure: no database, no session, safe to call for every role at once (/admin/access-preview does).
 *
 * null means "no section filtering", which covers two different situations and the caller must not
 * confuse them: super_admin (unrestricted on purpose) and a role with NO entry in ROLE_SECTIONS
 * (unrestricted by omission — for partner/teacher/technical_moderator the thing actually keeping
 * them out of the admin panel is lacking admin.access, not this filter).
 */
export function defaultSectionKeysForRole(role: string): Set<string> | null {
  if (role === 'super_admin') return null;
  const defaults = ROLE_SECTIONS[role];
  if (!defaults) return null; // unknown role -> don't restrict
  return new Set<string>(defaults);
}

/**
 * Returns the set of admin section keys this user may VIEW, used to filter the
 * sidebar (and enforce in middleware) so people only see pages they can open.
 *   - super_admin            -> null  (means "everything", no filtering)
 *   - has >=1 custom role    -> exactly the granted view page-keys (+ dashboard)
 *   - else built-in role     -> that role's default section set (ROLE_SECTIONS)
 * Custom-role assignment is the precise override; built-in roles get sane
 * defaults so a Marketing/Recruiter/etc. account no longer sees every tab.
 */
export async function getViewableSectionKeys(user: { id: string; role: string } | null): Promise<Set<string> | null> {
  if (!user) return new Set();
  if (user.role === 'super_admin') return null;
  const assigns = await db.select({ roleId: userRoleAssignments.roleId })
    .from(userRoleAssignments)
    .where(eq(userRoleAssignments.userId, user.id));
  if (assigns.length > 0) {
    const roleIds = assigns.map(r => r.roleId);
    const perms = await db.select({ pageKey: rolePermissions.pageKey, canView: rolePermissions.canView })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, roleIds));
    const set = new Set<string>(['dashboard']);
    for (const p of perms) if (p.canView) set.add(p.pageKey);
    return set;
  }
  return defaultSectionKeysForRole(user.role);
}

/**
 * Authorise ONE action on ONE admin section — the check to use in API routes and page POST
 * handlers, so a URL cannot do what the sidebar would not offer.
 *
 * Use this rather than `userCanAccess`, which consults ONLY custom role assignments and so
 * returns false for a super_admin (who typically has none) — that silently locks out the very
 * people a feature is built for. And never use `user.role !== 'applicant'` as an authorisation
 * test: every internal role passes it, including the `editor` that offer letters auto-assign to
 * candidates who have not yet accepted.
 *
 *   super_admin           -> allowed
 *   >=1 custom role       -> exactly what those roles grant for this page key + action
 *   else built-in role    -> that role's ROLE_SECTIONS defaults (a granted section implies
 *                            view/edit/export on it; delete stays super_admin-only)
 *   unknown role          -> DENIED (deny by default; the sidebar filter's "don't restrict"
 *                            fallback is not a safe answer for a write or a bulk export)
 */
export async function canAccessSection(
  user: { id: string; role: string } | null | undefined,
  sectionKey: string,
  action: PermissionAction = 'view',
): Promise<boolean> {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (user.role === 'applicant') return false;

  try {
    const assigns = await db.select({ roleId: userRoleAssignments.roleId })
      .from(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, user.id));
    if (assigns.length > 0) {
      return await userCanAccess(user.id, sectionKey, action);
    }
  } catch { return false; }

  const defaults = ROLE_SECTIONS[user.role];
  if (!defaults) return false;
  if (!defaults.includes(sectionKey)) return false;
  return action !== 'delete';
}

/** Standard page-key constants. Use these instead of hardcoding strings. */
export const PAGE_KEYS = {
  DASHBOARD: 'dashboard',
  APPLICATIONS: 'applications',
  MESSAGES: 'messages',
  OFFERS: 'offers',
  USERS: 'users',
  ROLES: 'roles',
  DEPARTMENTS: 'departments',
  EVENTS: 'events',
  PRODUCTS: 'products',
  CONTENT: 'content',
  AUDIT: 'audit',
  SETTINGS: 'settings',
  HEI_INSTITUTIONS: 'hei_institutions',
  HEI_ENTITY_TYPES: 'hei_entity_types',
  HEI_IMPORT: 'hei_import',
  HEI_SUBMETRICS: 'hei_submetrics',
  HEI_V1: 'hei_v1',
  HEI_STORIES: 'hei_stories',
  HEI_CLAIMS: 'hei_claims',
  HEI_SUBMISSIONS: 'hei_submissions',
  HEI_FINDINGS: 'hei_findings',
  TEAM_ROLES: 'team_roles'
} as const;

export type PageKey = typeof PAGE_KEYS[keyof typeof PAGE_KEYS];
