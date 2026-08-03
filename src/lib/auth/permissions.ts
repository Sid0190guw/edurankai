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
  | 'payroll.manage'
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
  | 'community.moderate';

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
    // /admin/tests/[id] admits super_admin || hr, but hr never reaches the line (no 'tests' section).
    'tests_restricted.view',
    // NOT population-preserving, and granted narrowly on purpose — see the note on `hr` below.
    'safety.respond',
    // NO RULE EXISTS TO PRESERVE at either call site. Granted to the narrowest defensible holder and
    // reported: enforcing them is a policy decision, and neither call site may be converted until a
    // human has made it.
    'requisitions.approve', 'community.moderate'
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
    'safety.respond'
  ],
  recruiter: [
    'admin.access',
    'roles.view',
    'applications.view', 'applications.edit', 'applications.score',
    // A recruiter can see who is checking a candidate's letter, but answering on the record is
    // HR's call — read-only here.
    'offers.view',
    ...INTERNAL_ROLE_KEYS
  ],
  reviewer: [
    'admin.access',
    'roles.view',
    'applications.view', 'applications.score',
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
