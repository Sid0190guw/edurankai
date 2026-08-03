// src/lib/auth/registry.ts — the permission registry. Permissions are DATA, not a TypeScript union.
//
// WHY THIS EXISTS. An intern reached the super-admin console in production. Three fixes shipped:
// the offer-signing promotion was removed, /admin now denies by default in middleware
// (src/lib/auth/admin-access.ts), and interns were bulk-demoted. What none of them fixed is the
// shape of the model underneath: src/lib/auth/permissions.ts hardcodes both the roles (a TypeScript
// union) and the matrix that maps them to permissions (PERMS_BY_ROLE). Adding a role means editing
// code, building, and deploying. An organisation heading for 1100+ admin-created roles cannot run
// that way, and a system where the only way to express "this person may do X" is a code change is a
// system where people get handed a role that is roughly right — which is exactly how an intern
// ended up an `editor`, and `editor` holds admin.access.
//
// WHAT IT IS. A catalogue of permissions stored in a table (key, label, group, description), custom
// roles that hold them, and ONE function — resolvePermissions() — that answers what a person may do
// by merging the built-in matrix with whatever the admin panel has configured.
//
// WHAT IT IS NOT. A second, parallel RBAC. It EXTENDS what already exists:
//   - team_roles / role_permissions / user_role_assignments (src/lib/db/schema.ts) keep their
//     meaning; the page-key + view/edit/delete/export rows written by /admin/team/roles are read
//     here and folded into the same answer, so nothing that works today stops working.
//   - PERMS_BY_ROLE stays authoritative for the built-in roles. It is code, it needs no database,
//     and can() remains the pure test for callers that must survive an outage.
//   - src/lib/rbac/* (the kernel capability engine) is a different layer for a different surface and
//     is deliberately untouched.
//
// THE ONE INVARIANT: NO EXCEPTION PATH EVER ADDS A PERMISSION. Every failure in resolvePermissions
// returns an EMPTY set with degraded=true. A database hiccup denies; it never grants. This is the
// same trade admin-access.ts already made and states plainly: the cost is that an outage closes the
// console for everyone including the founder, and the alternative — a gate that opens when the
// database blinks — is not a gate.
//
// NO MIGRATIONS EXIST ON THIS PROJECT. Everything new self-bootstraps in ensureRegistrySchema()
// with CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, following src/lib/legal-hold.ts.
//
// HONEST LIMIT — READ THIS BEFORE ASSUMING A GRANT OPENS THE CONSOLE. Granting `admin.access`
// through a custom role is supported, recorded and resolvable here, but by itself it does NOT open
// /admin today: src/middleware.ts asks canOpenAdmin(), whose ALLOW list (ADMIN_CAPABLE_ROLES) is
// derived from the BUILT-IN role on users.role. That is a safe default, not an oversight — the
// registry cannot silently widen the blast radius of the incident it was written for. Honouring
// custom grants at the door is a one-line seam in admin-access.ts (ask
// `hasPermission(user.id, PERM_ADMIN_ACCESS)` alongside the ALLOW-list test); it is a deliberate
// decision for a human to make, not a side effect of this file landing.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { logEvent } from '@/lib/logger';
import { PERMS_BY_ROLE, type Permission } from '@/lib/auth/permissions';
import { ADMIN_SECTION_GROUPS, ADMIN_SECTION_ACTIONS, sectionTargetFor, type AdminSectionAction } from '@/lib/admin-sections';
import type { User } from '@/lib/db/schema';

// postgres-js resolves to a plain array, never a { rows } object. Declared at the very top because
// `const` is not hoisted and a handler reaching a later declaration has taken pages down here.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => logEvent('error', tag, { message: reason(e) });

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** The permission that caused the incident. Named once, referenced everywhere. */
export const PERM_ADMIN_ACCESS = 'admin.access';

/**
 * Held only by super_admin, and only ever ADDED to a set — never stored, never grantable, never
 * catalogued. It exists so resolvePermissions needs no catalogue read (and therefore has one fewer
 * way to fail) while still meaning "everything, including permissions invented next week".
 *
 * Callers that inspect the Set directly MUST go through holdsPermission() or hasPermission(), both
 * of which understand it. A bare `set.has('users.edit')` will answer false for a super_admin.
 */
export const WILDCARD = '*';

/**
 * Actions the section matrix (/admin/team/roles) can grant, in the order the editor shows them.
 * Re-exported from admin-sections.ts rather than restated, so this module and the sidebar preview
 * cannot end up disagreeing about what the four columns of role_permissions are called.
 */
export const SECTION_ACTIONS = ADMIN_SECTION_ACTIONS;
export type SectionAction = AdminSectionAction;

const ROLE_NAME_MIN = 2;
const ROLE_NAME_MAX = 80;
/** `group.action` or `group.sub.action`; lowercase, dots and underscores only. */
const PERMISSION_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
/** A role key: lowercase, starts with a letter or digit, then letters, digits, dashes, underscores. */
const ROLE_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,79}$/;

/** Turn a role name into a usable key, so nobody has to invent one to create a role. */
export function slugifyRoleKey(input: string): string {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ---------------------------------------------------------------------------------------------
// The built-in catalogue.
//
// This map is typed `Record<Permission, ...>`, which is the point: TypeScript REFUSES TO COMPILE if
// a member of the Permission union has no entry here. Adding a permission to the union without
// describing it is a build failure rather than a silent gap in the admin UI, and the seeding step
// below then writes these into permission_catalogue — so day one of the registry grants exactly what
// day zero granted, and nothing regresses.
// ---------------------------------------------------------------------------------------------

export interface PermissionMeta {
  label: string;
  group: string;
  description: string;
  /**
   * A permission whose grant must be provably on the record. Granting one of these fails if the
   * audit entry cannot be written (see assignPermission). admin.access is the reason this flag
   * exists; the rest are the permissions that read or change who else can do what.
   */
  sensitive?: boolean;
}

export const BUILTIN_PERMISSIONS: Record<Permission, PermissionMeta> = {
  'admin.access': {
    label: 'Open the admin console',
    group: 'Access',
    description: 'Reach any admin surface at all. This is the permission an intern held through the `editor` role; grant it deliberately, to named people, and expect the grant to be read back to you in the audit log.',
    sensitive: true,
  },
  'roles.view': { label: 'View job roles', group: 'Hiring', description: 'See the job-role catalogue and its descriptions.' },
  'roles.edit': { label: 'Edit job roles', group: 'Hiring', description: 'Create, change and retire job roles and their descriptions.' },
  'applications.view': { label: 'View applications', group: 'Hiring', description: 'Open the applicant pipeline and read individual applications.' },
  'applications.edit': { label: 'Edit applications', group: 'Hiring', description: 'Change application state, notes and stage.' },
  'applications.score': { label: 'Score applications', group: 'Hiring', description: 'Record evaluations and scores against an application.' },
  'offers.view': { label: 'View offer letters', group: 'Hiring', description: 'Read issued offer letters and the verification requests raised against them.' },
  'offers.edit': { label: 'Issue and answer offers', group: 'Hiring', description: 'Issue offer letters and answer verification requests on the record.' },
  'events.view': { label: 'View events', group: 'Content', description: 'See scheduled events and their registrations.' },
  'events.edit': { label: 'Edit events', group: 'Content', description: 'Create and change events.' },
  'products.view': { label: 'View products', group: 'Content', description: 'See product and venture pages.' },
  'products.edit': { label: 'Edit products', group: 'Content', description: 'Create and change product and venture pages.' },
  'content.view': { label: 'View content pages', group: 'Content', description: 'See site content pages and their drafts.' },
  'content.edit': { label: 'Edit content pages', group: 'Content', description: 'Publish and change site content.' },
  'users.view': { label: 'View users', group: 'Access', description: 'See the list of accounts, their roles and their status.' },
  'users.edit': {
    label: 'Edit users',
    group: 'Access',
    description: 'Change an account\'s role, department or active status. Whoever holds this can change who else can do anything.',
    sensitive: true,
  },
  'payments.view': { label: 'View payments', group: 'Finance', description: 'Open the finance console and read payment records, including payer email addresses and amounts.' },
  'payments.refund': {
    label: 'Refund a payment',
    group: 'Finance',
    description: 'Send money back to a payer through the payment gateway, or record a refund made outside it. This moves real money and cannot be undone from here.',
    sensitive: true,
  },
  // APPROVALS AND PEOPLE. The capabilities docs/workforce-os/AUTHORIZATION_FIRST.md names and the
  // code did not have. Each is granted in PERMS_BY_ROLE to exactly the roles that hold the equivalent
  // authority today — the derivation is written out above that matrix, along with the two authorities
  // (a reporting-manager link, and an intern engagement) that are per-PERSON and therefore cannot be
  // expressed as a role grant at all.
  //
  // WHY THREE OF THEM ARE SENSITIVE. Granting one of these to a custom role hands somebody the power
  // to sign off another person's time away or to move their salary out of the company. That grant is
  // written strictly (assignPermission -> recordStrict): if the audit row naming the granter cannot
  // be written, the grant is rolled back and the caller is told. `employee.manage` is not flagged,
  // matching how the existing HR sections are treated; it is the obvious next candidate if this
  // catalogue is ever reviewed, and it is left to that review rather than decided in passing here.
  //
  // WHICH OF THESE A LEGACY SECTION-MATRIX ROW CAN SPELL — the paragraph that used to say "none of
  // them", and no longer can.
  //
  // customRoleKeys() derives keys as `<page_key>.<action>` with action fixed to
  // view/edit/delete/export. So no page_key can produce `.approve`, `.pay`, `.manage`, `.lead`,
  // `.author`, `.publish`, `.run`, `.grant`, `.retry`, `.respond` or `.moderate` — that whole set
  // needs no filter, and that is a property of the four action names, so anything widening
  // SECTION_ACTIONS must re-read this.
  //
  // THE `.view` KEYS ARE DIFFERENT AND MUST BE TREATED AS SUCH. `tests_restricted.view` is spelled
  // by the REAL section key tests_restricted (admin-sections.ts:57) — that is deliberate, it is why
  // the key is named this way, and it is the same overlap users.view / content.edit / audit.view have
  // always had. `resumes.view`, `locations.view` and `research.restricted.view` have no section, but
  // page_key is free text written by a form, so a hand-crafted row could spell the first two.
  //
  // `reports.export` IS IN THE SAME POSITION, and it is an `.export` key rather than a `.view` one,
  // which is precisely the shape a section row CAN spell: there is no `reports` section today, so
  // seedCatalogueRows() derives nothing, but a hand-typed page_key of `reports` with the Export box
  // ticked would produce this exact string. Its call site therefore uses can() as well.
  //
  // The consequence is one rule, and it is not optional: CONVERT THESE CALL SITES WITH can(), NEVER
  // WITH hasPermission()/resolvePermissions(). can() reads PERMS_BY_ROLE alone and therefore admits
  // exactly the roles named there. A registry-based conversion would additionally admit every custom
  // role holding the matching section checkbox — for a restricted question bank, for every resume on
  // file, or for applicant GPS. That is a widening, and it would arrive without anyone granting a
  // permission.
  'leave.approve': {
    label: 'Approve leave requests',
    group: 'People',
    description: 'Approve or reject an employee\'s leave request, which also writes their attendance for those days. Held today by HR and super admins; a reporting manager can decide their own reports\' requests through the reporting line, not through this permission.',
    sensitive: true,
  },
  'payouts.approve': {
    label: 'Approve withdrawal requests',
    group: 'Finance',
    description: 'Approve or reject an employee\'s request to withdraw their wallet balance. Approving does not release the money — that is a separate permission.',
    sensitive: true,
  },
  'payouts.pay': {
    label: 'Release a payout',
    group: 'Finance',
    description: 'Send an approved withdrawal to an employee\'s bank account, or record a settlement made outside the gateway. This moves real money and cannot be undone from here.',
    sensitive: true,
  },
  // Spelled `employees.manage` until this commit; renamed to the canonical singular with an
  // identical grant set (super_admin + hr) and both call sites moved with it. The old catalogue row
  // survives on any database that has already booted, inert: no code asks for it, and the two gates
  // that used to ask went through can() rather than this registry, so a custom-role grant of it
  // never conferred anything. Deleting the row needs a database change and is a follow-up.
  'employee.manage': {
    label: 'Manage employee records',
    group: 'People',
    description: 'Open the people console and create or change employee records: designation, employment terms, department, reporting line and exit. Never health or wellness data, which no permission grants sight of.',
  },
  // KEPT AGAINST AN INSTRUCTION TO DELETE IT, because deleting it changes who may open a team-lead
  // surface and there is no organisational data to resolve leadership from — no `departments` table
  // in either schema carries a head, and hr_employees.reporting_manager_id is written by no code.
  // The full reasoning and the recommended migration are in permissions.ts above PERMS_BY_ROLE.
  'department.lead': {
    label: 'Lead a department',
    group: 'People',
    description: 'See the department recorded on your own account — your team\'s roster, attendance and requests, and nobody else\'s. A scope, not a rank: it narrows what is visible to one department rather than widening it.',
  },

  // ---------------------------------------------------------------------------------------------
  // THE `role !== 'applicant'` FAMILY. Granted to all ten non-applicant built-in roles, because that
  // is precisely who passes the test each one replaces. An admin granting one of these to a CUSTOM
  // role should read the description as what it says and not as "internal staff": the built-in width
  // is inherited history, not a recommendation.
  // ---------------------------------------------------------------------------------------------
  'mail.manage': {
    label: 'Operate the company mailbox',
    group: 'System',
    description: 'Fetch the shared inbox over IMAP, send mail from the company address, and test SMTP/IMAP connections using the stored credentials. The connection tests report whether a username and password worked, so this also grants a way to check credentials. Give it to the people who actually run the mailbox.',
    sensitive: true,
  },
  'lessons.author': {
    label: 'Write lessons',
    group: 'Content',
    description: 'Create, edit, reorder and delete the blocks a lesson is made of, upload teaching files, change lesson titles, restore an earlier version and submit a lesson for review. Does not make anything visible to learners — publishing is a separate permission.',
  },
  'lessons.publish': {
    label: 'Publish lessons',
    group: 'Content',
    description: 'Make a lesson live to learners. Separate from writing one on purpose: someone can be trusted to draft teaching material without being the person who decides it is ready to teach.',
  },
  'interviews.author': {
    label: 'Generate interview questions',
    group: 'Hiring',
    description: 'Turn an uploaded job description or document into a set of interview questions automatically. This decides what candidates are asked, and each generation costs money in AI usage.',
  },
  'jobs.run': {
    label: 'Run a scheduled job by hand',
    group: 'System',
    description: 'Trigger a background job immediately instead of waiting for its schedule: settling the weekly learner league (promotions, demotions and rewards for everyone) and sending the streak reminder notifications. One click affects every learner at once.',
  },
  'research.restricted.view': {
    label: 'Read restricted research',
    group: 'Research',
    description: 'Open the internal research deep modules, which are otherwise available only to applicants whose access request has been approved. Confidential unpublished work.',
    sensitive: true,
  },

  // ---------------------------------------------------------------------------------------------
  // THE super_admin CLUSTER. Each replaces a literal `role !== 'super_admin'` redirect and is
  // granted to super_admin alone. Written as their own keys rather than borrowed from users.view /
  // users.edit — those are exact-population but describe ACCOUNTS, and an audit line saying somebody
  // changed an account when they in fact exported every resume on file is a log that misdescribes
  // what happened.
  // ---------------------------------------------------------------------------------------------
  'profiles.manage': {
    label: 'Manage applicant profiles',
    group: 'Hiring',
    description: 'Edit an applicant\'s profile and publish it to the public web, or take it down again, and delete a profile outright. Publishing puts a real person\'s details on a page anyone can read.',
    sensitive: true,
  },
  'resumes.view': {
    label: 'View resume submissions',
    group: 'Hiring',
    description: 'Open the resumes people have built on the site — including guests who never made an account — and read them one at a time. Downloading the whole set as a spreadsheet is a SEPARATE permission (Export a dataset in bulk); this one no longer carries it.',
    sensitive: true,
  },
  // BULK EXPORT, split out of resumes.view. Held today by super_admin alone — the same population
  // that could reach /admin/resumes?export=csv when one key gated both acts — so the split changes
  // nothing about who can export and everything about what a future grant of resumes.view would
  // hand over.
  //
  // SENSITIVE, so assignPermission() routes a grant through recordStrict(): if the audit row naming
  // the granter cannot be written, the grant is rolled back. Whoever holds this can remove a whole
  // dataset of other people's personal details from the product in one request, and that is the
  // definition of a grant that must be provably on the record.
  'reports.export': {
    label: 'Export a dataset in bulk',
    group: 'System',
    description: 'Download a whole dataset in one file rather than reading records one at a time — today the complete resume-submission spreadsheet: every person\'s full name, email, phone, LinkedIn and summary, with no page limit and no way to recall the file afterwards. Being allowed to open a record is not a reason to hold this; grant it only where taking the entire set out of the product is genuinely part of the job.',
    sensitive: true,
  },
  'credits.grant': {
    label: 'Grant account credit',
    group: 'Finance',
    description: 'Put spendable balance on any account by email address. The balance can be used to pay fees, so this creates money inside the product and cannot be undone from here.',
    sensitive: true,
  },
  'payments.retry': {
    label: 'Retry a stuck payment',
    group: 'Finance',
    description: 'Re-drive a payment that was captured by the gateway but never turned into an application, so the person gets what they paid for. It acts on a real captured payment.',
    sensitive: true,
  },
  'locations.view': {
    label: 'See applicant locations',
    group: 'Hiring',
    description: 'See the precise place an applicant was when they applied, to GPS accuracy, tied to their name. An application can be reviewed fully without this; grant it only where knowing the physical location is genuinely required.',
    sensitive: true,
  },

  // ---------------------------------------------------------------------------------------------
  // THE REST, one call site at a time.
  // ---------------------------------------------------------------------------------------------
  'payroll.manage': {
    label: 'Run payroll',
    group: 'Finance',
    description: 'Open the payroll screen and set salaries, generate payslips and mark a month paid. It also sets the salary components every payslip is built from, including the rates used for provident fund, state insurance, professional tax and withholding — the product computes those from the rates you enter and makes no claim that they are correct for your jurisdiction. It reads and writes base salary, which is the most sensitive number on an employee\'s record after their health data.',
    sensitive: true,
  },
  // MONEY, AND SOMEBODY ELSE\'S SPENDING. Sensitive for two separate reasons: a claim queue is a
  // running record of what colleagues buy, where they travel and when they are ill (a medical
  // reimbursement names the category on its face), and it is the screen a finance team works the
  // company\'s outgoings from.
  //
  // WHAT IT IS NOT: permission to approve anything. The `expenses` and `travel` workflow domains
  // declare no standing capability at all, on purpose, so a claim can only be decided by the person
  // the Organization Graph routed it to or their in-force delegate. Granting this to a role does not
  // place that role in a single approval chain.
  'expenses.review': {
    label: 'Review expense and travel claims',
    group: 'Finance',
    description: 'Open the claims console and read every expense, travel and advance request raised by anyone in the company: the amount, the category, the receipt link, and who each one is currently waiting on. That includes medical reimbursements, which name a colleague and a health-related spend on the same row. It does NOT let you approve, reject or pay anything — every claim is decided by the approver the Organization Graph routes it to, and holding this key does not put you in that chain.',
    sensitive: true,
  },
  // Same key the `tests_restricted` SECTION already spells (src/lib/admin-sections.ts:57,
  // "Restricted Exams — Designated-authority only"), so the console offers ONE name for this
  // authority rather than two. Being both a union member and a section-derived key is normal here:
  // users.view, roles.edit, content.edit, events.view, settings.edit and audit.view all are.
  'tests_restricted.view': {
    label: 'Open restricted exam papers',
    group: 'Assessments',
    description: 'Open and edit the question bank of an exam marked restricted. Everyone else who can reach the tests section is turned away from these papers, which is the whole point of marking one restricted.',
  },
  'safety.respond': {
    label: 'Respond to emergencies',
    group: 'People',
    description: 'Open the emergency console: who has raised an SOS, their name and contact, the live location of everyone signed in during the last ten minutes, and the ability to mark an emergency resolved on somebody else\'s behalf. This is live tracking of colleagues; grant it to the people who actually answer emergencies.',
    sensitive: true,
  },
  'requisitions.approve': {
    label: 'Approve hiring requisitions',
    group: 'People',
    description: 'Sign off a request to hire — the budget and the headcount. NOT ENFORCED ANYWHERE YET: today the requisition library checks nobody, so granting this changes nothing until the check is added, which needs a decision about who signs off the finance stage and who signs off the leadership stage.',
    sensitive: true,
  },
  'community.moderate': {
    label: 'Moderate community and classrooms',
    group: 'Content',
    description: 'Read the moderation queue and act on what is in it: remove a message, allow it, mute or remove somebody from a room. Some of the people involved are minors. NOT ENFORCED ANYWHERE YET: the moderation library records who acted but checks nobody, so granting this changes nothing until the check is added.',
    sensitive: true,
  },
  // ---------------------------------------------------------------------------------------------
  // PROCUREMENT. Two keys, and neither of them approves anything.
  //
  // A purchase request is approved by the people the Organization Graph names for THAT requester,
  // per row, by src/lib/workflow.ts — whose `procurement` domain carries no standing capability at
  // all. So an admin reading these descriptions should read them as what they say: seeing what the
  // company is buying, and committing an already-approved request to a supplier. Neither is a way to
  // sign off somebody else's request, and granting both to a role does not make its holders
  // approvers of anything.
  // ---------------------------------------------------------------------------------------------
  'procurement.view': {
    label: 'See what the company is buying',
    group: 'Finance',
    description: 'Open the purchasing console: every purchase request anybody has raised, what it costs, the justification behind it, the approval chain it is in and who it is currently waiting on, plus every purchase order and receipt. It shows spending across the whole organization, not one team. It does NOT let the holder approve a request — approval is routed to the requester\'s own manager and department head.',
  },
  'procurement.manage': {
    label: 'Raise purchase orders and manage vendors',
    group: 'Finance',
    description: 'Turn an ALREADY-APPROVED purchase request into a purchase order against a supplier, confirm that the item arrived and record its asset tag, and add or retire a vendor. This commits the company to a supplier, so it is separate from merely reading the purchasing record — the same split as approving a withdrawal versus releasing the money. It still confers no approval over anybody\'s request.',
    sensitive: true,
  },

  // ---------------------------------------------------------------------------------------------
  // PERFORMANCE, SKILLS AND LEARNING. Read the description of each one as what it SAYS: "across the
  // whole organization, without a relationship". None of them makes the holder anybody's manager —
  // seeing one person's goals, writing their appraisal or assigning them a course is resolved from
  // the Organization Graph per ROW, and a capability cannot express "this person and not that one".
  // Granting one of these to cover managers hands every holder authority over every employee.
  // ---------------------------------------------------------------------------------------------
  'performance.manage': {
    label: 'Run appraisal cycles for everyone',
    group: 'People',
    description: 'Open and close appraisal cycles, move a cycle between self-assessment, manager review and calibration, adjust a rating for somebody who does not report to you, and record an outcome. A reporting manager writes their own reports\' reviews through the reporting line and needs none of this.',
    sensitive: true,
  },
  'skills.manage': {
    label: 'Maintain the skill catalogue',
    group: 'People',
    description: 'Add, describe and retire skills, and record a skill level for anybody in the organization. Employees always record their own; a manager records their reports\'. This is the org-wide version, and it is what the department skill matrix is read with.',
  },
  'learning.assign': {
    label: 'Assign learning to anyone',
    group: 'People',
    description: 'Assign a course to any employee with a due date, and schedule or cancel anything on the training calendar. A manager assigns to their own reports through the reporting line; this is the version that reaches the whole organization. EduRankAI is the technology platform — accredited partners award the credentials.',
  },
  'settings.view': { label: 'View settings', group: 'System', description: 'See platform configuration.' },
  'settings.edit': {
    label: 'Edit settings',
    group: 'System',
    description: 'Change platform configuration, including integrations and mail.',
    sensitive: true,
  },
  'audit.view': {
    label: 'Read the audit log',
    group: 'System',
    description: 'Read the record of who did what. Granting it is itself worth recording.',
    sensitive: true,
  },

  // ---------------------------------------------------------------------------------------------
  // WORKPLACE SERVICES. Three keys, three admin surfaces, and each description says what the holder
  // will actually be looking at - because "manage the helpdesk" reads like a chore and the thing
  // behind it is other people's problems in their own words.
  // ---------------------------------------------------------------------------------------------
  'helpdesk.manage': {
    label: 'Run the helpdesk',
    group: 'People',
    description: 'Open every ticket on every desk - IT, HR, Finance, Admin and asset requests - and act on it: assign it, move it through its states, resolve it and close it. An IT ticket carries device, account and access detail; an HR ticket often carries something the person did not feel able to raise with their own manager. Grant it to the people who actually answer tickets.',
    sensitive: true,
  },
  'assets.manage': {
    label: 'Keep the asset register',
    group: 'People',
    description: 'Record company equipment and licences, issue them to named employees, take them back, log damage and retire them. As well as a hardware list this is a claim about people - who is holding what, and since when - and it is what a separation checklist is settled against.',
  },
  'documents.manage': {
    label: 'Curate the document library',
    group: 'Content',
    description: 'Create folders and categories, set retention, publish an approved document and share one beyond the people it was shared with. Documents here are links, never uploads. This key does NOT confer approval of a document: that is routed per document through the Organization Graph, so a curator with no relationship to the owner approves nothing.',
  },

  // ---------------------------------------------------------------------------------------------
  // WORKING TIME AND AGGREGATE REPORTING. Neither key approves anything: an attendance correction is
  // routed per row through src/lib/workflow.ts in the `attendance` domain, which carries no standing
  // capability at all, so the reporting manager the Organization Graph names decides it and their
  // in-force delegate may stand in. The derivation of both grant sets is written above PERMS_BY_ROLE
  // in src/lib/auth/permissions.ts.
  // ---------------------------------------------------------------------------------------------
  'attendance.roster.manage': {
    label: 'Define shifts, rosters and holidays',
    group: 'People',
    description: 'Define working-time patterns, put people on them from a date, record the holiday calendar, and register the QR stations a check-in can be scanned at. It sets what is EXPECTED of a working day; it decides no request and puts nobody on an approval route. Every employee reads their own shift and the holiday list without this. A scan or a location recorded beside a punch is evidence for a person to read, never a rule: nothing in the attendance module can refuse a punch, mark one as suspicious or reduce anybody\'s hours from a signal.',
  },
  'analytics.view': {
    label: 'Open workforce analytics',
    group: 'People',
    description: 'Open the aggregate reporting console: headcount, departments, attendance, leave, recruitment and performance. AGGREGATE ONLY — every query behind it is a count, an average or a breakdown, none of them returns a row per person, and there is no drill-down to one. Anything covering fewer than the platform minimum group size is withheld, and its breakdown total is withheld with it so the missing number cannot be subtracted back out. No individual health or wellness data is read behind this key by anybody, including the founder; that is enforced by the absence of the query rather than by this permission.',
    sensitive: true,
  },

  // ---------------------------------------------------------------------------------------------
  // THE EMPLOYEE REFERRAL PROGRAMME. Two keys, neither of which approves a payment — the reward is
  // routed per referrer through the Organization Graph by src/lib/workflow.ts, whose `recruitment`
  // domain carries no standing capability at all. The full derivation of both grant sets is written
  // above PERMS_BY_ROLE in src/lib/auth/permissions.ts.
  // ---------------------------------------------------------------------------------------------
  'referrals.view': {
    label: 'View employee referrals',
    group: 'Hiring',
    description: 'Open the referral programme: who referred whom, the candidate\'s name, email address and CV link, and where each referral has got to in the pipeline. The same class of candidate detail as the applicant pipeline itself, reached from the employee end.',
  },
  'referrals.reward': {
    label: 'Price and submit a referral reward',
    group: 'Hiring',
    description: 'Record that a referral earns an amount, and send that amount into approval. It does NOT approve the reward and it does NOT pay it: the decision belongs to whoever the Organization Graph routes the request to, and releasing the money is a separate permission in the payouts console. Whoever holds this decides what a referral is worth, so grant it where pricing a payment is genuinely part of the job.',
    sensitive: true,
  },
};

/** Every built-in permission key, at runtime. Derived — it cannot drift from the union. */
export const BUILTIN_PERMISSION_KEYS: string[] = Object.keys(BUILTIN_PERMISSIONS);

/**
 * Must this grant be provably on the record?
 *
 * Decided in CODE, and only ever ADDED to what the catalogue row says. The row is writable from the
 * admin panel, and a row claiming is_sensitive=false would otherwise route a grant of admin.access
 * down the ordinary audit path — whose write failure logAudit() swallows by design. Reading
 * sensitivity from data alone would mean the thing being protected could turn its own protection
 * off. admin.access is pinned true whatever any row or any future edit to the map above says.
 */
export function isSensitiveKey(key: string, catalogueSaysSensitive: boolean): boolean {
  if (key === PERM_ADMIN_ACCESS) return true;
  if (catalogueSaysSensitive) return true;
  return BUILTIN_PERMISSIONS[key as Permission]?.sensitive === true;
}

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface PermissionRecord {
  key: string;
  label: string;
  group: string;
  description: string | null;
  /** True when the key came from the code catalogue above rather than from an admin. */
  isBuiltin: boolean;
  isSensitive: boolean;
  sortOrder: number;
}

export interface RoleRecord {
  id: string;
  name: string;
  /** The stable key set at creation. Null for roles created before the column existed. */
  key: string | null;
  description: string | null;
  color: string;
  isSystem: boolean;
  /** How many people hold this role right now. deleteRole() refuses while this is above zero. */
  memberCount: number;
  permissionCount: number;
  /** Surfaced on the list so nobody has to open a role to discover it opens the console. */
  grantsAdminAccess: boolean;
  createdAt: string | null;
}

export interface RoleGrantRecord {
  key: string;
  label: string;
  group: string;
  isSensitive: boolean;
  /**
   * 'grant'         — an explicit row in role_permission_grants (this registry).
   * 'section-matrix' — derived from the page-key checkboxes /admin/team/roles already writes into
   *                    role_permissions. Shown so an admin can SEE where an ability came from
   *                    instead of wondering why a role can do something no grant mentions.
   */
  source: 'grant' | 'section-matrix';
  grantedByEmail: string | null;
  grantedAt: string | null;
}

/** Everything a person may do, plus how confident we are in the answer. */
export interface ResolvedPermissions {
  userId: string;
  /** The built-in role on users.role, or null when the account could not be read. */
  role: string | null;
  /**
   * The answer. Empty whenever `degraded` is true — see the invariant at the top of this file.
   * Contains WILDCARD for super_admin; use holdsPermission()/hasPermission() rather than .has().
   */
  permissions: Set<string>;
  customRoles: { id: string; name: string }[];
  /** True when something failed. An empty set with degraded=false means "genuinely nothing". */
  degraded: boolean;
  reason: 'ok' | 'no-user-id' | 'not-found' | 'account-disabled' | 'lookup-failed';
}

export interface Actor {
  id: string;
  email?: string | null;
  name?: string | null;
  ip?: string | null;
}

export type RegistryResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };

const fail = (error: string): RegistryResult<never> => ({ ok: false, error });

// ---------------------------------------------------------------------------------------------
// Schema — self-bootstrapping. No migrations exist on this project.
// ---------------------------------------------------------------------------------------------

// The three tables that already exist are (re)declared IF NOT EXISTS so a fresh database bootstraps
// to the SAME shape src/lib/db/schema.ts describes. On production every one of these is a no-op.
//
// Deliberately NOT added to user_role_assignments: a UNIQUE (user_id, role_id) constraint. It is the
// right shape, but adding a unique index to a live table fails outright if a duplicate pair already
// exists — turning one bad row into a total outage of this module. Duplicates are handled in code
// instead (resolvePermissions unions, assignments are checked before insert).
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS team_roles (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name VARCHAR(80) NOT NULL UNIQUE,
     description TEXT,
     color VARCHAR(20) NOT NULL DEFAULT 'orange',
     is_system BOOLEAN NOT NULL DEFAULT false,
     created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS description TEXT`,
  `ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS color VARCHAR(20) NOT NULL DEFAULT 'orange'`,
  `ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  // The stable identifier. `name` is the label an admin edits — "Assam Region Lead" becomes "North
  // East Lead" and anything that referenced it by name is now referencing nothing. role_key is set
  // once, at creation, and never changed, so a script or a config file can name a role and still
  // mean the same role a year later.
  //
  // Nullable, and every existing row starts NULL — which is why the UNIQUE index below is safe to
  // add to a live table. The general warning at the top of this list (a unique index fails outright
  // if the data already conflicts) does not apply to a column that has no values yet, and NULLs do
  // not conflict with each other in a Postgres unique index.
  `ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS role_key VARCHAR(80)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS team_roles_role_key_uidx ON team_roles (role_key) WHERE role_key IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS role_permissions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     role_id UUID NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
     page_key VARCHAR(80) NOT NULL,
     can_view BOOLEAN NOT NULL DEFAULT false,
     can_edit BOOLEAN NOT NULL DEFAULT false,
     can_delete BOOLEAN NOT NULL DEFAULT false,
     can_export BOOLEAN NOT NULL DEFAULT false)`,
  `CREATE INDEX IF NOT EXISTS role_permissions_role_idx ON role_permissions (role_id)`,

  `CREATE TABLE IF NOT EXISTS user_role_assignments (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role_id UUID NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
     assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS user_role_assign_user_idx ON user_role_assignments (user_id)`,
  `CREATE INDEX IF NOT EXISTS user_role_assign_role_idx ON user_role_assignments (role_id)`,

  // THE CATALOGUE. Permissions live here as rows, which is the whole point of the module: a new
  // permission is an INSERT, not a union member, a build and a deploy.
  `CREATE TABLE IF NOT EXISTS permission_catalogue (
     key TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     group_key TEXT NOT NULL DEFAULT 'Other',
     description TEXT,
     is_builtin BOOLEAN NOT NULL DEFAULT false,
     is_sensitive BOOLEAN NOT NULL DEFAULT false,
     sort_order INTEGER NOT NULL DEFAULT 100,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS permission_catalogue_group_idx ON permission_catalogue (group_key, sort_order)`,

  // WHO HOLDS WHAT. The permission_key FK is ON DELETE RESTRICT on purpose: a permission that is
  // still granted to somebody cannot be quietly deleted out from under them.
  //
  // granted_by_email is denormalised deliberately. "Who granted admin.access" must still have an
  // answer after that person's account is deleted, and a UUID pointing at a dead row is not one.
  `CREATE TABLE IF NOT EXISTS role_permission_grants (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     role_id UUID NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
     permission_key TEXT NOT NULL REFERENCES permission_catalogue(key) ON DELETE RESTRICT,
     granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     granted_by_email TEXT,
     reason TEXT,
     granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (role_id, permission_key))`,
  `CREATE INDEX IF NOT EXISTS role_permission_grants_role_idx ON role_permission_grants (role_id)`,
  `CREATE INDEX IF NOT EXISTS role_permission_grants_key_idx ON role_permission_grants (permission_key)`,
];

/** Every permission the code knows about, ready to seed. Pure — no database, safe to unit test. */
export function seedCatalogueRows(): (PermissionMeta & { key: string; isBuiltin: boolean; sortOrder: number })[] {
  const out: (PermissionMeta & { key: string; isBuiltin: boolean; sortOrder: number })[] = [];
  const seen = new Set<string>();

  // 1. The built-in union, first, so it wins any key collision with a derived one below.
  let i = 0;
  for (const key of BUILTIN_PERMISSION_KEYS) {
    const meta = BUILTIN_PERMISSIONS[key as Permission];
    out.push({ key, ...meta, isBuiltin: true, sortOrder: i++ });
    seen.add(key);
  }

  // 2. The admin sections, as `<section>.<action>`. This is the SAME key shape the existing
  //    /admin/team/roles matrix produces (page_key + a checkbox), so the two systems name the same
  //    ability the same way and a legacy row folds into the catalogue instead of shadowing it.
  //    Adding a section to src/lib/admin-sections.ts therefore adds four grantable permissions with
  //    no code change here.
  const ACTION_LABEL: [SectionAction, string][] = [
    ['view', 'View'], ['edit', 'Edit'], ['delete', 'Delete'], ['export', 'Export'],
  ];
  let order = 1000;
  for (const group of ADMIN_SECTION_GROUPS) {
    for (const section of group.sections) {
      for (const [action, verb] of ACTION_LABEL) {
        const key = section.key + '.' + action;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          key,
          label: verb + ' ' + section.label,
          group: group.label,
          description: (section.hint ? section.hint + '. ' : '') + verb + ' access to the ' + section.label + ' section of the admin console.',
          // Deleting is the irreversible one, so it is flagged everywhere rather than only where
          // somebody remembered to.
          sensitive: action === 'delete',
          isBuiltin: false,
          sortOrder: order++,
        });
      }
    }
  }
  return out;
}

/**
 * Create anything missing and seed the catalogue. Idempotent, and runs at most once per process
 * (ensureOnce). Called at the top of every public function in this file, so no caller has to
 * remember it.
 */
export function ensureRegistrySchema(): Promise<void> {
  return ensureOnce('auth_registry_v1', async () => {
    for (const stmt of DDL) await db.execute(sql.raw(stmt));

    const all = seedCatalogueRows();
    const builtin = all.filter((p) => p.isBuiltin);
    const derived = all.filter((p) => !p.isBuiltin);

    // Built-ins are code-owned: their wording is re-asserted on every boot so an edit to this file
    // reaches the admin UI. is_builtin is forced true so a hand-inserted row cannot masquerade.
    if (builtin.length > 0) {
      const values = sql.join(
        builtin.map((p) => sql`(${p.key}, ${p.label}, ${p.group}, ${p.description}, true, ${!!p.sensitive}, ${p.sortOrder})`),
        sql`, `,
      );
      await db.execute(sql`
        INSERT INTO permission_catalogue (key, label, group_key, description, is_builtin, is_sensitive, sort_order)
        VALUES ${values}
        ON CONFLICT (key) DO UPDATE SET
          label = EXCLUDED.label,
          group_key = EXCLUDED.group_key,
          description = EXCLUDED.description,
          is_builtin = true,
          is_sensitive = EXCLUDED.is_sensitive,
          sort_order = EXCLUDED.sort_order`);
    }

    // Section-derived entries seed once and are then left alone: an admin who renames one in the
    // console should not have it overwritten on the next deploy.
    if (derived.length > 0) {
      const CHUNK = 200; // one statement never gets absurdly large
      for (let i = 0; i < derived.length; i += CHUNK) {
        const part = derived.slice(i, i + CHUNK);
        const values = sql.join(
          part.map((p) => sql`(${p.key}, ${p.label}, ${p.group}, ${p.description}, false, ${!!p.sensitive}, ${p.sortOrder})`),
          sql`, `,
        );
        await db.execute(sql`
          INSERT INTO permission_catalogue (key, label, group_key, description, is_builtin, is_sensitive, sort_order)
          VALUES ${values}
          ON CONFLICT (key) DO NOTHING`);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Audit. Everything that changes who can do what goes through here.
// ---------------------------------------------------------------------------------------------

interface AuditInput {
  actor: Actor;
  action: string;
  entity: string;
  entityId: string;
  diff: Record<string, unknown>;
}

/**
 * Ordinary audit write: src/lib/audit.ts, which swallows its own failures so a logging hiccup never
 * blocks somebody's work. Right for `content.view`; not right for admin.access.
 */
async function record(input: AuditInput): Promise<void> {
  await logAudit({
    userId: input.actor.id || null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    diff: input.diff,
    ipAddress: input.actor.ip || undefined,
  });
}

/**
 * The same row, written so that a failure is VISIBLE. logAudit() catches and logs; this throws, and
 * the caller undoes the change it was recording.
 *
 * "Granting admin.access must write an audit entry naming who granted it" is only true if the grant
 * cannot outlive a failed write. Same table, same shape, same reader — only the error handling
 * differs.
 */
async function recordStrict(input: AuditInput): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_log (user_id, action, entity, entity_id, diff, ip_address)
    VALUES (${input.actor.id || null}, ${input.action}, ${input.entity}, ${input.entityId},
            ${JSON.stringify(input.diff)}::jsonb, ${input.actor.ip || null})`);
}

/** Who did it, in a form that survives the account being deleted. Included in every diff. */
function actorFacts(actor: Actor): Record<string, unknown> {
  return {
    byUserId: actor.id || null,
    byEmail: actor.email || null,
    byName: actor.name || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

const mapPermission = (r: any): PermissionRecord => ({
  key: String(r.key),
  label: String(r.label || r.key),
  group: String(r.group_key || 'Other'),
  description: r.description ?? null,
  isBuiltin: r.is_builtin === true,
  isSensitive: r.is_sensitive === true,
  sortOrder: Number(r.sort_order) || 0,
});

/**
 * The catalogue: every permission that exists, grouped for the editor UI.
 *
 * Read this instead of hardcoding a list. It is what makes /admin/team/roles able to offer a
 * permission that was invented after the page was written.
 */
export async function listPermissions(opts: { group?: string } = {}): Promise<PermissionRecord[]> {
  try {
    await ensureRegistrySchema();
    const where = opts.group ? sql`WHERE group_key = ${opts.group}` : sql``;
    const r = await db.execute(sql`
      SELECT key, label, group_key, description, is_builtin, is_sensitive, sort_order
        FROM permission_catalogue
        ${where}
       ORDER BY sort_order ASC, key ASC`);
    return rows(r).map(mapPermission);
  } catch (e: any) {
    logFail('auth.registry.listPermissions', e);
    return [];
  }
}

/** The catalogue grouped the way the editor renders it, without a second pass in the .astro file. */
export async function listPermissionGroups(): Promise<{ label: string; permissions: PermissionRecord[] }[]> {
  const all = await listPermissions();
  const order: string[] = [];
  const byGroup = new Map<string, PermissionRecord[]>();
  for (const p of all) {
    if (!byGroup.has(p.group)) { byGroup.set(p.group, []); order.push(p.group); }
    (byGroup.get(p.group) as PermissionRecord[]).push(p);
  }
  return order.map((label) => ({ label, permissions: byGroup.get(label) || [] }));
}

/**
 * Custom roles, with the two numbers an admin actually needs before touching one: how many people
 * hold it, and whether it opens the console.
 */
export async function listRoles(): Promise<RoleRecord[]> {
  try {
    await ensureRegistrySchema();
    const r = await db.execute(sql`
      SELECT tr.id, tr.name, tr.role_key, tr.description, tr.color, tr.is_system, tr.created_at,
             (SELECT COUNT(*)::int FROM user_role_assignments ura WHERE ura.role_id = tr.id) AS member_count,
             (SELECT COUNT(*)::int FROM role_permission_grants g WHERE g.role_id = tr.id) AS permission_count,
             EXISTS (SELECT 1 FROM role_permission_grants g
                      WHERE g.role_id = tr.id AND g.permission_key = ${PERM_ADMIN_ACCESS}) AS grants_admin
        FROM team_roles tr
       ORDER BY tr.name ASC`);
    return rows(r).map((x: any) => ({
      id: String(x.id),
      name: String(x.name),
      key: x.role_key ? String(x.role_key) : null,
      description: x.description ?? null,
      color: String(x.color || 'orange'),
      isSystem: x.is_system === true,
      memberCount: Number(x.member_count) || 0,
      permissionCount: Number(x.permission_count) || 0,
      grantsAdminAccess: x.grants_admin === true,
      createdAt: x.created_at ? String(x.created_at) : null,
    }));
  } catch (e: any) {
    logFail('auth.registry.listRoles', e);
    return [];
  }
}

/**
 * What one role grants — explicit grants AND the abilities implied by the section-matrix rows the
 * existing editor writes, labelled by source so an admin can tell them apart.
 *
 * Showing both is the point. A role can already do things through role_permissions that no grant
 * row mentions, and a screen that hides that is a screen that lies about access.
 */
export async function permissionsForRole(roleId: string): Promise<RoleGrantRecord[]> {
  if (!roleId) return [];
  try {
    await ensureRegistrySchema();
    const r = await db.execute(sql`
      SELECT s.key, s.source, s.granted_by_email, s.granted_at,
             COALESCE(c.label, s.key) AS label,
             COALESCE(c.group_key, 'Other') AS group_key,
             COALESCE(c.is_sensitive, false) AS is_sensitive,
             COALESCE(c.sort_order, 9999) AS sort_order
        FROM (
          SELECT g.permission_key AS key, 'grant' AS source, g.granted_by_email, g.granted_at
            FROM role_permission_grants g WHERE g.role_id = ${roleId}::uuid
          UNION ALL
          SELECT x.key, 'section-matrix' AS source, NULL::text, NULL::timestamptz
            FROM (
              SELECT rp.page_key || '.view'   AS key FROM role_permissions rp WHERE rp.role_id = ${roleId}::uuid AND rp.can_view
              UNION SELECT rp.page_key || '.edit'    FROM role_permissions rp WHERE rp.role_id = ${roleId}::uuid AND rp.can_edit
              UNION SELECT rp.page_key || '.delete'  FROM role_permissions rp WHERE rp.role_id = ${roleId}::uuid AND rp.can_delete
              UNION SELECT rp.page_key || '.export'  FROM role_permissions rp WHERE rp.role_id = ${roleId}::uuid AND rp.can_export
            ) x
           WHERE NOT EXISTS (
             SELECT 1 FROM role_permission_grants g2
              WHERE g2.role_id = ${roleId}::uuid AND g2.permission_key = x.key)
        ) s
        LEFT JOIN permission_catalogue c ON c.key = s.key
       ORDER BY sort_order ASC, s.key ASC`);
    return rows(r).map((x: any) => ({
      key: String(x.key),
      label: String(x.label),
      group: String(x.group_key),
      isSensitive: x.is_sensitive === true,
      source: x.source === 'grant' ? 'grant' : 'section-matrix',
      grantedByEmail: x.granted_by_email ?? null,
      grantedAt: x.granted_at ? String(x.granted_at) : null,
    }));
  } catch (e: any) {
    logFail('auth.registry.permissionsForRole', e);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// resolvePermissions — the ONE function that answers what a person may do.
// ---------------------------------------------------------------------------------------------

/**
 * The per-request memo. One entry per user id, hung on Astro's `locals` exactly like
 * src/lib/vsm/memo.ts, so a page that checks eight permissions pays for one resolve.
 *
 * NOT a process cache, deliberately. Caching an answer across requests means a revoked permission
 * keeps working until a TTL expires, and "we removed their access an hour ago" has to be true the
 * moment it is said.
 */
function memoOf(locals: any): Map<string, Promise<ResolvedPermissions>> | null {
  if (!locals || typeof locals !== 'object') return null;
  // Wrapped because this is the ONE statement in resolvePermissions that sits outside its try, and
  // it WRITES to an object it did not create. A frozen or proxied `locals` throws on assignment,
  // and an exception escaping an authorisation function is not a denial — it is a 500 whose meaning
  // the caller has to guess. A memo is an optimisation; losing it costs a query, not a decision.
  try {
    if (!locals.__permRegistryMemo) locals.__permRegistryMemo = new Map<string, Promise<ResolvedPermissions>>();
    const memo = locals.__permRegistryMemo;
    return memo instanceof Map ? memo : null;
  } catch {
    return null;
  }
}

/** Drop a memoised answer — call after granting or revoking inside the same request. */
export function invalidateResolved(locals: any, userId?: string): void {
  const memo = memoOf(locals);
  if (!memo) return;
  if (userId) memo.delete('u:' + userId); else memo.clear();
}

function denied(userId: string, r: ResolvedPermissions['reason'], role: string | null = null): ResolvedPermissions {
  return { userId, role, permissions: new Set<string>(), customRoles: [], degraded: r !== 'not-found' && r !== 'account-disabled', reason: r };
}

/**
 * Everything this person may do, merged from every source, in one answer.
 *
 *   built-in role  -> PERMS_BY_ROLE (code; the existing matrix, unchanged)
 *   super_admin    -> WILDCARD, so a permission invented tomorrow is already held
 *   custom roles   -> explicit grants in role_permission_grants
 *                  -> plus the page-key matrix in role_permissions, as `<page_key>.<action>`
 *
 * A custom role ADDS to the built-in role; it never subtracts. There is no deny rule, on purpose —
 * "this role removes a permission the built-in role grants" reads clearly in an editor and is
 * impossible to reason about at three in the morning during an incident. To take an ability away,
 * change the built-in role.
 *
 * A legacy section-matrix row can NEVER produce admin.access, whatever page_key somebody types.
 * That permission is grantable only as itself, deliberately, by name, with an audit entry — because
 * a checkbox that quietly opens the console is the incident this module was written after.
 *
 * FAILS CLOSED. Any error returns an empty set with degraded=true. Callers that must keep working
 * during a database outage should use can() from permissions.ts, which needs no database at all.
 */
export async function resolvePermissions(
  userId: string,
  opts: { locals?: any } = {},
): Promise<ResolvedPermissions> {
  if (!userId) return denied('', 'no-user-id');

  const memo = memoOf(opts.locals);
  const memoKey = 'u:' + userId;
  const cached = memo?.get(memoKey);
  if (cached) return cached;

  const work = (async (): Promise<ResolvedPermissions> => {
    try {
      await ensureRegistrySchema();

      // One round trip for the account AND its custom roles. LEFT JOIN so a person with no custom
      // role still returns their row rather than looking like a missing account.
      const head = rows(await db.execute(sql`
        SELECT u.role, u.is_active, tr.id AS role_id, tr.name AS role_name
          FROM users u
          LEFT JOIN user_role_assignments ura ON ura.user_id = u.id
          LEFT JOIN team_roles tr ON tr.id = ura.role_id
         WHERE u.id = ${userId}::uuid`));

      if (head.length === 0) return denied(userId, 'not-found');

      const role = String(head[0].role || '').trim() || null;
      // A deactivated account keeps its role. Checked separately so the reason is honest.
      if (head[0].is_active === false) return denied(userId, 'account-disabled', role);

      const customRoles: { id: string; name: string }[] = [];
      const seenRole = new Set<string>();
      for (const h of head) {
        if (!h.role_id) continue;
        const id = String(h.role_id);
        if (seenRole.has(id)) continue;   // duplicate assignment rows are tolerated, not counted twice
        seenRole.add(id);
        customRoles.push({ id, name: String(h.role_name || 'role') });
      }

      const permissions = new Set<string>();
      for (const p of (PERMS_BY_ROLE[role as User['role']] || [])) permissions.add(p);
      if (role === 'super_admin') permissions.add(WILDCARD);

      if (customRoles.length > 0) {
        const ids = sql.join(customRoles.map((r) => sql`${r.id}::uuid`), sql`, `);
        // customRoleKeys() has already excluded admin.access from the section-matrix arm, so no
        // page-key row can spell its way to the console however this set is used.
        for (const key of await customRoleKeys(ids)) permissions.add(key);
      }

      return { userId, role, permissions, customRoles, degraded: false, reason: 'ok' };
    } catch (e: any) {
      // THE INVARIANT. No exception path adds a permission — this one returns nothing at all.
      logEvent('error', 'auth.registry.resolve-failed', { userId, message: reason(e) });
      return denied(userId, 'lookup-failed');
    }
  })();

  memo?.set(memoKey, work);
  return work;
}

/**
 * The permission keys a set of custom roles grants: explicit grants UNION the section matrix.
 *
 * Two-step on purpose. role_permission_grants is new, and on a database where its DDL has not run
 * yet (a blocked deploy, a replica behind) the first query fails — at which point falling straight
 * to "deny everyone" would take the console down for a system that has worked for months. So the
 * fallback re-asks the LEGACY table alone, which is exactly today's behaviour and cannot grant more
 * than today grants. If that fails too, the error propagates and resolvePermissions denies.
 */
async function customRoleKeys(ids: any): Promise<string[]> {
  // `admin.access` is filtered out of the section-matrix arm, not merely absent from it: page_key is
  // free text written by a form, and `<page_key>.<action>` must not be able to spell it.
  const legacyArm = sql`
      SELECT rp.page_key || '.view'   AS k FROM role_permissions rp WHERE rp.role_id IN (${ids}) AND rp.can_view
      UNION SELECT rp.page_key || '.edit'   FROM role_permissions rp WHERE rp.role_id IN (${ids}) AND rp.can_edit
      UNION SELECT rp.page_key || '.delete' FROM role_permissions rp WHERE rp.role_id IN (${ids}) AND rp.can_delete
      UNION SELECT rp.page_key || '.export' FROM role_permissions rp WHERE rp.role_id IN (${ids}) AND rp.can_export`;

  try {
    const r = await db.execute(sql`
      SELECT k FROM (
        SELECT g.permission_key AS k FROM role_permission_grants g WHERE g.role_id IN (${ids})
        UNION
        SELECT k FROM (${legacyArm}) legacy WHERE k <> ${PERM_ADMIN_ACCESS}
      ) merged`);
    return rows(r).map((x: any) => String(x.k)).filter(Boolean);
  } catch (e: any) {
    logEvent('warn', 'auth.registry.grants-unavailable', { message: reason(e) });
    const r = await db.execute(sql`SELECT k FROM (${legacyArm}) legacy WHERE k <> ${PERM_ADMIN_ACCESS}`);
    return rows(r).map((x: any) => String(x.k)).filter(Boolean);
  }
}

/** Wildcard-aware membership test. Use this rather than `resolved.permissions.has(key)`. */
export function holdsPermission(resolved: ResolvedPermissions | null | undefined, key: string): boolean {
  if (!resolved || !key) return false;
  return resolved.permissions.has(WILDCARD) || resolved.permissions.has(key);
}

/**
 * The single test callers use.
 *
 *   if (!(await hasPermission(user.id, 'offers.edit', { locals: Astro.locals }))) return deny();
 *
 * Pass `locals` wherever you have it: the resolve is then memoised for the rest of the request and
 * eight checks on one page cost one lookup.
 */
export async function hasPermission(userId: string, key: string, opts: { locals?: any } = {}): Promise<boolean> {
  if (!userId || !key) return false;
  const resolved = await resolvePermissions(userId, opts);
  return holdsPermission(resolved, key);
}

/** True only if the person holds EVERY key. Same fail-closed behaviour. */
export async function hasAllPermissions(userId: string, keys: string[], opts: { locals?: any } = {}): Promise<boolean> {
  if (!userId || !keys?.length) return false;
  const resolved = await resolvePermissions(userId, opts);
  return keys.every((k) => holdsPermission(resolved, k));
}

// ---------------------------------------------------------------------------------------------
// Writes. Every one of them is audited.
// ---------------------------------------------------------------------------------------------

async function roleRow(roleId: string): Promise<{ id: string; name: string; isSystem: boolean } | null> {
  const r = rows(await db.execute(sql`SELECT id, name, is_system FROM team_roles WHERE id = ${roleId}::uuid LIMIT 1`))[0];
  return r ? { id: String(r.id), name: String(r.name), isSystem: r.is_system === true } : null;
}

async function permissionRow(key: string): Promise<{ key: string; label: string; isSensitive: boolean } | null> {
  const r = rows(await db.execute(sql`SELECT key, label, is_sensitive FROM permission_catalogue WHERE key = ${key} LIMIT 1`))[0];
  return r ? { key: String(r.key), label: String(r.label), isSensitive: r.is_sensitive === true } : null;
}

/**
 * Create a custom role. Empty of permissions until somebody grants some, which is the correct
 * starting point: a new role that can do nothing is safe, a new role that inherits "roughly what
 * the last one had" is how an intern gets admin.access.
 */
export async function createRole(
  input: { name: string; key?: string | null; description?: string | null; color?: string | null },
  actor: Actor,
): Promise<RegistryResult<{ id: string; key: string }>> {
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim() || null;
  const color = String(input.color || 'orange').trim().slice(0, 20) || 'orange';
  // Blank is the normal case: derive the key from the name rather than making somebody invent one.
  const key = slugifyRoleKey(String(input.key || '').trim() || name);

  if (name.length < ROLE_NAME_MIN) return fail('Give the role a name of at least ' + ROLE_NAME_MIN + ' characters.');
  if (name.length > ROLE_NAME_MAX) return fail('Role names are limited to ' + ROLE_NAME_MAX + ' characters.');
  if (!ROLE_KEY_RE.test(key)) {
    return fail('A role key looks like "hei-editor": lowercase letters, digits, dashes or underscores, at least two characters.');
  }
  if (!actor?.id) return fail('A signed-in person must be recorded as creating the role.');

  try {
    await ensureRegistrySchema();
    const clash = rows(await db.execute(sql`SELECT id FROM team_roles WHERE lower(name) = ${name.toLowerCase()} LIMIT 1`));
    if (clash.length > 0) return fail('A role called "' + name + '" already exists.');
    const keyClash = rows(await db.execute(sql`SELECT name FROM team_roles WHERE role_key = ${key} LIMIT 1`));
    if (keyClash.length > 0) return fail('The key "' + key + '" is already used by "' + String(keyClash[0].name) + '". Keys are permanent, so pick another.');

    const created = rows(await db.execute(sql`
      INSERT INTO team_roles (name, role_key, description, color, created_by_user_id)
      VALUES (${name}, ${key}, ${description}, ${color}, ${actor.id}::uuid)
      RETURNING id`))[0];
    const id = String(created.id);

    await record({
      actor, action: 'role.create', entity: 'team_role', entityId: id,
      diff: { name, key, description, color, ...actorFacts(actor) },
    });
    return { ok: true, data: { id, key } };
  } catch (e: any) {
    logFail('auth.registry.createRole', e);
    return fail(reason(e));
  }
}

/**
 * Rename or re-describe a role. Its permissions are changed with applyRolePermissions(), not here.
 *
 * The KEY is deliberately one-way. It can be filled in when it is missing — every role created
 * before the column existed has none — and once it holds a value it cannot be changed, because a
 * key that can be edited is just a second name and is worth nothing to whatever referenced it.
 */
export async function updateRole(
  roleId: string,
  patch: { name?: string; key?: string | null; description?: string | null; color?: string | null },
  actor: Actor,
): Promise<RegistryResult> {
  if (!roleId) return fail('No role given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as making the change.');

  try {
    await ensureRegistrySchema();
    const before = rows(await db.execute(sql`
      SELECT id, name, role_key, description, color, is_system FROM team_roles WHERE id = ${roleId}::uuid LIMIT 1`))[0];
    if (!before) return fail('No such role.');

    const name = patch.name === undefined ? String(before.name) : String(patch.name || '').trim();
    if (name.length < ROLE_NAME_MIN) return fail('Give the role a name of at least ' + ROLE_NAME_MIN + ' characters.');
    if (name.length > ROLE_NAME_MAX) return fail('Role names are limited to ' + ROLE_NAME_MAX + ' characters.');
    // A system role is referenced by name elsewhere; renaming it silently breaks those references.
    if (before.is_system === true && name !== String(before.name)) {
      return fail('This is a system role. Its name is referenced elsewhere and cannot be changed here.');
    }

    const clash = rows(await db.execute(sql`
      SELECT id FROM team_roles WHERE lower(name) = ${name.toLowerCase()} AND id <> ${roleId}::uuid LIMIT 1`));
    if (clash.length > 0) return fail('Another role is already called "' + name + '".');

    const description = patch.description === undefined
      ? (before.description ?? null)
      : (String(patch.description || '').trim() || null);
    const color = patch.color === undefined
      ? String(before.color || 'orange')
      : (String(patch.color || 'orange').trim().slice(0, 20) || 'orange');

    const existingKey = before.role_key ? String(before.role_key) : null;
    let key = existingKey;
    const wantedKey = patch.key === undefined ? null : slugifyRoleKey(String(patch.key || '').trim());
    if (wantedKey && wantedKey !== existingKey) {
      if (existingKey) return fail('The key "' + existingKey + '" is permanent. Anything referencing this role uses it, and changing it would break those references silently.');
      if (!ROLE_KEY_RE.test(wantedKey)) {
        return fail('A role key looks like "hei-editor": lowercase letters, digits, dashes or underscores, at least two characters.');
      }
      const keyClash = rows(await db.execute(sql`
        SELECT name FROM team_roles WHERE role_key = ${wantedKey} AND id <> ${roleId}::uuid LIMIT 1`));
      if (keyClash.length > 0) return fail('The key "' + wantedKey + '" is already used by "' + String(keyClash[0].name) + '".');
      key = wantedKey;
    }

    await db.execute(sql`
      UPDATE team_roles SET name = ${name}, role_key = ${key}, description = ${description}, color = ${color}, updated_at = NOW()
       WHERE id = ${roleId}::uuid`);

    await record({
      actor, action: 'role.update', entity: 'team_role', entityId: roleId,
      diff: {
        before: { name: before.name, key: existingKey, description: before.description ?? null, color: before.color },
        after: { name, key, description, color },
        ...actorFacts(actor),
      },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.updateRole', e);
    return fail(reason(e));
  }
}

/**
 * Delete a role — and REFUSE while anyone still holds it.
 *
 * The database would happily cascade the assignments away. That is precisely the failure to avoid:
 * the people holding the role silently lose whatever it granted, nobody is told which people or
 * which abilities, and the first symptom is somebody unable to do their job with no explanation.
 * Unassign them first, deliberately, and the removal is visible to whoever does it.
 */
export async function deleteRole(roleId: string, actor: Actor): Promise<RegistryResult> {
  if (!roleId) return fail('No role given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as deleting the role.');

  try {
    await ensureRegistrySchema();
    const role = await roleRow(roleId);
    if (!role) return fail('No such role.');
    if (role.isSystem) return fail('"' + role.name + '" is a system role and cannot be deleted.');

    const holders = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM user_role_assignments WHERE role_id = ${roleId}::uuid`))[0];
    const n = Number(holders?.n) || 0;
    if (n > 0) {
      return fail(
        n + (n === 1 ? ' person still holds' : ' people still hold') + ' "' + role.name + '". '
        + 'Remove them from the role first — deleting it now would take away whatever it grants '
        + 'without telling anyone.',
      );
    }

    // Captured BEFORE the delete: an audit line that says only "role deleted" cannot answer what
    // was destroyed.
    const held = rows(await db.execute(sql`
      SELECT permission_key FROM role_permission_grants WHERE role_id = ${roleId}::uuid`))
      .map((x: any) => String(x.permission_key));

    await db.execute(sql`DELETE FROM role_permission_grants WHERE role_id = ${roleId}::uuid`);
    await db.execute(sql`DELETE FROM role_permissions WHERE role_id = ${roleId}::uuid`);
    await db.execute(sql`DELETE FROM team_roles WHERE id = ${roleId}::uuid`);

    await record({
      actor, action: 'role.delete', entity: 'team_role', entityId: roleId,
      diff: { name: role.name, permissionsHeld: held, ...actorFacts(actor) },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.deleteRole', e);
    return fail(reason(e));
  }
}

/**
 * The people who hold a role right now, as a list of identifiers that survives account deletion.
 *
 * Used ONLY to enrich the admin.access audit diff, and written so it can never throw. It runs
 * between the grant INSERT and the strict audit write, and an exception there would escape to
 * assignPermission's outer catch — which returns fail() WITHOUT the rollback that the audit-failure
 * path performs, leaving a live, unaudited grant of console access behind a message saying it was
 * not granted. A degraded answer here costs a line of detail in the log; a thrown one would cost the
 * exact guarantee this module exists to make.
 *
 * Declared above its caller: `const` is not hoisted and a handler reaching a later declaration has
 * taken pages down on this project.
 */
const holdersOfRole = async (roleId: string): Promise<string[] | { unavailable: string }> => {
  try {
    const r = await db.execute(sql`
      SELECT DISTINCT COALESCE(u.email, u.name, u.id::text) AS who
        FROM user_role_assignments ura
        JOIN users u ON u.id = ura.user_id
       WHERE ura.role_id = ${roleId}::uuid
       LIMIT 500`);
    return rows(r).map((x: any) => String(x.who)).filter(Boolean);
  } catch (e: any) {
    return { unavailable: reason(e) };
  }
};

/**
 * Grant one permission to one role.
 *
 * A SENSITIVE permission (admin.access, users.edit, settings.edit, audit.view, any `.delete`) is
 * written and then AUDITED STRICTLY: if the audit row cannot be written, the grant is rolled back
 * and the caller is told. The requirement is not "log the grant if convenient" — it is that a grant
 * of admin.access cannot exist without a record naming the person who made it, and the only way to
 * mean that is to undo the grant when the record fails.
 */
export async function assignPermission(
  roleId: string,
  permissionKey: string,
  actor: Actor,
  opts: { reason?: string } = {},
): Promise<RegistryResult> {
  const key = String(permissionKey || '').trim();
  if (!roleId) return fail('No role given.');
  if (!key) return fail('No permission given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as granting the permission.');

  try {
    await ensureRegistrySchema();
    const role = await roleRow(roleId);
    if (!role) return fail('No such role.');

    const perm = await permissionRow(key);
    // Not catalogued means not grantable. A typo must fail loudly rather than create a permission
    // nothing will ever check, which reads as "granted" on a screen and grants nothing.
    if (!perm) return fail('"' + key + '" is not a known permission. Add it to the catalogue first.');

    // NOT `perm.isSensitive` on its own — see isSensitiveKey(). The catalogue row is admin-writable
    // and must not be able to demote admin.access into the swallow-on-failure audit path.
    const sensitive = isSensitiveKey(key, perm.isSensitive);

    const why = String(opts.reason || '').trim().slice(0, 2000) || null;

    const inserted = rows(await db.execute(sql`
      INSERT INTO role_permission_grants (role_id, permission_key, granted_by_user_id, granted_by_email, reason)
      VALUES (${roleId}::uuid, ${key}, ${actor.id}::uuid, ${actor.email || null}, ${why})
      ON CONFLICT (role_id, permission_key) DO NOTHING
      RETURNING id`));
    if (inserted.length === 0) return { ok: true };   // already granted; nothing changed, nothing to log

    const diff: Record<string, unknown> = {
      roleId, roleName: role.name, permissionKey: key, permissionLabel: perm.label,
      sensitive, reason: why, ...actorFacts(actor),
    };
    if (key === PERM_ADMIN_ACCESS) {
      // Written in words, in the record itself. Whoever reads this log later should not have to
      // know what the key means to understand what happened.
      diff.notice = (actor.email || actor.name || actor.id)
        + ' granted admin console access to the role "' + role.name + '".';

      // AND WHO GAINED IT. The grant is recorded against a ROLE, but the question after an incident
      // is always about PEOPLE — and everybody already in this role gains console access the instant
      // this row lands, with no assignment event of their own to find in the log. assignRoleToUser()
      // records the reverse case (person added to a role that already holds it) strictly; without
      // this, going the other way round left the same escalation with no named beneficiary anywhere.
      const holders = await holdersOfRole(roleId);
      if (Array.isArray(holders)) {
        diff.gainedConsoleAccess = holders;
        if (holders.length > 0) {
          diff.notice = String(diff.notice) + ' ' + holders.length
            + (holders.length === 1 ? ' person already in that role gains it: ' : ' people already in that role gain it: ')
            + holders.join(', ') + '.';
        }
      } else {
        // Never silently omitted: "no holders listed" and "the holder list could not be read" are
        // different facts and an audit log that conflates them is not evidence of anything.
        diff.gainedConsoleAccess = 'could not be read: ' + holders.unavailable;
      }
    }

    if (!sensitive) {
      await record({ actor, action: 'permission.grant', entity: 'role_permission', entityId: roleId + ':' + key, diff });
      return { ok: true };
    }

    try {
      await recordStrict({ actor, action: 'permission.grant.sensitive', entity: 'role_permission', entityId: roleId + ':' + key, diff });
    } catch (auditErr: any) {
      // The grant must not survive the failed record. If the rollback ALSO fails there is now an
      // unaudited sensitive grant, which is the one situation worth shouting about.
      try {
        await db.execute(sql`
          DELETE FROM role_permission_grants WHERE role_id = ${roleId}::uuid AND permission_key = ${key}`);
      } catch (rollbackErr: any) {
        logEvent('error', 'auth.registry.unaudited-grant', {
          roleId, roleName: role.name, permissionKey: key,
          byUserId: actor.id, byEmail: actor.email || null,
          auditError: reason(auditErr), rollbackError: reason(rollbackErr),
        });
        return fail('"' + perm.label + '" was granted but could NOT be recorded in the audit log, and the grant could not be undone. Revoke it by hand and tell whoever runs this system.');
      }
      logFail('auth.registry.assignPermission.audit', auditErr);
      return fail('"' + perm.label + '" was not granted: the audit log could not record who granted it, and a sensitive permission is not granted off the record. Try again.');
    }

    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.assignPermission', e);
    return fail(reason(e));
  }
}

/**
 * Take a permission away from a role.
 *
 * NOTE THE ASYMMETRY WITH assignPermission, which is deliberate. A grant that cannot be recorded is
 * refused; a REVOKE that cannot be recorded still happens. Refusing to remove access because the
 * logging is down is failing OPEN, and the log line is written loudly instead.
 */
export async function revokePermission(
  roleId: string,
  permissionKey: string,
  actor: Actor,
): Promise<RegistryResult> {
  const key = String(permissionKey || '').trim();
  if (!roleId) return fail('No role given.');
  if (!key) return fail('No permission given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as revoking the permission.');

  try {
    await ensureRegistrySchema();
    const role = await roleRow(roleId);
    if (!role) return fail('No such role.');

    const removed = rows(await db.execute(sql`
      DELETE FROM role_permission_grants
       WHERE role_id = ${roleId}::uuid AND permission_key = ${key}
       RETURNING id`));

    // A section-matrix row can grant the same ability. Say so rather than reporting success and
    // leaving the person still able to do the thing that was just "removed".
    const stillVia = key === PERM_ADMIN_ACCESS ? [] : rows(await db.execute(sql`
      SELECT 1 FROM role_permissions rp
       WHERE rp.role_id = ${roleId}::uuid
         AND (rp.page_key || '.view') = ${key} AND rp.can_view
       UNION ALL
      SELECT 1 FROM role_permissions rp
       WHERE rp.role_id = ${roleId}::uuid
         AND (rp.page_key || '.edit') = ${key} AND rp.can_edit
       UNION ALL
      SELECT 1 FROM role_permissions rp
       WHERE rp.role_id = ${roleId}::uuid
         AND (rp.page_key || '.delete') = ${key} AND rp.can_delete
       UNION ALL
      SELECT 1 FROM role_permissions rp
       WHERE rp.role_id = ${roleId}::uuid
         AND (rp.page_key || '.export') = ${key} AND rp.can_export
       LIMIT 1`));

    if (removed.length > 0) {
      await record({
        actor, action: 'permission.revoke', entity: 'role_permission', entityId: roleId + ':' + key,
        diff: { roleId, roleName: role.name, permissionKey: key, ...actorFacts(actor) },
      });
    }

    if (stillVia.length > 0) {
      return fail(
        'The grant was removed, but "' + role.name + '" still has this through the page permissions '
        + 'matrix. Untick it there as well, or the role keeps the ability.',
      );
    }
    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.revokePermission', e);
    return fail(reason(e));
  }
}

/**
 * Add a permission to the catalogue from the admin panel — the reason permissions are data.
 *
 * A key here is a promise that something checks it. Registering `reports.export` does not create a
 * check; a caller still has to ask hasPermission(). The description field is where that gets written
 * down, so an admin granting it later knows what it actually controls.
 */
export async function registerPermission(
  input: { key: string; label: string; group?: string | null; description?: string | null; isSensitive?: boolean },
  actor: Actor,
): Promise<RegistryResult> {
  const key = String(input.key || '').trim().toLowerCase();
  const label = String(input.label || '').trim();
  const group = String(input.group || 'Other').trim() || 'Other';
  const description = String(input.description || '').trim() || null;
  const isSensitive = input.isSensitive === true;

  if (!PERMISSION_KEY_RE.test(key)) {
    return fail('A permission key looks like "reports.export": lowercase words separated by dots.');
  }
  // Refused BY NAME, from the code catalogue, before any row is looked up.
  //
  // The lookup below can only refuse a built-in that is already SEEDED. ensureRegistrySchema() runs
  // through ensureOnce(), which swallows its own failure, so a boot where the seed did not land
  // leaves `admin.access` absent from permission_catalogue — and this function would then happily
  // create it as a non-builtin row with is_sensitive=false. Granting it afterwards would take the
  // ordinary audit path, whose failures are swallowed, producing exactly the thing this module
  // exists to make impossible: console access granted with no record of who granted it.
  if (BUILTIN_PERMISSION_KEYS.includes(key)) {
    return fail('"' + key + '" is a built-in permission and is described in code, not here.');
  }
  if (label.length < 3) return fail('Give the permission a label somebody will understand on a checkbox.');
  if (!actor?.id) return fail('A signed-in person must be recorded as adding the permission.');

  try {
    await ensureRegistrySchema();
    const existing = await permissionRow(key);
    // Built-ins are owned by the code catalogue above; editing them here would be overwritten on the
    // next deploy, so it is refused rather than silently lost.
    if (existing) {
      const isBuiltin = rows(await db.execute(sql`SELECT is_builtin FROM permission_catalogue WHERE key = ${key} LIMIT 1`))[0]?.is_builtin === true;
      if (isBuiltin) return fail('"' + key + '" is a built-in permission and is described in code.');
    }

    await db.execute(sql`
      INSERT INTO permission_catalogue (key, label, group_key, description, is_builtin, is_sensitive, sort_order)
      VALUES (${key}, ${label}, ${group}, ${description}, false, ${isSensitive}, 5000)
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label,
        group_key = EXCLUDED.group_key,
        description = EXCLUDED.description,
        is_sensitive = EXCLUDED.is_sensitive`);

    await record({
      actor, action: existing ? 'permission.catalogue.update' : 'permission.catalogue.add',
      entity: 'permission_catalogue', entityId: key,
      diff: { key, label, group, description, isSensitive, ...actorFacts(actor) },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.registerPermission', e);
    return fail(reason(e));
  }
}

/**
 * Everyone who holds a given permission through a custom role, for the question that follows an
 * incident: "who can open the console, and who gave it to them?"
 *
 * Built-in roles are NOT included — those are answered by PERMS_BY_ROLE and /admin/access-preview,
 * which needs no query at all.
 */
export async function whoHolds(permissionKey: string): Promise<{
  userId: string; name: string | null; email: string | null;
  roleId: string; roleName: string; grantedByEmail: string | null; grantedAt: string | null;
}[]> {
  const key = String(permissionKey || '').trim();
  if (!key) return [];
  try {
    await ensureRegistrySchema();
    const r = await db.execute(sql`
      SELECT u.id AS user_id, u.name, u.email, tr.id AS role_id, tr.name AS role_name,
             g.granted_by_email, g.granted_at
        FROM role_permission_grants g
        JOIN team_roles tr ON tr.id = g.role_id
        JOIN user_role_assignments ura ON ura.role_id = tr.id
        JOIN users u ON u.id = ura.user_id
       WHERE g.permission_key = ${key}
       ORDER BY tr.name ASC, u.name ASC
       LIMIT 500`);
    return rows(r).map((x: any) => ({
      userId: String(x.user_id),
      name: x.name ?? null,
      email: x.email ?? null,
      roleId: String(x.role_id),
      roleName: String(x.role_name),
      grantedByEmail: x.granted_by_email ?? null,
      grantedAt: x.granted_at ? String(x.granted_at) : null,
    }));
  } catch (e: any) {
    logFail('auth.registry.whoHolds', e);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Membership — who holds a role, and the two writes that change it.
//
// These live here rather than in the page because user_role_assignments is this module's table (its
// DDL is above) and because an assignment is a grant: putting somebody in a role hands them every
// permission it holds, and that has to be on the record with the same discipline as granting the
// permission itself.
// ---------------------------------------------------------------------------------------------

export interface RoleMember {
  userId: string;
  name: string | null;
  email: string | null;
  /** The role on users.role. It is what canOpenAdmin() actually reads, so the console shows it. */
  builtinRole: string | null;
  isActive: boolean;
  assignedAt: string | null;
}

/**
 * The people holding one role, named.
 *
 * The console needs the names and not a count: "3 people still hold this" is not enough to act on
 * when the next thing an admin has to do is move those three somewhere else. GROUP BY collapses the
 * duplicate assignment rows the schema deliberately tolerates (see the DDL note above).
 */
export async function listRoleMembers(roleId: string): Promise<RoleMember[]> {
  if (!roleId) return [];
  try {
    await ensureRegistrySchema();
    const r = await db.execute(sql`
      SELECT u.id::text AS user_id, u.name, u.email, u.role::text AS builtin_role, u.is_active,
             MIN(ura.assigned_at) AS assigned_at
        FROM user_role_assignments ura
        JOIN users u ON u.id = ura.user_id
       WHERE ura.role_id = ${roleId}::uuid
       GROUP BY u.id, u.name, u.email, u.role, u.is_active
       ORDER BY lower(coalesce(u.name, '')) ASC
       LIMIT 500`);
    return rows(r).map((x: any) => ({
      userId: String(x.user_id),
      name: x.name ?? null,
      email: x.email ?? null,
      builtinRole: x.builtin_role ? String(x.builtin_role) : null,
      isActive: x.is_active !== false,
      assignedAt: x.assigned_at ? String(x.assigned_at) : null,
    }));
  } catch (e: any) {
    logFail('auth.registry.listRoleMembers', e);
    return [];
  }
}

/**
 * Accounts that can be put into a custom role, filtered by a search term.
 *
 * SEARCHED RATHER THAN LISTED, on purpose. The previous editor rendered every active non-applicant
 * account into a <select>; on a database with thousands of accounts that is a slow page and an
 * unreadable dropdown at 360px. Applicants are excluded because a custom role is a staff construct
 * and an applicant list on an access screen is its own disclosure.
 */
export async function listAssignableUsers(
  query: string = '',
  limit: number = 40,
): Promise<{ id: string; name: string | null; email: string | null; builtinRole: string; isActive: boolean }[]> {
  try {
    await ensureRegistrySchema();
    const q = String(query || '').trim();
    const like = '%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    // Backslash is LIKE's default escape character, so the JS-side escaping above is enough and no
    // ESCAPE clause is needed. A search for "50%" must find "50%", not every row in the table.
    const filter = q ? sql` AND (u.name ILIKE ${like} OR u.email ILIKE ${like})` : sql``;
    const r = await db.execute(sql`
      SELECT u.id::text AS id, u.name, u.email, u.role::text AS builtin_role, u.is_active
        FROM users u
       WHERE u.role::text <> 'applicant'
         AND u.is_active = true
         ${filter}
       ORDER BY lower(coalesce(u.name, '')) ASC
       LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`);
    return rows(r).map((x: any) => ({
      id: String(x.id),
      name: x.name ?? null,
      email: x.email ?? null,
      builtinRole: String(x.builtin_role || ''),
      isActive: x.is_active !== false,
    }));
  } catch (e: any) {
    logFail('auth.registry.listAssignableUsers', e);
    return [];
  }
}

/** The sensitive permissions a role hands whoever is assigned to it. Empty is the common case. */
async function sensitiveGrantsOf(roleId: string): Promise<string[]> {
  const r = await db.execute(sql`
    SELECT g.permission_key AS key, COALESCE(c.is_sensitive, false) AS is_sensitive
      FROM role_permission_grants g
      LEFT JOIN permission_catalogue c ON c.key = g.permission_key
     WHERE g.role_id = ${roleId}::uuid`);
  return rows(r)
    .filter((x: any) => isSensitiveKey(String(x.key), x.is_sensitive === true))
    .map((x: any) => String(x.key));
}

/**
 * Put somebody in a role.
 *
 * When the role carries a sensitive permission the audit row is written STRICTLY and the assignment
 * is undone if it cannot be: handing a person admin.access by dropping them into a role is the same
 * act as granting it, and assignPermission() already refuses to let that happen off the record.
 * Recording it only when the logging happens to be up would make the whole discipline decorative.
 */
export async function assignRoleToUser(
  userId: string,
  roleId: string,
  actor: Actor,
): Promise<RegistryResult> {
  if (!userId) return fail('Pick somebody to add.');
  if (!roleId) return fail('No role given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as making the assignment.');

  try {
    await ensureRegistrySchema();
    const role = await roleRow(roleId);
    if (!role) return fail('No such role.');

    const person = rows(await db.execute(sql`
      SELECT id::text AS id, name, email, role::text AS builtin_role, is_active
        FROM users WHERE id = ${userId}::uuid LIMIT 1`))[0];
    if (!person) return fail('No such account.');
    if (String(person.builtin_role) === 'applicant') {
      return fail('Applicant accounts cannot hold a staff role. Change the account role in Users first.');
    }

    const already = rows(await db.execute(sql`
      SELECT id FROM user_role_assignments
       WHERE user_id = ${userId}::uuid AND role_id = ${roleId}::uuid LIMIT 1`));
    if (already.length > 0) return fail(String(person.name || person.email || 'That person') + ' already holds "' + role.name + '".');

    await db.execute(sql`
      INSERT INTO user_role_assignments (user_id, role_id, assigned_by_user_id)
      VALUES (${userId}::uuid, ${roleId}::uuid, ${actor.id}::uuid)`);

    const sensitive = await sensitiveGrantsOf(roleId);
    const diff: Record<string, unknown> = {
      roleId, roleName: role.name,
      userId, userEmail: person.email ?? null, userName: person.name ?? null,
      builtinRole: person.builtin_role ?? null,
      sensitivePermissions: sensitive,
      ...actorFacts(actor),
    };
    if (sensitive.includes(PERM_ADMIN_ACCESS)) {
      diff.notice = (actor.email || actor.name || actor.id)
        + ' put ' + (person.email || person.name || userId)
        + ' into "' + role.name + '", a role that holds admin console access.';
    }

    if (sensitive.length === 0) {
      await record({ actor, action: 'role.assign', entity: 'user_role_assignment', entityId: roleId + ':' + userId, diff });
      return { ok: true };
    }

    try {
      await recordStrict({ actor, action: 'role.assign.sensitive', entity: 'user_role_assignment', entityId: roleId + ':' + userId, diff });
    } catch (auditErr: any) {
      try {
        await db.execute(sql`
          DELETE FROM user_role_assignments
           WHERE user_id = ${userId}::uuid AND role_id = ${roleId}::uuid`);
      } catch (rollbackErr: any) {
        logEvent('error', 'auth.registry.unaudited-assignment', {
          roleId, roleName: role.name, userId,
          byUserId: actor.id, byEmail: actor.email || null,
          auditError: reason(auditErr), rollbackError: reason(rollbackErr),
        });
        return fail('They were added to "' + role.name + '" but it could NOT be recorded, and the assignment could not be undone. Remove them by hand and tell whoever runs this system.');
      }
      logFail('auth.registry.assignRoleToUser.audit', auditErr);
      return fail('"' + role.name + '" holds sensitive permissions and the audit log could not record who assigned it, so nobody was added. Try again.');
    }

    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.assignRoleToUser', e);
    return fail(reason(e));
  }
}

/**
 * Take somebody out of a role.
 *
 * The same asymmetry revokePermission() documents: a removal that cannot be logged still happens.
 * Refusing to withdraw access because the logging is down is failing open.
 */
export async function unassignRoleFromUser(
  userId: string,
  roleId: string,
  actor: Actor,
): Promise<RegistryResult> {
  if (!userId || !roleId) return fail('Pick a person and a role.');
  if (!actor?.id) return fail('A signed-in person must be recorded as making the change.');

  try {
    await ensureRegistrySchema();
    const role = await roleRow(roleId);
    if (!role) return fail('No such role.');

    const removed = rows(await db.execute(sql`
      DELETE FROM user_role_assignments
       WHERE user_id = ${userId}::uuid AND role_id = ${roleId}::uuid
       RETURNING id`));
    if (removed.length === 0) return fail('They were not in that role.');

    await record({
      actor, action: 'role.unassign', entity: 'user_role_assignment', entityId: roleId + ':' + userId,
      diff: { roleId, roleName: role.name, userId, removedRows: removed.length, ...actorFacts(actor) },
    });
    return { ok: true };
  } catch (e: any) {
    logFail('auth.registry.unassignRoleFromUser', e);
    return fail(reason(e));
  }
}

// ---------------------------------------------------------------------------------------------
// The section matrix, and the one write that keeps it in step with the grants.
//
// role_permissions is not a legacy table to be tolerated: it is what getViewableSectionKeys() and
// canAccessSection() actually read, which makes it the thing that decides what appears in somebody's
// sidebar and whether a URL opens. A grant of `applications.view` that did not reach it would be a
// permission the console says the role has and the product does not honour. applyRolePermissions()
// therefore writes BOTH, from one list of checkboxes, so the two cannot drift.
// ---------------------------------------------------------------------------------------------

export interface SectionGrant {
  pageKey: string;
  view: boolean;
  edit: boolean;
  remove: boolean;
  export: boolean;
  /** False when page_key is not in src/lib/admin-sections.ts — a row nothing can grant or check. */
  known: boolean;
}

/** The page-key rows a role holds, as stored. Read it to show the truth, not the intention. */
export async function sectionMatrixForRole(roleId: string): Promise<SectionGrant[]> {
  if (!roleId) return [];
  try {
    await ensureRegistrySchema();
    const r = await db.execute(sql`
      SELECT page_key, can_view, can_edit, can_delete, can_export
        FROM role_permissions WHERE role_id = ${roleId}::uuid
       ORDER BY page_key ASC`);
    return rows(r).map((x: any) => ({
      pageKey: String(x.page_key),
      view: x.can_view === true,
      edit: x.can_edit === true,
      remove: x.can_delete === true,
      export: x.can_export === true,
      known: sectionTargetFor(String(x.page_key) + '.view') !== null,
    }));
  } catch (e: any) {
    logFail('auth.registry.sectionMatrixForRole', e);
    return [];
  }
}

/** The permission keys a stored section matrix is equivalent to. Pure; used for the nav preview. */
export function sectionMatrixKeys(matrix: SectionGrant[]): string[] {
  const out: string[] = [];
  for (const row of matrix) {
    if (row.view) out.push(row.pageKey + '.view');
    if (row.edit) out.push(row.pageKey + '.edit');
    if (row.remove) out.push(row.pageKey + '.delete');
    if (row.export) out.push(row.pageKey + '.export');
  }
  return out;
}

/** Rewrite role_permissions so it says exactly what `keys` says, and nothing else. */
async function writeSectionMatrix(roleId: string, keys: Iterable<string>): Promise<void> {
  const byPage = new Map<string, { view: boolean; edit: boolean; remove: boolean; exportable: boolean }>();
  for (const key of keys) {
    const target = sectionTargetFor(key);
    if (!target) continue;
    const row = byPage.get(target.section) || { view: false, edit: false, remove: false, exportable: false };
    if (target.action === 'view') row.view = true;
    else if (target.action === 'edit') row.edit = true;
    else if (target.action === 'delete') row.remove = true;
    else row.exportable = true;
    byPage.set(target.section, row);
  }

  await db.execute(sql`DELETE FROM role_permissions WHERE role_id = ${roleId}::uuid`);
  const entries = [...byPage.entries()];
  if (entries.length === 0) return;
  const values = sql.join(
    entries.map(([page, v]) => sql`(${roleId}::uuid, ${page}, ${v.view}, ${v.edit}, ${v.remove}, ${v.exportable})`),
    sql`, `,
  );
  await db.execute(sql`
    INSERT INTO role_permissions (role_id, page_key, can_view, can_edit, can_delete, can_export)
    VALUES ${values}`);
}

export interface ApplyResult {
  granted: string[];
  revoked: string[];
  /** Things the admin must read: a refused grant, an unknown key, a partially applied save. */
  problems: string[];
}

/**
 * Make a role hold EXACTLY these permissions.
 *
 * One save from one list of checkboxes. The order is deliberate:
 *
 *   1. Unknown keys are dropped and reported. A key that is not catalogued cannot be checked by
 *      anything, so granting it would put a tick on a screen and change nothing in the product.
 *   2. The section matrix is rewritten FIRST, from the desired set. Doing it before the revokes is
 *      what lets revokePermission() tell the truth: its "the role still has this through the page
 *      matrix" warning is correct only if the matrix has already been brought into line.
 *   3. Grants and revokes go one at a time through assignPermission()/revokePermission(), so every
 *      single one is audited by the code that already knows how — including the strict, rollback-on-
 *      failure path for admin.access and the other sensitive keys.
 *   4. If any grant was REFUSED (a sensitive one whose audit row would not write), the matrix is
 *      rebuilt from what actually ended up on the record. Otherwise step 2 would have quietly left
 *      the role holding, through role_permissions, the very ability the grant was refused.
 *
 * Returns ok with a list of problems rather than throwing: a save where nineteen permissions applied
 * and one was refused is not a failure to report as "save failed", and it is not a success either.
 */
export async function applyRolePermissions(
  roleId: string,
  desiredKeys: string[],
  actor: Actor,
): Promise<RegistryResult<ApplyResult>> {
  if (!roleId) return fail('No role given.');
  if (!actor?.id) return fail('A signed-in person must be recorded as making the change.');

  try {
    await ensureRegistrySchema();
    const role = await roleRow(roleId);
    if (!role) return fail('No such role.');

    const catalogued = new Set(
      rows(await db.execute(sql`SELECT key FROM permission_catalogue`)).map((x: any) => String(x.key)),
    );
    if (catalogued.size === 0) {
      // Applying an empty catalogue would read every checkbox as unknown and revoke the lot.
      return fail('The permission catalogue could not be read, so nothing was changed. Reload and try again.');
    }

    const problems: string[] = [];
    const desired = new Set<string>();
    for (const raw of desiredKeys) {
      const key = String(raw || '').trim();
      if (!key) continue;
      if (!catalogued.has(key)) { problems.push('"' + key + '" is not a known permission and was ignored.'); continue; }
      desired.add(key);
    }

    const current = new Set(
      rows(await db.execute(sql`SELECT permission_key FROM role_permission_grants WHERE role_id = ${roleId}::uuid`))
        .map((x: any) => String(x.permission_key)),
    );

    await writeSectionMatrix(roleId, desired);

    const granted: string[] = [];
    const revoked: string[] = [];
    let refusedGrant = false;

    for (const key of desired) {
      if (current.has(key)) continue;
      const result = await assignPermission(roleId, key, actor, { reason: 'Set in the role console.' });
      if (result.ok) granted.push(key);
      else { problems.push(result.error); refusedGrant = true; }
    }
    for (const key of current) {
      if (desired.has(key)) continue;
      const result = await revokePermission(roleId, key, actor);
      if (result.ok) revoked.push(key);
      else problems.push(result.error);
    }

    if (refusedGrant) {
      const effective = rows(await db.execute(sql`
        SELECT permission_key FROM role_permission_grants WHERE role_id = ${roleId}::uuid`))
        .map((x: any) => String(x.permission_key));
      await writeSectionMatrix(roleId, effective);
    }

    if (granted.length > 0 || revoked.length > 0) {
      await record({
        actor, action: 'role.permissions.apply', entity: 'team_role', entityId: roleId,
        diff: { roleName: role.name, granted, revoked, holds: [...desired].length, ...actorFacts(actor) },
      });
    }

    return { ok: true, data: { granted, revoked, problems } };
  } catch (e: any) {
    logFail('auth.registry.applyRolePermissions', e);
    return fail(reason(e));
  }
}
