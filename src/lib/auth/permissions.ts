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
  // INVOICES — money we are owed, and money we owe. Three keys, and NOT ONE OF THEM APPROVES
  // ANYTHING.
  //
  // Paying a supplier bill requires an APPROVED workflow instance, routed per ROW from the
  // Organization Graph for the employee whose purchase caused it: their reporting manager, their
  // department head, the procurement approval owner, and an executive sponsor at or above the amount
  // declared on that chain. src/lib/invoices.ts reads that decision from the engine at the moment of
  // the write and refuses everything else. Holding `invoices.pay` means "may record that an approved
  // payment moved"; it puts nobody on an approval route and cannot approve a bill for itself.
  //
  //   invoices.view    open the invoicing console: what we have billed, what has been billed to us,
  //                    what is outstanding, what is overdue, and the printable document.
  //   invoices.manage  raise, price and issue an invoice, record a supplier bill against a purchase
  //                    request, configure the numbering series and the tax components, and VOID an
  //                    invoice with a reason. There is no delete anywhere in that module.
  //   invoices.pay     record a payment against an invoice — for a bill somebody sent us, only once
  //                    the workflow engine says the payment was approved.
  //
  // SPLIT ON THE EXACT PRECEDENT OF payouts.approve / payouts.pay and procurement.view /
  // procurement.manage: the same two roles hold all three today, and they stay three keys so a future
  // grant can separate reading the ledger from raising a document from moving money without a code
  // change.
  //
  // GRANTED TO super_admin AND hr — the population holding the equivalent authority TODAY.
  // /admin/finance has been super_admin + hr since it was written, `hr` is the only built-in role
  // below super_admin carrying `finance` and `payouts` in ROLE_SECTIONS, and those same two hold
  // procurement.view/manage and payouts.pay. This records the population the product already has; it
  // invents no wider one.
  //
  // THE CONSOLE ALSO ACCEPTS canAccessSection(user, 'finance', 'edit'), for the reason
  // /admin/procurement and /admin/hr/leave/workflow both state: a CUSTOM role holding the finance
  // section resolves through the registry as `finance.edit` and NEVER as `invoices.view`, so gating
  // on the capability alone would shut out every custom role that can open /admin/finance today.
  // =============================================================================================
  | 'invoices.view' | 'invoices.manage' | 'invoices.pay'
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
  // WRITING THE STAFF HANDBOOK (src/lib/knowledge-base.ts): create an article or a policy, edit one,
  // publish a version, archive one, and read the acknowledgement record for a policy.
  //
  // ONE KEY, FOR WRITING ONLY. Reading is NOT gated on it and must never be: an article carries an
  // `audience`, and a restricted article names the capability that unlocks it, applied in the WHERE
  // clause of every read. So "who may read the interview-scoring guidance" is answered by the
  // interviewing capability the article itself names, not by a second permission here — which is why
  // there is no `knowledge.view`. Minting one would create two ways to answer the same question and
  // they would disagree within a release.
  //
  // WHY NOT `documents.manage`. That key curates the LINK LIBRARY: folders, retention and sharing of
  // Google Drive links to files that live elsewhere. This one writes TEXT that lives in this database,
  // is searched, is versioned, and can be acknowledged. Reusing the documents key would hand the power
  // to rewrite the leave policy to whoever was made a librarian, and would make either grant
  // impossible to narrow later without moving the other.
  //
  // POPULATION: super_admin + hr — exactly the holders of `helpdesk.manage` and `documents.manage`,
  // the two adjacent workplace-services keys, and the people who answer these questions by hand today.
  // Nobody gains sight of anything: an article is written to be read, and publishing is the act this
  // key controls.
  //
  // WHAT IT DOES NOT BUY: reading a restricted article whose capability the holder does not have. A
  // knowledge manager can PUBLISH an article restricted to `payroll.manage` and, without that key,
  // cannot open it afterwards. That is deliberate — the audience is a property of the article, not a
  // privilege of the author.
  | 'knowledge.manage'
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
  | 'learning.assign'
  // Record a VERIFICATION against anybody's record, with no relationship: say that a stated claim
  // was checked, name what it was checked against, and sign it. See src/lib/provenance.ts, which is
  // the only place assertion = 'verified' comes into existence. A manager, a mentor or a reviewer
  // verifies their own people through the Organization Graph, per row, and needs none of this; this
  // is the organization-wide desk. It is SENSITIVE because the whole product treats a verified
  // element as something a decision may rest on, and an unverification is equally consequential.
  | 'provenance.verify'

  // =============================================================================================
  // LEARNING ADMINISTRATION. Four keys behind /admin/learning/*, and the derivation for each.
  //
  // WHAT IS DELIBERATELY NOT HERE. Creating, editing and publishing a course is ALREADY a
  // capability: `lessons.author` and `lessons.publish`, held by INTERNAL_ROLE_KEYS — every
  // non-applicant role — which is the exact population the four existing course editors admit with
  // their `user.role === 'applicant'` test. Adding a fifth key meaning the same thing would give one
  // authority two names, and the second name is the one nobody remembers to grant. The new catalogue
  // screen asks for those two.
  //
  // THE POPULATION FOR ALL FOUR BELOW is super_admin + hr: the holders of `learning.assign`, who are
  // the only accounts that reach /admin/hr/performance/learning today and the only ones that reach
  // /admin/hr/training through the `training` section in ROLE_SECTIONS. Nobody gains a surface they
  // could not already open; they gain actions that until now NOBODY could perform, because there was
  // no screen for them anywhere in this codebase.
  // =============================================================================================

  // Read the learning record: progress per person and per cohort, and one person from inside the
  // aggregate. A DEPARTMENT HEAD needs none of this to see their own department — that is a
  // `department_head` edge in the Organization Graph, resolved per ROW by userHeadedDepartmentIds().
  // This is the version that reaches the whole organization with no relationship at all.
  | 'learning.progress.view'
  // Record a completion by hand, and withdraw one. SENSITIVE: it is a statement about what a person
  // did, it outlives the platform, and until this build nothing in this repository could write
  // training_enrollments.completed_at at all.
  | 'learning.completion.override'
  // Issue a course certificate by hand, and withdraw one. SENSITIVE for the same reason, and more
  // so: a certificate is the artefact a person shows somebody else. Withdrawal is recorded as a
  // later fact rather than a deletion — course_certificates is a hash chain and removing a block
  // would break verification for every certificate issued after it.
  | 'learning.certificate.manage'
  // Configure what counts as complete for a course: lessons viewed, an assessment passed, or a mark
  // at or above a threshold. Not a statement about any one person, but it decides how everybody's
  // completion is computed, which is why it is a key of its own rather than folded into authoring.
  | 'learning.rules.manage'

  // =============================================================================================
  // PROJECTS. TWO KEYS, AND NEITHER OF THEM MAKES ANYBODY A PROJECT MANAGER.
  //
  // READ THIS BEFORE GRANTING EITHER. "Runs this project" is an ORGANISATIONAL RELATIONSHIP — the
  // `project_manager` edge in org_relationships, scoped to ONE project, effective-dated, resolved
  // per ROW by src/lib/org-graph.ts (isProjectManager / getManagedProjectIds / getProjectManager).
  // It is not spelled anywhere in this union and it must never be: a capability cannot say "this
  // project and not that one", so a key meaning "may run projects" would hand every holder authority
  // over every project in the company. That is the per-ROW-to-per-USER collapse this architecture
  // exists to prevent, and it is one careless grant away at all times.
  //
  // WHAT THE TWO KEYS ACTUALLY DO is therefore narrow, and org-wide by construction:
  //   projects.view    the PORTFOLIO read — every project, whether or not you are on it.
  //   projects.manage  the REGISTER write — create a project, change its definition, set its planned
  //                    budget, retire it, and record who runs it as a graph edge.
  //
  // A member needs NEITHER of these to work on their own project, and a project manager needs
  // NEITHER to run theirs: both are answered from the graph and from project_members. Somebody
  // holding no permission at all in this product still sees, and works, every project they are on.
  //
  // NO PRIOR POPULATION TO PRESERVE — there was no projects table, no project_id and no projects
  // module anywhere in src/ or db/ before this commit (src/lib/search-global.ts said so in words, and
  // src/lib/workforce/navigation.ts carried it in NAV_BACKLOG). So these follow the precedent set by
  // procurement.view / assets.manage: granted to the NARROWEST DEFENSIBLE HOLDERS, super_admin and
  // hr, and enforced at every call site from the first deploy. Nobody loses anything, because nobody
  // had anything.
  // =============================================================================================

  // Open the portfolio: every project in the organization, its dates, its owner, its members, its
  // milestones, its risk register and its budget variance. It grants no authority over any project
  // and puts the holder on no approval route.
  | 'projects.view'
  // Create a project, change its name, code, description, department, dates and status, set its
  // PLANNED budget, retire it, and record who runs it. Recording a project manager writes an
  // effective-dated edge into the Organization Graph; it does not make the holder that manager.
  | 'projects.manage'
  // =============================================================================================
  // ANNOUNCEMENTS AND RECOGNITION (src/lib/announcements.ts, src/lib/recognition.ts).
  //
  // TWO KEYS, AND NEITHER OF THEM APPROVES ANYTHING. There is no approval anywhere in either module
  // — publishing a notice is a standing authority, not a per-row routing question, so
  // src/lib/workflow.ts is deliberately not involved and holding either key puts nobody on an
  // approval route.
  //
  // WHAT IS NOT GATED, AND MUST NEVER BE:
  //
  //   READING AN ANNOUNCEMENT. Who sees a notice is decided by its AUDIENCE — company, one
  //   department, one project, one location — applied in the WHERE clause of every read against the
  //   reader's own employee record and project membership. There is deliberately no
  //   `announcements.view`: minting one would create a second way to answer "may I see this" and the
  //   two would disagree within a release. It would also lock out exactly the people notices are
  //   for, since an employee's account frequently carries the `applicant` role, which holds nothing.
  //
  //   SENDING RECOGNITION. Thanking a colleague requires no capability at all and none is checked.
  //   Gating it would make it a management instrument, and recognition that only flows downward is
  //   not recognition. An intern may thank the founder. The only rules are enforced in the write:
  //   not to yourself, and say what they actually did.
  //
  // NO PRIOR POPULATION TO PRESERVE, and that is a fact about this codebase rather than an
  // assumption: there was no announcements table anywhere in src, db or scripts before
  // src/lib/announcements.ts — src/lib/search-global.ts, src/lib/workforce/widgets.ts and
  // src/pages/portal/notifications.astro each said so in as many words — and no recognition table
  // either (cr_recognitions in src/lib/credential-store.ts records one INSTITUTION recognising
  // another's credentials: different domain, different columns). So the rule that applies is the one
  // requisitions.approve, community.moderate and the workplace-services keys were settled by: GRANT
  // TO THE NARROWEST DEFENSIBLE HOLDER AND WRITE DOWN WHY. That is super_admin + hr, the same two
  // who hold `knowledge.manage` — the adjacent key that already decides what the whole company is
  // asked to read — and both are ENFORCED at every call site from the day they ship.
  // =============================================================================================

  // WRITING AND PUBLISHING A COMPANY ANNOUNCEMENT: compose it, choose its audience, mark it urgent,
  // pin it, set the date it stops being shown, publish it, revise it, and take it down with a reason.
  //
  // IT ALSO OPENS THE ACKNOWLEDGEMENT RECORD, which is why this key matters more than "may post a
  // notice" suggests. An announcement can require acknowledgement, the acknowledgement is recorded
  // against a VERSION, and REVISING a published announcement re-opens it for everybody — so this key
  // decides what the whole company is asked to read and confirm. The record it opens NAMES the people
  // who have acknowledged (an act each of them deliberately performed) and reports the people who
  // have not as a COUNT. No query behind this key lists the names of people who have not read
  // something; that screen is a shame list and it does not exist.
  | 'announcements.publish'
  // TAKING DOWN SOMEBODY ELSE'S RECOGNITION, with a reason kept on the row. It is not a delete and
  // there is no delete: "somebody removed a thank-you about me" is a thing the person it was about is
  // entitled to have a record of.
  //
  // IT BUYS NO WIDER READ. A recognition sent to one team stays visible to that team only, including
  // to a holder of this key — the aggregate console shows counts and lists only the ones the sender
  // already made company-wide, because reading a team-scoped one on an HR screen would quietly widen
  // the audience the sender chose after the fact. A moderator acts on what they can already see.
  | 'recognition.moderate'

  // =============================================================================================
  // THE PERSON SPINE. Four keys behind the surfaces that assemble one human out of the four records
  // this product keeps about them (src/lib/person-spine.ts, person-360.ts, skill-graph.ts,
  // capability-coverage.ts).
  //
  // NONE OF THEM DECIDES ANYTHING ABOUT ANYBODY. Hiring, rejection, promotion, discipline and pay
  // are not reachable from any of these screens, and no key here moves an application's stage —
  // that is src/lib/application-stages.ts, which keeps its own actor history and is the only thing
  // allowed to move a candidate through the funnel.
  //
  // NO PRIOR POPULATION TO PRESERVE: none of these screens existed. So the settled rule for that
  // case applies — GRANT TO THE NARROWEST DEFENSIBLE HOLDER AND WRITE DOWN WHY — and that is
  // super_admin + hr, the two accounts that already read every employee record one at a time
  // through `employee.manage` and `skills.manage`. All four are ENFORCED at every call site from
  // the day they ship, and every write behind them is re-checked where it binds.
  //
  // NONE OF THEM CAN BE SPELLED BY A LEGACY SECTION ROW. customRoleKeys() derives keys as
  // `<page_key>.<action>` with action fixed to view/edit/delete/export; `view_360`, `administer`,
  // `run` and `override` are none of those. They are asked for with can(), which reads
  // PERMS_BY_ROLE alone.
  // =============================================================================================

  // READ THE ASSEMBLED PERSON RECORD: /admin/people and /admin/people/[id]. One human's identity
  // links, employment record, recorded skills, platform certificates and reporting line on one
  // screen, each panel carrying how it is known.
  //
  // IT WIDENS NO READ AND IT IS NOT A SUPER-PROFILE. Every panel is assembled from records the
  // holders of `employee.manage` already open one screen at a time. What it adds is the JOIN and
  // the labelling, not new data — and what it deliberately never reads is wellness, pay, bank
  // details, date of birth, gender, or any surveillance signal. src/lib/person-360.ts contains no
  // import of src/lib/wellness.ts and must never contain one: a 360 that quietly included a
  // wellness panel would contradict the entire premise of that system on the screen most likely to
  // be shown to a room.
  //
  // NOT SENSITIVE, because it changes nothing. Creating a person root, linking a record to one and
  // withdrawing a link are changes to a record about a person and each is re-checked at the write
  // against the SENSITIVE key below.
  | 'people.view_360'
  // MAINTAIN THE PERSON SPINE AND THE SKILL GRAPH: /admin/skills/ontology, and the identity writes
  // on /admin/people/[id]. Create a person root, state that a login, an application or an employee
  // record is that person, withdraw such a statement, add a skill to the catalogue, record a
  // relation between two skills, and merge two skills into one.
  //
  // SENSITIVE, and the derivation is the merge. A merge REWRITES ROWS ON OTHER PEOPLE'S RECORDS:
  // recorded levels move between skills, and where somebody holds both, one of their two rows is
  // kept and the other is not. It is offered only behind a preview that names every affected
  // person before the button exists, it never deletes the retired skill, and it is audited — but
  // the authority to run it must be provably on the record too.
  //
  // AN IDENTITY LINK IS THE OTHER HALF OF THE SAME REASON. Saying "this application is this
  // employee" makes a candidate's history readable from an employee record and vice versa. It is a
  // statement about who somebody IS, it requires a written basis that is stored verbatim, and
  // getting it wrong joins two humans into one record.
  //
  // WHAT IT STILL CANNOT DO: assert a skill LEVEL for anybody (that is `skills.manage` through
  // src/lib/skills.ts, which re-reads any evidence reference through the module that owns it and
  // refuses one that does not confirm), and make anybody anybody's manager.
  | 'skills.administer'
  // OPEN THE COVERAGE VIEW: /admin/match and /admin/match/[jobId]. Candidates and employees against
  // one job's requirements, requirement by requirement, each row carrying its own evidence chain.
  //
  // THERE IS NO BARE MATCH SCORE BEHIND THIS KEY AND THERE WILL NOT BE ONE, and the two modules
  // behind it draw that line in two different places. Read both before granting it.
  //
  // src/lib/capability-coverage.ts returns counts per status and REFUSES TO TOTAL THEM AT ALL,
  // because a single number would have to average a checked certificate against a keyword somebody
  // typed on a form.
  //
  // src/lib/match.ts does produce a weighted coverage figure, and the constraints on it are what
  // make it a different thing from a match score. It is unreachable except as one field of a
  // MatchExplanation, a type no other module can construct — so there is no function anywhere that
  // returns a number about a person on its own. It reports alongside itself how much of the
  // weighting could be assessed at all, so the parts nobody can measure are never read as agreement.
  // A claimed keyword contributes exactly nothing to it and can never lift it. And a GAP is never
  // folded into it: gaps are a separate list, and a gap against a REQUIRED capability is restated in
  // words as a decision blocker, where no arithmetic can round it away.
  //
  // A keyword is never treated as proof of competence in either module: a claimed capability is
  // labelled as claimed, wherever it appears.
  //
  // It also authors the job's requirements — mapping the job description's free-text skill list onto
  // the skill catalogue, one confirmed line at a time. That is not sensitive on its own: it says what
  // a JOB asks for, not what a PERSON has, and src/lib/capability-coverage.ts refuses outright any
  // requirement naming a protected or sensitive attribute, whoever is saving it.
  | 'match.run'
  // RECORD A HUMAN'S DECISION AGAINST WHAT THE COVERAGE VIEW SHOWED, with a written reason that is
  // required and kept: worth taking further, not for this role now, or the evidence is stronger or
  // weaker than this page shows.
  //
  // SENSITIVE. It is the recorded exercise of human authority over an advisory view about a named
  // person, it is kept beside that person's record, and it is read later by whoever is deciding.
  //
  // IT DECIDES NOTHING BY ITSELF, and that separation is deliberate: it does not move the
  // application's stage (src/lib/application-stages.ts owns the funnel and keeps its own actor
  // history), it starts no approval (src/lib/workflow.ts is the only approval engine in this
  // product), and it changes nothing on the person's own record. A recorded override with no reason
  // is an opaque decision with a timestamp on it, so the reason is refused when it is blank.
  | 'match.override'
  // CHANGE THE WEIGHTING EVERY READING IS PRODUCED UNDER: the stored profile in
  // match_weight_profiles that src/lib/match.ts reads before it compares anybody to anything.
  //
  // SENSITIVE, and the derivation is that it is a POLICY ABOUT PEOPLE rather than a setting. Moving
  // required capabilities from fifty-five to eighty changes how every candidate and every employee
  // reads against every job, retrospectively as far as anybody re-runs a comparison, and it does so
  // without appearing on any one person's record. That is precisely the kind of change that must
  // have a name attached, which is why saveWeightProfile() refuses a profile with no owner and
  // writes the change to the audit log.
  //
  // WHAT IT CANNOT DO, STRUCTURALLY: add a dimension. The weights are a CLOSED UNION of seven named
  // dimensions and a key outside it is refused BY NAME rather than ignored, so a holder cannot
  // introduce "culture fit", "potential" or "engagement" by saving a profile that mentions one. The
  // authority here is over how much the recorded dimensions count, never over what may be counted.
  | 'match.weights.manage'

  // =============================================================================================
  // THE INTERNSHIP MANAGEMENT SYSTEM: learning outcomes, the credit conversion, the grading rubric,
  // and the final internship record (src/lib/eims-outcomes.ts, src/lib/eims-credit.ts).
  //
  // THREE KEYS, AND NOT ONE OF THEM ASSESSES ANYBODY. Whether a person may assess an intern's
  // outcome or score their rubric is a per-ROW question answered by the Organization Graph — the
  // mentor edge, the reporting-manager edge, or the chain above them — resolved at the write in
  // mayAssessOutcome(). A key that granted assessment authority would hand every holder the power to
  // grade every intern in the company, which is the exact widening Phase 1 removed everywhere else.
  //
  // NO PRIOR POPULATION TO PRESERVE: none of these objects existed. So the settled rule for that case
  // applies — GRANT TO THE NARROWEST DEFENSIBLE HOLDER AND WRITE DOWN WHY — and that is super_admin +
  // hr, the two who already hold `employee.manage` and therefore already own the completion letter
  // these records replace. All three are ENFORCED at every call site from the day they ship.
  //
  // NONE OF THEM CAN BE SPELLED BY A LEGACY SECTION ROW. customRoleKeys() derives keys as
  // `<page_key>.<action>` with action fixed to view/edit/delete/export, and these end in `.manage`,
  // `.configure` and `.issue`. They are still asked for with can() rather than hasPermission(), for
  // the reason stated above the catalogue: can() reads PERMS_BY_ROLE alone.
  // =============================================================================================

  // DEFINING WHAT AN INTERNSHIP IS FOR: the learning-outcome catalogue for a programme, and the
  // mapping of activities onto those outcomes. It grants no sight of anybody's assessment and no
  // authority to record one.
  | 'eims.outcomes.manage'
  // OWNING THE CREDIT CONVERSION AND THE GRADING RUBRIC for a programme: how many credits the
  // programme is represented as, what components credit is considered against and at what weights,
  // the grade bands, and the rubric criteria.
  //
  // SENSITIVE, and this is the reason: whoever holds it decides WHAT A CREDIT MEANS on a document an
  // accredited partner reads. The configuration is a versioned record with a named owner rather than
  // a setting, precisely so that decision is attributable — and a grant of the power to make it must
  // be provably on the record too.
  //
  // WHAT IT STILL CANNOT DO: condition credit on attendance or login time. validateCreditConfig()
  // refuses a component whose key, label or note names attendance, presence, login, clock time or
  // punctuality, whoever is saving it. That is not a permission question and no grant relaxes it.
  | 'eims.credit.configure'
  // ISSUING AND WITHDRAWING THE FINAL INTERNSHIP RECORD, together with the certificate in the
  // existing credential ledger and its public verification page.
  //
  // SENSITIVE: it puts a credential into the world under this platform's name, and takes one back.
  // Issuing a record that carries known gaps additionally requires an explicit acknowledgement and a
  // written reason, both of which are frozen into the document — the key opens the act, it does not
  // excuse the record.
  //
  // IT DOES NOT AWARD ANYTHING. EduRankAI computes and evidences; an accredited partner awards. The
  // decision type carries `awarded: false` as a literal type, so no holder of this key — and no code
  // path at all — can record this platform as the awarding body.
  | 'eims.record.issue'

  // OWNING THE PROGRAMME ITSELF: what internships this platform runs, the weekly ceiling on each of
  // them, the total hours the programme requires, the role whose evidence types it offers, and
  // whether it is open to enrol into at all.
  //
  // SENSITIVE, and the derivation is the same one that made `eims.credit.configure` sensitive. The
  // ceiling is the number recognised hours are capped AT and the required-hours total is the number
  // a completion record is measured AGAINST — so the two figures on the final record that most
  // determine what it says about a person are set here. A change to them is audited with who and
  // when, and the key is on the record too.
  //
  // WHAT IT STILL CANNOT DO: raise a ceiling above the statutory weekly maximum (setProgrammeCeiling
  // refuses it for every holder), put holistic development outside the ceiling as an extra allowance,
  // or make anything conditional on attendance. None of those is a permission question.
  //
  // IT IS NOT `eims.credit.configure`, and keeping them apart is deliberate: one decides how long a
  // week may be, the other decides what a credit means. They are held by the same two roles today,
  // which is a fact about this company rather than a reason to spell them as one key.
  | 'eims.programme.configure'

  // ENROLLING A PERSON INTO A PROGRAMME, and closing that enrolment as completed or withdrawn.
  //
  // SENSITIVE. Enrolment is what BINDS a named person to a rule set — the ceiling, the required
  // hours, the credit conversion and the rubric they will be measured under. Moving somebody between
  // programmes therefore changes what their record of achievement will say without touching a single
  // hour, which is exactly the kind of act that must be attributable rather than quiet.
  //
  // IT ASSIGNS NO AUTHORITY OVER ANYBODY. The mentor and reporting-manager edges an enrolment screen
  // records are written into the Organization Graph, and every later question — may this person
  // verify these hours, approve this week, assess this outcome — is answered per ROW from that graph
  // at the write. Holding this key makes nobody anybody's mentor and lets nobody verify an hour.
  //
  // IT VERIFIES NOTHING, GRADES NOTHING AND AWARDS NOTHING. Those were considered as keys of their
  // own and deliberately not created: verification and grading are per-row relationships, not a
  // standing power over a cohort, and awarding is not something this platform does at all.
  | 'eims.enrolment.manage';

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
    // INVOICES. The same three-way split, and the same population: whoever already reads the
    // purchasing record and releases a payout. None of the three approves a payment — a supplier
    // bill is paid only against an APPROVED workflow instance, routed per row from the graph.
    'invoices.view', 'invoices.manage', 'invoices.pay',
    // WORKPLACE SERVICES. No prior authority to preserve - there was no helpdesk, no asset
    // register and no document library anywhere in this codebase. Granted to the narrowest
    // defensible holder, and enforced at every call site from day one.
    // `knowledge.manage` joins them for the same reason and with the same population: it writes the
    // staff handbook the helpdesk deflects tickets to. Reading is scoped by the article's own
    // audience in the WHERE clause, so this key widens nobody's sight of anything.
    'helpdesk.manage', 'assets.manage', 'documents.manage', 'knowledge.manage',
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
    'performance.manage', 'skills.manage', 'learning.assign',
    // PROVENANCE. The organization-wide verification desk — the same population as the three
    // keys above, and for the same reason: these are the only accounts that read every employee
    // record today. It makes nobody anybody's manager; a relationship out of the Organization
    // Graph is what lets a manager verify their own people, resolved per row.
    'provenance.verify',
    // LEARNING ADMINISTRATION. The same population as `learning.assign` on the line above, because
    // the derivation is the same one: super_admin and hr are the only accounts that reach the
    // learning desk or the course catalogue today. Two of the four are SENSITIVE in the registry —
    // they change a record of achievement, so granting them to a custom role fails unless the audit
    // row naming the granter can be written.
    'learning.progress.view', 'learning.completion.override',
    'learning.certificate.manage', 'learning.rules.manage',
    // PROJECTS. The portfolio read and the project register. NEITHER makes the founder the manager
    // of any project — that is a `project_manager` edge in the Organization Graph, scoped to one
    // project, and /admin/projects resolves it per row exactly like every other surface here.
    'projects.view', 'projects.manage',
    // ANNOUNCEMENTS AND RECOGNITION. No prior authority to preserve — there was no announcements
    // table and no recognition table anywhere in this codebase. Narrowest defensible holders,
    // matching `knowledge.manage`: the key that already decides what the whole company is asked to
    // read. Neither approves anything, neither widens a read: an announcement's audience is applied
    // in the WHERE clause, and a team-scoped recognition stays team-scoped for the holder too.
    'announcements.publish', 'recognition.moderate',
    // THE PERSON SPINE. Narrowest defensible holders, matching `employee.manage` and `skills.manage`
    // on the lines above: super_admin and `hr` are the only accounts that read every employee record
    // and maintain the skill catalogue today, and the 360 assembles nothing they cannot already open
    // one screen at a time. None of the four makes the founder anybody's manager, and none of them
    // moves an application through the funnel.
    'people.view_360', 'skills.administer', 'match.run', 'match.override', 'match.weights.manage',
    // THE INTERNSHIP MANAGEMENT SYSTEM. Narrowest defensible holders, matching `employee.manage`:
    // the desk that already owns /admin/hr/completion/[id], which is the document these records
    // replace. None of the three assesses anybody — a mentor's authority over one intern is a per-row
    // edge in the Organization Graph and no grant on this line can create one.
    //
    // The programme and enrolment keys join them on the same line and for the same reason: deciding
    // which internships exist and who is on one is the same desk that already decides what the
    // completion document says. Neither of them verifies an hour or grades anybody.
    'eims.outcomes.manage', 'eims.credit.configure', 'eims.record.issue',
    'eims.programme.configure', 'eims.enrolment.manage'
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
    // PROVENANCE. The organization-wide verification desk — the same population as the three
    // keys above, and for the same reason: these are the only accounts that read every employee
    // record today. It makes nobody anybody's manager; a relationship out of the Organization
    // Graph is what lets a manager verify their own people, resolved per row.
    'provenance.verify',
    // LEARNING ADMINISTRATION. Same population and same derivation as the line above: `hr` already
    // holds the learning desk and the training section, and already reads every employee record.
    // What these four add is the ability to CORRECT the record — mark a completion, revoke one,
    // issue or withdraw a certificate, and say what counts as complete — which nobody in this
    // product could do before, in any role, on any screen.
    'learning.progress.view', 'learning.completion.override',
    'learning.certificate.manage', 'learning.rules.manage',
    // PROJECTS. `hr` already holds the org-wide reads that a portfolio is made of — every employee
    // record (employee.manage), the whole claim queue (expenses.review), the purchasing record
    // (procurement.view) and aggregate reporting (analytics.view) — so a register of what the
    // company is working on adds no reach it does not have. It confers nothing over any single
    // project: whoever RUNS a project is a `project_manager` edge in the Organization Graph, and no
    // grant on this line can create one. The matching 'projects' section is added to this role's
    // ROLE_SECTIONS list below, so the sidebar entry, the page gate and the capability admit exactly
    // the same accounts rather than three overlapping sets.
    'projects.view', 'projects.manage',
    // PROCUREMENT. `hr` is the only built-in role below super_admin holding the `finance` and
    // `payouts` sections in ROLE_SECTIONS, and /admin/finance has been super_admin + hr since it was
    // written — so the people who already handle company money handle the purchasing record too.
    // The console accepts EITHER this key or the `finance` section, so no custom role that can open
    // /admin/finance today is shut out of the purchasing console tomorrow.
    'procurement.view', 'procurement.manage',
    // INVOICES. `hr` already holds payouts.pay (releasing an employee payout) and procurement.manage
    // (committing the company to a supplier), so recording what we billed and what we paid is
    // authority this role has in substance today. It confers no approval: paying a supplier bill
    // needs an approved chain, resolved per row from the Organization Graph, not a key.
    'invoices.view', 'invoices.manage', 'invoices.pay',
    // WORKPLACE SERVICES. The people desk already answers, informally, the questions these
    // three modules formalise - who is holding which laptop, what the joining paperwork says,
    // and whatever an employee could not raise with their own manager. `hr` is also the only
    // built-in role holding the matching 'helpdesk' and 'assets' sections in ROLE_SECTIONS
    // below, so the sidebar, the page gate and the capability admit exactly the same accounts.
    // `knowledge.manage` sits with them: the people desk already writes these answers out by hand in
    // reply to the same five questions, and this is where those answers go instead.
    'helpdesk.manage', 'assets.manage', 'documents.manage', 'knowledge.manage',
    // WORKING TIME AND AGGREGATE REPORTING. `hr` is the only built-in role holding the `attendance`
    // section in ROLE_SECTIONS below, so it is already the role that administers attendance; and it
    // holds employee.manage, so it can already read every employee record one at a time. Both keys
    // record authority this role has in substance today. Neither puts anybody on an approval route.
    'attendance.roster.manage', 'analytics.view',
    // REFERRALS. `hr` holds payouts.approve, so it holds referrals.reward: putting a number on a
    // referral bonus is the same class of act as approving a withdrawal, and the same two accounts
    // already do it. It still approves nothing — the reward routes through the workflow engine.
    'referrals.view', 'referrals.reward',
    // ANNOUNCEMENTS AND RECOGNITION. `hr` already holds `knowledge.manage`, which decides what the
    // whole company is asked to READ and CONFIRM through the staff handbook; a company notice is the
    // same act with a shorter shelf life, and the people desk is who writes both today by hand. It
    // confers no approval and no wider sight of anything: a notice's audience is applied in the
    // query, and a recognition sent to one team is not readable on this desk because it was not sent
    // to it. Sending recognition needs no key at all and this is not one — it only takes one down.
    'announcements.publish', 'recognition.moderate',
    // THE PERSON SPINE. Same population and same derivation as the super_admin line: `hr` already
    // holds `employee.manage` and `skills.manage`, so it already reads every employee record and
    // already maintains the catalogue these four surfaces are assembled from. What they add is the
    // JOIN between a login, an application and an employee record — and the labelling that keeps a
    // stated skill from ever looking like a checked one.
    'people.view_360', 'skills.administer', 'match.run', 'match.override', 'match.weights.manage',
    // THE INTERNSHIP MANAGEMENT SYSTEM. `hr` holds `employee.manage`, which is what gates
    // /admin/hr/completion/[id] — the completion letter these records replace — so owning the
    // outcome catalogue, the credit conversion and the issuing of the final record is authority this
    // desk has in substance today, written down instead of spelled. It confers nothing over any one
    // intern: who may assess them is a mentor or reporting-manager edge in the Organization Graph,
    // resolved per row at the write.
    //
    // Running the programmes and enrolling people into them is the same desk again: HR already keys
    // employment type, weekly hours and the completion letter for exactly these people. Recording
    // that here replaces the implicit version of the same authority rather than widening it, and the
    // mentor and manager edges an enrolment records are org-graph rows, not grants.
    'eims.outcomes.manage', 'eims.credit.configure', 'eims.record.issue',
    'eims.programme.configure', 'eims.enrolment.manage'
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

// Resolved LAZILY. This module is imported by almost everything, and a top-level db import made
// src/lib/db throw DATABASE_URL is not set the moment ANY importer loaded — which put every pure
// function reachable through it, including credit arithmetic that touches no database, permanently
// out of reach of a test. can() and the capability union are pure; only the role lookups below need
// a connection, and they ask for one when they run.
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
import { userRoleAssignments, rolePermissions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

export type PermissionAction = 'view' | 'edit' | 'delete' | 'export';

/**
 * Returns true if the user has ANY custom role granting the specified action on the page.
 * If user has no custom roles, returns false (caller can fall through to legacy can()).
 */
export async function userCanAccess(userId: string, pageKey: string, action: PermissionAction): Promise<boolean> {
  const userRolesRows = await (await database()).select({ roleId: userRoleAssignments.roleId })
    .from(userRoleAssignments)
    .where(eq(userRoleAssignments.userId, userId));
  if (userRolesRows.length === 0) return false;

  const roleIds = userRolesRows.map(r => r.roleId);
  const perms = await (await database()).select().from(rolePermissions)
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
    // 'projects' is NEW, and it is added here for the same reason 'helpdesk' and 'assets' were: the
    // sidebar entry is gated on the section, the console accepts the section OR the capability, and
    // `hr` is granted projects.view/projects.manage above — so without this line the desk would hold
    // the key and never be offered the door. It reveals no project to anybody who is not on one:
    // /admin/projects is the portfolio, and the portfolio is exactly what the capability describes.
    'projects',
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
 * BULK EXPORT IS NOT THE SAME RIGHT AS VIEWING, and canAccessSection() used to treat them as one:
 * its last line is `return action !== 'delete'`, so any section a built-in role could open, it could
 * also download in full. Viewing an application is one candidate on one screen, with the soft-deleted
 * rows hidden; exporting it is every candidate who ever applied, as a file that leaves the building.
 *
 * A DENYLIST RATHER THAN AN ALLOWLIST, deliberately. Rewriting this as a per-role export allowlist is
 * the right shape and is filed as a later change: written blind, it would silently remove a download
 * somebody uses daily, and a lockout is its own outage. This map removes exactly the combination that
 * is the vulnerability and preserves every other export unchanged.
 *
 * EXPORT ONLY. `view` and `edit` are deliberately NOT touched here — narrowing edit in the same pass
 * would remove ordinary daily access and is a policy decision, not a fix.
 *
 * `reviewer` is the entry. Its sections are dashboard / applications / interviews / tests — a
 * screening role that reads one candidate at a time and has no records-keeping duty. Export on
 * 'applications' handed it GET /api/export/applications: name, email, phone, location and status for
 * up to 5000 applicants in one authenticated request. hr, recruiter and department_head keep theirs;
 * pipeline reporting is those roles' actual job and removing it here would be a policy change, not a
 * fix.
 *
 * A CUSTOM role is unaffected — custom roles are resolved from rolePermissions.canExport, which is
 * already a separate column and already answers this question honestly.
 */
const EXPORT_DENIED_SECTIONS: Record<string, readonly string[]> = {
  reviewer: ['applications'],
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
  const assigns = await (await database()).select({ roleId: userRoleAssignments.roleId })
    .from(userRoleAssignments)
    .where(eq(userRoleAssignments.userId, user.id));
  if (assigns.length > 0) {
    const roleIds = assigns.map(r => r.roleId);
    const perms = await (await database()).select({ pageKey: rolePermissions.pageKey, canView: rolePermissions.canView })
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
 *                            view/edit on it; delete stays super_admin-only; export is granted too
 *                            EXCEPT for the pairs named in EXPORT_DENIED_SECTIONS above)
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
    const assigns = await (await database()).select({ roleId: userRoleAssignments.roleId })
      .from(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, user.id));
    if (assigns.length > 0) {
      return await userCanAccess(user.id, sectionKey, action);
    }
  } catch { return false; }

  const defaults = ROLE_SECTIONS[user.role];
  if (!defaults) return false;
  if (!defaults.includes(sectionKey)) return false;
  // Bulk export is decided separately from view/edit — see EXPORT_DENIED_SECTIONS above.
  if (action === 'export' && (EXPORT_DENIED_SECTIONS[user.role] || []).includes(sectionKey)) return false;
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
