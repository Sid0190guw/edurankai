// src/lib/admin-nav.ts — the admin sidebar, generated from the permissions a person actually holds.
//
// WHY THIS EXISTS. Until now the sidebar lived in the frontmatter of src/layouts/AdminLayout.astro as
// two hand-maintained lists: `navStructure` (what the menu contains) and `NAV_SECTION` (which section
// key each entry is gated by). Three things follow from that shape, and all three have already cost
// something here:
//
//   1. A new admin page needs an entry in BOTH lists. Forget the second and the entry fails closed —
//      invisible to every restricted admin, visible to super admins, so nobody notices for months.
//      Twenty-nine entries are in exactly that state today, including Mail configuration, fee
//      waivers, BGV and the whole Study Abroad queue.
//   2. Navigation could not follow the permission registry. The sidebar resolved through
//      getViewableSectionKeys() alone, which reads role_permissions and NOTHING else — so the section
//      matrix in /admin/team/roles produced links, but a permission granted through the registry's own
//      grants table (role_permission_grants, src/lib/auth/registry.ts) produced none, and no surface
//      could say why.
//   3. Nothing outside the layout can answer "what would this role see?" — an .astro file exports a
//      component, not its consts. /admin/access-preview had to READ THE LAYOUT'S SOURCE TEXT with
//      regular expressions (src/lib/admin-nav-parse.ts) to answer that question at all.
//
// This module is the one implementation. The catalogue below is the sidebar; every entry names the
// section key from src/lib/admin-sections.ts that gates it, so "unmapped" is a type error rather than
// a silent hole. buildAdminNav() answers for a PERSON (through resolvePermissions, so a custom role
// works with no deploy); navForPermissions() answers for a SET OF PERMISSIONS, which is how
// /admin/access-preview asks about a role with no session. Both walk the same tree with the same test.
//
// IT FAILS CLOSED, in three separate ways, because a sidebar is a disclosure even when every page
// behind it is locked — the link alone reveals what exists and who works on what:
//   - an entry whose section key is missing or not in the registry is hidden from anyone restricted;
//   - a group left with no visible children is dropped entirely, rather than rendering an expandable
//     heading that opens onto nothing;
//   - any failure — no session, a degraded resolve, a thrown query — returns ONLY the universal
//     entries (Dashboard, Notifications). Never the full tree. A menu that opens up when the database
//     blinks is the same mistake as a gate that does.
//
// THE MENU IS NOT THE LOCK. Hiding a link does not protect the page behind it; middleware.ts and the
// page's own canAccessSection() do that. This module decides what is OFFERED. Read it that way.
import { ALL_ADMIN_SECTION_KEYS } from '@/lib/admin-sections';
import { defaultSectionKeysForRole } from '@/lib/auth/permissions';
import { resolvePermissions, permissionsForRole, WILDCARD } from '@/lib/auth/registry';
import { logEvent } from '@/lib/logger';

// Declared before anything that uses them: `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

// ---------------------------------------------------------------------------------------------
// Types. Deliberately the SAME shape AdminLayout already renders (id/label/href/icon/badge for an
// item, groupId/label/icon/children for a group), so swapping the layout over is a deletion and an
// import — not a rewrite of the JSX underneath it.
// ---------------------------------------------------------------------------------------------

export interface AdminNavItem {
  /** Matches the layout's `activeNav` prop, so highlighting keeps working unchanged. */
  id: string;
  label: string;
  href: string;
  /** Icon name resolved by the sidebar's CSS (`data-icon`), not an emoji and not an inline SVG here. */
  icon: string;
  /**
   * The section key from src/lib/admin-sections.ts that gates this entry. REQUIRED — that is the
   * whole point. The entry is offered when the person holds `<section>.view`.
   */
  section: string;
  badge?: number;
}

export interface AdminNavGroup {
  groupId: string;
  label: string;
  icon: string;
  children: AdminNavItem[];
}

export type AdminNavEntry = AdminNavItem | AdminNavGroup;

export function isNavGroup(entry: AdminNavEntry): entry is AdminNavGroup {
  return (entry as AdminNavGroup)?.groupId !== undefined;
}

/** True when the currently-open page is one of this group's children — the layout opens it. */
export function isNavGroupActive(group: AdminNavGroup, activeId: string): boolean {
  return (group?.children || []).some((c) => c.id === activeId);
}

// ---------------------------------------------------------------------------------------------
// Universal entries
// ---------------------------------------------------------------------------------------------

/**
 * Entries every signed-in admin keeps regardless of what they hold. Mirrors the layout's existing
 * UNIVERSAL_NAV exactly, `mail` included.
 *
 * WORTH A DECISION, NOT A SILENT CARRY-OVER: `mail` being universal means every admin who can open
 * this console sees the shared inbox link, whatever their role. That is today's behaviour and this
 * module reproduces it rather than changing access as a side effect of a refactor. If the inbox
 * should be gated on `settings` like the rest of the mail screens, remove it from this set — one
 * line, and every surface that asks this module agrees immediately.
 */
export const UNIVERSAL_NAV_IDS: ReadonlySet<string> = new Set(['dashboard', 'mail', 'notifications']);

/**
 * What is left when the answer cannot be computed. NARROWER than UNIVERSAL_NAV_IDS on purpose: the
 * shared mail inbox is not something to hand out on a failure path, and a person who genuinely holds
 * it loses one link for the length of an outage.
 */
export const FAILSAFE_NAV_IDS: readonly string[] = ['dashboard', 'notifications'];

// ---------------------------------------------------------------------------------------------
// THE CATALOGUE — the sidebar itself.
//
// Order, labels, hrefs, icons and grouping are copied verbatim from AdminLayout.astro's navStructure
// so that a super admin gets a byte-identical menu. The one addition is `section` on every entry.
//
// Where AdminLayout's NAV_SECTION already mapped an id, that mapping is reproduced exactly (including
// the two duplicate keys in that object literal, where the LAST one wins: `billing` resolves to
// 'finance', not 'applications'). Where it did not, the section is marked NEWLY MAPPED with the
// reason. Those are the only entries whose visibility changes, they change for restricted roles only,
// and every one of them is listed in the module's handover notes.
//
// 'settings' is this codebase's established key for platform-operator surfaces — infra, observability,
// background jobs, hardening, backup and diagnostics are all already gated on it, and no built-in role
// but super_admin holds it. Newly-mapped operator screens use it for the same reason, which keeps them
// exactly as hidden as they are today while making the gate explicit and grantable.
// ---------------------------------------------------------------------------------------------

export const ADMIN_NAV: AdminNavEntry[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/admin', icon: 'home', section: 'dashboard' },
  { id: 'applications', label: 'Applications', href: '/admin/applications', icon: 'inbox', section: 'applications' },
  // NEWLY MAPPED. /admin/applications/intents is a sub-page of the applications pipeline and
  // middleware.ts already gates it on 'applications' by longest-prefix match — so anyone who can open
  // it by URL now sees the link too, instead of the menu disagreeing with the lock.
  { id: 'starters', label: 'Everyone who started', href: '/admin/applications/intents', icon: 'inbox', section: 'applications' },
  // RECRUITMENT — the parts of hiring that sit AROUND the pipeline: who your people recommend, who
  // you said no to and should call back, and what the interview panel actually thought.
  //
  // ALL GATED ON THE 'applications' SECTION, which tracks the capabilities the pages themselves ask
  // for: /admin/recruitment and the talent pool ask can(applications.view), the feedback console asks
  // can(applications.score), and the referral console additionally asks can(referrals.view) — granted
  // to exactly the roles holding applications.view. So every account offered one of these links can
  // open it, and nobody a page would refuse is shown one.
  //
  // WHY NOT A NEW `recruitment` SECTION KEY: it would create a checkbox in /admin/team/roles that
  // nothing enforces, and — because a section nobody has been granted is a section nobody holds — it
  // would hide these pages from every restricted admin on the day they shipped.
  {
    groupId: 'recruitment-group',
    label: 'Recruitment',
    icon: 'users',
    children: [
      { id: 'recruitment', label: 'Overview', href: '/admin/recruitment', icon: 'grid', section: 'applications' },
      { id: 'recruitment-referrals', label: 'Referral programme', href: '/admin/recruitment/referrals', icon: 'users', section: 'applications' },
      { id: 'recruitment-talent-pool', label: 'Talent pool', href: '/admin/recruitment/talent-pool', icon: 'inbox', section: 'applications' },
      { id: 'recruitment-feedback', label: 'Interview feedback', href: '/admin/recruitment/feedback', icon: 'message-circle', section: 'applications' },
      // BGV already existed at this URL and is one of the entries this module's header describes as
      // missing from the layout's hand-maintained list — reachable only by typing the URL.
      { id: 'recruitment-bgv', label: 'Background verification', href: '/admin/hr/bgv', icon: 'shield', section: 'hr' },
    ],
  },
  { id: 'help', label: 'Help Inbox', href: '/admin/help', icon: 'chat', section: 'messages' },
  { id: 'messages', label: 'DMs', href: '/admin/messages', icon: 'chat', section: 'dms' },
  { id: 'chat', label: 'Discussion', href: '/admin/chat', icon: 'message-circle', section: 'discussion' },
  { id: 'offers', label: 'Offer Letters', href: '/admin/offers', icon: 'document', section: 'offers' },
  // Verification requests raised by scanning the QR on an issued offer letter. Firms pay for these,
  // so an unlinked console meant money could be taken for a request nobody could open and answer.
  { id: 'offer-verifications', label: 'Offer Verifications', href: '/admin/offer-verifications', icon: 'shield', section: 'offers' },
  {
    groupId: 'mail-group',
    label: 'Mail',
    icon: 'inbox',
    children: [
      // `mail` is universal (see UNIVERSAL_NAV_IDS); the section below only matters if it stops being.
      { id: 'mail',           label: 'Inbox',             href: '/admin/mail',           icon: 'inbox',    section: 'settings' },
      // NEWLY MAPPED (all six). These are mail CONFIGURATION — SMTP/IMAP credentials, signatures,
      // templates, deliverability. 'settings' keeps them exactly where they are today: super admin only.
      { id: 'mail-rules',     label: 'Signature & rules', href: '/admin/mail/rules',     icon: 'document', section: 'settings' },
      { id: 'mail-templates', label: 'Templates',         href: '/admin/mail/templates', icon: 'document', section: 'settings' },
      { id: 'mail-analytics', label: 'Analytics',         href: '/admin/mail/analytics', icon: 'document', section: 'settings' },
      { id: 'mail-groups',    label: 'Groups',            href: '/admin/mail/groups',    icon: 'users',    section: 'settings' },
      { id: 'mail-setup',     label: 'Setup wizard',      href: '/admin/mail/setup',     icon: 'shield',   section: 'settings' },
      { id: 'mail-health',    label: 'Health',            href: '/admin/mail/health',    icon: 'shield',   section: 'settings' },
    ],
  },
  // NEWLY MAPPED. A messaging surface, gated like the other one (DMs).
  { id: 'threads', label: 'All Threads', href: '/admin/threads', icon: 'chat', section: 'dms' },
  { id: 'infra', label: 'Infrastructure', href: '/admin/infra', icon: 'shield', section: 'settings' },
  {
    groupId: 'study-abroad-group',
    label: 'Study Abroad',
    icon: 'package',
    children: [
      // NEWLY MAPPED (both). No section in the registry describes the study-abroad product, so these
      // stay operator-only under 'settings' rather than being folded into 'applications', which would
      // hand a different product's request queue to every recruiter and reviewer. The honest fix is a
      // `study_abroad` key in src/lib/admin-sections.ts — a two-line change that makes it grantable.
      { id: 'study-abroad', label: 'Request queue', href: '/admin/study-abroad', icon: 'inbox', section: 'settings' },
      { id: 'study-abroad-consultants', label: 'Consultants', href: '/admin/study-abroad/consultants', icon: 'users', section: 'settings' },
    ],
  },
  { id: 'notifications-setup', label: 'Push Notifications', href: '/admin/notifications-setup', icon: 'shield', section: 'settings' },
  {
    groupId: 'access-group',
    label: 'Access & Hardship',
    icon: 'shield',
    children: [
      { id: 'visvambhara-access',   label: 'Viśvambhara Access',     href: '/admin/visvambhara-access',   icon: 'shield',   section: 'settings' },
      // NEWLY MAPPED (three). Money surfaces, gated with the other one. Note that a fee-waiver request
      // carries a hardship statement, so 'finance' — held by HR and nobody else below super admin — is
      // the narrowest honest home for it. If that is one role too many, move these to 'settings'.
      { id: 'fee-waivers',          label: 'Fee Waivers',            href: '/admin/fee-waivers',          icon: 'shield',   section: 'finance' },
      { id: 'fee-waiver-coupons',   label: 'Waiver Coupons',         href: '/admin/fee-waiver-coupons',   icon: 'document', section: 'finance' },
      { id: 'intl-payments',        label: 'International Payments', href: '/admin/intl-payments',        icon: 'package',  section: 'finance' },
    ],
  },
  {
    groupId: 'hr-group',
    label: 'HR Management',
    icon: 'users',
    children: [
      { id: 'hr',             label: 'Overview',        href: '/admin/hr',                       icon: 'home',     section: 'hr' },
      { id: 'hr-employees',   label: 'Employees',       href: '/admin/hr/employees',             icon: 'users',    section: 'employees' },
      { id: 'hr-onboarding',  label: 'Joining documents', href: '/admin/hr/onboarding',          icon: 'document', section: 'employees' },
      // NEWLY MAPPED (four). Every one is an /admin/hr/* page, and middleware.ts already gates
      // /admin/hr/* on 'hr' — so an HR account can open all four by typing the URL today while the
      // sidebar pretends they do not exist. Mapping them to 'hr' makes the menu tell the truth.
      { id: 'hr-requisitions',label: 'Requisitions',    href: '/admin/hr/requisitions',          icon: 'document', section: 'hr' },
      { id: 'hr-bgv',         label: 'BGV (verification)', href: '/admin/hr/bgv',                icon: 'shield',   section: 'hr' },
      { id: 'hr-classification',label: 'Classification register', href: '/admin/hr/classification', icon: 'grid', section: 'hr' },
      // THE EMPLOYEE LIFECYCLE. Every one is an /admin/hr/* page, which middleware.ts already gates on
      // the 'hr' section (longest-prefix match on '/admin/hr'), so mapping them to 'hr' RECORDS the
      // gate the door already applies rather than inventing a second one. Each page asks the same
      // question again in its own frontmatter, and every WRITE on them asks for `employee.manage` on
      // top of it — opening a register is not changing what somebody is engaged as.
      { id: 'hr-contracts',   label: 'Contracts',       href: '/admin/hr/contracts',             icon: 'document', section: 'hr' },
      // PROBATION AND CONFIRMATION. Under contracts because a probation is a TERM of the engagement
      // ('probationary' is one of the contract types in src/lib/contracts.ts) and confirmation is the
      // moment that term ends. Gated on 'hr' like every other /admin/hr path; the page then asks for
      // `employee.manage` before it will let anybody raise a decision.
      { id: 'hr-probation',   label: 'Probation and confirmation', href: '/admin/hr/contracts/probation', icon: 'shield', section: 'hr' },
      { id: 'hr-transfers',   label: 'Transfers',       href: '/admin/hr/transfers',             icon: 'users',    section: 'hr' },
      // ONE REGISTER FOR PROMOTIONS, DEMOTIONS AND RE-DESIGNATIONS. They are one table and one
      // approval chain (DESIGNATION_CHANGE_KINDS in src/lib/hr-lifecycle.ts), so they are ONE entry —
      // a second link to the same console under a different word would be two doors into one room,
      // and people would come to believe the two behaved differently.
      { id: 'hr-promotions',  label: 'Designation changes', href: '/admin/hr/promotions',        icon: 'users',    section: 'hr' },
      // /admin/hr/separations redirects here — one console over one hr_separations table.
      { id: 'hr-separations', label: 'Separation and exit', href: '/admin/hr/separation',        icon: 'inbox',    section: 'hr' },
      // FULL AND FINAL SETTLEMENT. A surface BESIDE the separation console rather than inside it:
      // working out the money owed on an exit is a different job from closing the exit, and the two
      // are often done by different people on different days.
      { id: 'hr-settlement',  label: 'Final settlement', href: '/admin/hr/separation/settlement', icon: 'document', section: 'hr' },
      { id: 'hr-leave',       label: 'Leave',           href: '/admin/hr/leave',                 icon: 'calendar', section: 'leave' },
      { id: 'hr-attendance',  label: 'Attendance',      href: '/admin/hr/attendance',            icon: 'calendar', section: 'attendance' },
      // WORKING TIME. Both are /admin/hr/* pages, so middleware's longest-prefix match already gates
      // them; mapping them to `attendance` RECORDS the desk they belong to rather than inventing a
      // second gate, and each page asks the same question again in its own frontmatter (the
      // `attendance` section at edit level OR attendance.roster.manage — the capability that already
      // means "defines working time: shifts, rosters, the holiday list"). Neither approves anything:
      // an overtime claim and an attendance correction are routed per row from the Organization Graph.
      { id: 'hr-holidays',    label: 'Holiday calendar', href: '/admin/hr/holidays',             icon: 'calendar', section: 'attendance' },
      { id: 'hr-attendance-reports', label: 'Attendance reports', href: '/admin/hr/attendance/reports', icon: 'chart', section: 'attendance' },
      { id: 'hr-payroll',     label: 'Payroll',         href: '/admin/hr/payroll',               icon: 'document', section: 'payroll' },
      // THE THREE PAY SURFACES BESIDE THE RUN, all on the `payroll` section — the same section the
      // run itself carries, because each of them reads or writes what people are paid. Every one of
      // the three then asks for `payroll.manage` through can() in its own frontmatter, which is
      // strictly NARROWER: a custom role granted the `payroll` section checkbox passes middleware and
      // is still refused at the page. Mapping the menu to the section rather than to the capability
      // is deliberate and matches how procurement is mapped a few lines below — buildAdminNav()
      // resolves through the registry, where a custom role's grant is spelled as a SECTION and never
      // as the capability, so asking for the capability here would hide links from roles the page
      // itself admits.
      { id: 'hr-loans',       label: 'Loans and advances', href: '/admin/hr/payroll/loans',      icon: 'package',  section: 'payroll' },
      { id: 'hr-bonuses',     label: 'Bonuses and incentives', href: '/admin/hr/payroll/bonuses', icon: 'chart',   section: 'payroll' },
      { id: 'hr-pay-reports', label: 'Payroll reports', href: '/admin/hr/payroll/reports',       icon: 'chart',    section: 'payroll' },
      { id: 'hr-training',    label: 'Training',        href: '/admin/hr/training',              icon: 'book',     section: 'training' },
      // PERFORMANCE AND LEARNING. Three /admin/hr/* pages, so middleware's longest-prefix match on
      // '/admin/hr' already gates them on the 'hr' section — mapping them to 'hr' RECORDS the gate the
      // door already applies rather than inventing a second one. Each page then asks for its OWN
      // capability in its frontmatter (performance.manage / skills.manage / learning.assign), and
      // refuses IN PLACE with a sentence rather than bouncing silently, so somebody who holds the
      // console but not the desk is told what they are looking at instead of concluding it is broken.
      //
      // /admin/hr/performance — the older single-page console — is left exactly where it is. These
      // are surfaces beside it, not a replacement for it.
      { id: 'hr-perf-cycles', label: 'Appraisal cycles', href: '/admin/hr/performance/cycles',   icon: 'chart',    section: 'hr' },
      { id: 'hr-skills',      label: 'Skills',          href: '/admin/hr/performance/skills',    icon: 'grid',     section: 'hr' },
      { id: 'hr-learning',    label: 'Assigned learning', href: '/admin/hr/performance/learning', icon: 'book',    section: 'hr' },
      // WORKPLACE SERVICES. New surfaces, new section keys - so nothing here is "newly mapped" from
      // an older hand-written list: the page, the sidebar entry and the capability were written
      // together and ask the same question. Only super_admin and `hr` hold these sections today.
      { id: 'helpdesk',       label: 'Helpdesk',        href: '/admin/helpdesk',                 icon: 'chat',     section: 'helpdesk' },
      // THE STAFF HANDBOOK. It lives UNDER /admin/helpdesk on purpose — it is what the desk hands
      // somebody INSTEAD of a ticket — so middleware's longest-prefix match already gates it on the
      // same 'helpdesk' section this entry names. Menu, door and page ask one question. WRITING needs
      // `knowledge.manage` on top of it, asked by the page; READING an article is gated by the
      // article's own audience in the WHERE clause and needs no permission of its own.
      { id: 'helpdesk-knowledge', label: 'Knowledge base', href: '/admin/helpdesk/knowledge',    icon: 'book',     section: 'helpdesk' },
      { id: 'assets',         label: 'Asset register',  href: '/admin/assets',                   icon: 'package',  section: 'assets' },
      // PROJECTS. Both pages gate on canAccessSection('projects','view') OR the 'projects.view'
      // capability, so the menu entry and the door ask the same question — the section is the one
      // named here, and `hr` carries it in ROLE_SECTIONS alongside the capability grant.
      //
      // NEITHER ENTRY IS WHERE A PROJECT IS RUN. Milestones, people, work and risks are managed at
      // /portal/employee/projects/[id] by whoever the Organization Graph records as running the
      // project, who is not an administrator and needs nothing in this sidebar. These two are the
      // register and the portfolio timeline.
      { id: 'projects',       label: 'Projects',        href: '/admin/projects',                 icon: 'grid',     section: 'projects' },
      { id: 'projects-roadmap', label: 'Project roadmap', href: '/admin/projects/roadmap',       icon: 'chart',    section: 'projects' },
      // AGGREGATE REPORTING. Both pages ask can(user, 'analytics.view') in their own frontmatter, and
      // that capability is held by super_admin and `hr` — which is exactly the population the 'hr'
      // section admits, since `hr` is the only built-in role carrying it and super_admin is
      // unrestricted. The menu therefore offers these to the same accounts the page admits.
      //
      // NOT 'audit' — which is what the /admin/analytics prefix resolved to in middleware.ts, and
      // which `hr` does not hold in ROLE_SECTIONS. That mismatch bounced every hr account off the
      // workforce console before its own gate ever ran; it is fixed at the door too, in the two
      // PATH_SECTION entries added there.
      { id: 'workforce-analytics', label: 'Workforce analytics', href: '/admin/analytics/workforce', icon: 'chart', section: 'hr' },
      { id: 'domain-dashboards', label: 'Domain dashboards', href: '/admin/analytics/domains/executive', icon: 'chart', section: 'hr' },
      // NEWLY MAPPED (five). Support and applicant-facing queues follow the surface they belong to;
      // the employee-record ones follow 'hr'.
      { id: 'hr-support',     label: 'Application Support', href: '/admin/hr-support',           icon: 'message-circle', section: 'messages' },
      { id: 'submissions',    label: 'Submissions inbox', href: '/admin/submissions',            icon: 'inbox',    section: 'hr' },
      { id: 'appeals',        label: 'Appeals',         href: '/admin/appeals',                  icon: 'shield',   section: 'applications' },
      { id: 'certificates',   label: 'Certificates',    href: '/admin/certificates',             icon: 'document', section: 'training' },
      { id: 'campus-ambassadors', label: 'Campus Ambassadors', href: '/admin/campus-ambassadors', icon: 'users',   section: 'hr' },
    ],
  },
  { id: 'finance', label: 'Finance', href: '/admin/finance', icon: 'package', section: 'finance' },
  // PROCUREMENT. Gated on 'finance' — the same section each page accepts as one of its two arms, so
  // the menu and the lock ask one question rather than two that can drift apart. Below super admin
  // that is `hr` alone in ROLE_SECTIONS, which is exactly who holds `procurement.view` in
  // PERMS_BY_ROLE, so the two arms admit the same accounts.
  //
  // NOT gated on the capability here, deliberately: buildAdminNav() resolves through the registry,
  // where a CUSTOM role's finance grant spells `finance.edit` and never `procurement.view` — asking
  // for the capability would hide the link from custom roles whose page gate admits them, which is
  // the "menu disagrees with the lock" defect this module exists to remove.
  //
  // There is no PATH_SECTION entry for /admin/procurement in src/middleware.ts, and that is also
  // deliberate: adding one would make the middleware the gate and would bounce anybody whose access
  // comes from the capability arm rather than the section arm. Each page carries its own gate as its
  // first await, above every read, and every write is re-checked where it binds.
  {
    groupId: 'procurement-group',
    label: 'Procurement',
    icon: 'package',
    children: [
      { id: 'procurement',         label: 'Purchase requests', href: '/admin/procurement',         icon: 'inbox', section: 'finance' },
      { id: 'procurement-vendors', label: 'Vendors',           href: '/admin/procurement/vendors', icon: 'users', section: 'finance' },
    ],
  },
  // INVOICES. Gated on 'finance' for exactly the reasons written above the procurement group: the
  // menu and the lock must ask ONE question, and buildAdminNav() resolves through the registry where a
  // custom role's finance grant spells `finance.edit` and never `invoices.view`. Asking for the
  // capability here would hide the link from custom roles whose page gate admits them.
  //
  // These pages sit UNDER /admin/finance, so src/middleware.ts PATH_SECTION already gates the subtree
  // on the same 'finance' section for custom roles — no new entry there, and no second question.
  {
    groupId: 'invoices-group',
    label: 'Invoices',
    icon: 'document',
    children: [
      { id: 'invoices',          label: 'Invoices',          href: '/admin/finance/invoices',          icon: 'document', section: 'finance' },
      { id: 'invoice-settings',  label: 'Numbering & tax',   href: '/admin/finance/invoices/settings', icon: 'package',  section: 'finance' },
    ],
  },
  // NEWLY MAPPED. Partnership records are commercial, not covered by any section; operator-only.
  { id: 'partnerships', label: 'Partnerships', href: '/admin/partnerships', icon: 'package', section: 'settings' },
  // NEWLY MAPPED. Account records — gated with Users, which no built-in role but super admin holds,
  // so this is both honest and unchanged in practice.
  { id: 'profiles', label: 'Profiles', href: '/admin/profiles', icon: 'package', section: 'users' },
  // NEWLY MAPPED. Candidate resumes are the applications pipeline by another name.
  { id: 'resumes', label: 'Resumes', href: '/admin/resumes', icon: 'package', section: 'applications' },
  // NEWLY MAPPED (three). Platform configuration and ledger; operator-only, like the rest.
  { id: 'appsettings', label: 'App Settings', href: '/admin/app-settings', icon: 'package', section: 'settings' },
  { id: 'flags', label: 'Feature Flags', href: '/admin/feature-flags', icon: 'package', section: 'settings' },
  { id: 'credits', label: 'Account Credit', href: '/admin/credits', icon: 'package', section: 'finance' },
  {
    groupId: 'interviews-group',
    label: 'Interviews',
    icon: 'calendar',
    children: [
      { id: 'interviews', label: 'Scheduled', href: '/admin/interviews', icon: 'calendar', section: 'interviews' },
      { id: 'manual-interviews', label: 'Manual (panel)', href: '/admin/interviews/manual', icon: 'users', section: 'interviews_manual' },
      { id: 'ai-interviews', label: 'AI Sessions', href: '/admin/interviews/ai', icon: 'message-circle', section: 'interviews_ai' },
      { id: 'ai-interview-templates', label: 'AI Templates', href: '/admin/ai-interview-templates', icon: 'book', section: 'interviews_ai' },
    ],
  },
  {
    groupId: 'proctoring',
    label: 'Tests & Proctoring',
    icon: 'check-circle',
    children: [
      { id: 'tests', label: 'Tests', href: '/admin/tests', icon: 'check-circle', section: 'tests' },
      { id: 'test-attempts', label: 'Attempts (log)', href: '/admin/tests/attempts', icon: 'inbox', section: 'tests_proctoring' },
      { id: 'identity-verifications', label: 'Identity Verifications', href: '/admin/identity-verifications', icon: 'shield', section: 'tests_proctoring' },
    ],
  },
  {
    groupId: 'aquintutor',
    label: 'AquinTutor LMS',
    icon: 'book',
    children: [
      { id: 'aquintutor-overview', label: 'Overview', href: '/admin/aquintutor', icon: 'grid', section: 'lms' },
      { id: 'schools', label: 'Schools & Departments', href: '/admin/schools', icon: 'book', section: 'lms' },
      { id: 'courses', label: 'Courses', href: '/admin/courses', icon: 'book', section: 'lms' },
      { id: 'paths', label: 'Learning Paths', href: '/admin/paths', icon: 'grid', section: 'lms' },
      { id: 'instructors', label: 'Faculty', href: '/admin/instructors', icon: 'users', section: 'lms' },
      // NEWLY MAPPED, and NOT on 'lms' with the rest of this group, which is where it was first put.
      // This is the only entry in the catalogue whose href leaves /admin, so middleware's
      // PATH_SECTION never sees it and the page guards itself: src/pages/aquintutor/admin/index.astro
      // redirects anything that is not super_admin to /aquintutor. Gating it on 'lms' therefore
      // offered it to `editor` — the one restricted built-in role holding 'lms' — and to any custom
      // role granted lms.view, as a link that bounces on click. 'settings' is held by no built-in role
      // but super_admin, so the entry stays exactly as visible as it is today and the menu goes on
      // mirroring the lock. Widen it the day that page's own guard widens, not before.
      { id: 'aquintutor-command', label: 'Command Center', href: '/aquintutor/admin', icon: 'shield', section: 'settings' },
    ],
  },
  { id: 'custom-offer', label: 'Custom Offer', href: '/admin/offer/blank', icon: 'file-text', section: 'custom_offer' },
  { id: 'hei-dashboard', label: 'HEI Control Plane', href: '/admin/hei', icon: 'book', section: 'hei_findings' },
  { id: 'roles', label: 'Roles', href: '/admin/roles', icon: 'briefcase', section: 'roles' },
  { id: 'team-roles', label: 'Custom Roles', href: '/admin/team/roles', icon: 'shield', section: 'team_roles' },
  { id: 'departments', label: 'Departments', href: '/admin/departments', icon: 'grid', section: 'departments' },
  { id: 'events', label: 'Events', href: '/admin/events', icon: 'calendar', section: 'events' },
  { id: 'forms', label: 'Forms', href: '/admin/forms', icon: 'document', section: 'content' },
  { id: 'products', label: 'Products', href: '/admin/products', icon: 'package', section: 'products' },
  {
    groupId: 'visvambhara-group',
    label: 'Viśvambhara',
    icon: 'package',
    children: [
      { id: 'visvambhara-public', label: 'Public page', href: '/products/visvambhara', icon: 'globe', section: 'products' },
      // Same id as the entry in the Access & Hardship group above — duplicated in the layout today and
      // reproduced here so the menu is unchanged. Both are gated identically, so the duplication is
      // cosmetic; collapsing it is a product decision, not a permissions one.
      { id: 'visvambhara-access', label: 'Access control', href: '/admin/visvambhara-access', icon: 'shield', section: 'settings' },
    ],
  },
  { id: 'content', label: 'Content Pages', href: '/admin/content', icon: 'document', section: 'content' },
  { id: 'knowledge', label: 'Knowledge', href: '/admin/knowledge', icon: 'grid', section: 'lms' },
  { id: 'assessments', label: 'Assessments', href: '/admin/assessments', icon: 'document', section: 'lms' },
  { id: 'tutor', label: 'AI Tutor (Ask Aquin)', href: '/admin/tutor', icon: 'chat', section: 'audit' },
  { id: 'admissions', label: 'Admissions', href: '/admin/admissions', icon: 'inbox', section: 'applications' },
  { id: 'enrolment', label: 'Enrolment & records', href: '/admin/enrolment', icon: 'users', section: 'applications' },
  // 'billing' is listed TWICE in the layout's NAV_SECTION map — 'applications' first, 'finance' later.
  // An object literal keeps the last one, so 'finance' is what the sidebar actually uses today and
  // what is reproduced here. Reading only the first line would have quietly widened this to every
  // recruiter and reviewer.
  { id: 'billing', label: 'Payments & refunds', href: '/admin/billing', icon: 'chart', section: 'finance' },
  { id: 'schedule', label: 'Schedule & deadlines', href: '/admin/schedule', icon: 'document', section: 'lms' },
  { id: 'credentials', label: 'Credentials', href: '/admin/credentials', icon: 'shield', section: 'audit' },
  { id: 'proctoring', label: 'Proctoring (ATLAS)', href: '/admin/proctoring', icon: 'shield', section: 'tests_proctoring' },
  { id: 'search', label: 'Search index', href: '/admin/search', icon: 'grid', section: 'audit' },
  { id: 'learning-analytics', label: 'Learning analytics', href: '/admin/learning-analytics', icon: 'chart', section: 'audit' },
  { id: 'user-settings', label: 'User settings', href: '/admin/user-settings', icon: 'cog', section: 'audit' },
  { id: 'xp-config', label: 'Gamification', href: '/admin/xp-config', icon: 'chart', section: 'audit' },
  { id: 'notification-log', label: 'Notifications log', href: '/admin/notification-log', icon: 'bell', section: 'audit' },
  { id: 'community-moderation', label: 'Discussion moderation', href: '/admin/community-moderation', icon: 'message-circle', section: 'discussion' },
  { id: 'moderation-live', label: 'Live safety', href: '/admin/moderation-live', icon: 'shield', section: 'discussion' },
  { id: 'campus', label: 'Campus content', href: '/admin/campus', icon: 'globe', section: 'settings' },
  { id: 'animations', label: 'Teaching board', href: '/admin/animations', icon: 'grid', section: 'lms' },
  { id: 'vod', label: 'Recordings & VOD', href: '/admin/vod', icon: 'document', section: 'lms' },
  { id: 'i18n', label: 'Translations', href: '/admin/i18n', icon: 'globe', section: 'content' },
  { id: 'accessibility', label: 'Accessibility', href: '/admin/accessibility', icon: 'shield', section: 'content' },
  { id: 'learning', label: 'Learning runtime', href: '/admin/learning', icon: 'chart', section: 'audit' },
  { id: 'render-policy', label: 'Rendering policy', href: '/admin/render-policy', icon: 'grid', section: 'settings' },
  { id: 'offline', label: 'Offline packages', href: '/admin/offline', icon: 'package', section: 'audit' },
  { id: 'sync', label: 'Knowledge sync', href: '/admin/sync', icon: 'shield', section: 'audit' },
  { id: 'rbac', label: 'Access / RBAC', href: '/admin/rbac', icon: 'shield', section: 'team_roles' },
  { id: 'observability', label: 'Observability', href: '/admin/observability', icon: 'shield', section: 'settings' },
  { id: 'jobs', label: 'Background jobs', href: '/admin/jobs', icon: 'package', section: 'settings' },
  { id: 'hardening', label: 'Hardening & ops', href: '/admin/hardening', icon: 'shield', section: 'settings' },
  // The incident board — what is broken, right now, in one view. 'settings' for the same reason as
  // every other operator screen here: no built-in role but super_admin holds it, and the page itself
  // asks for `administer` on the platform, so the link is never offered more widely than the lock
  // behind it allows. An operator screen with no sidebar entry is a screen nobody opens at 2am.
  { id: 'ops', label: 'Ops console', href: '/admin/ops', icon: 'chart', section: 'settings' },
  { id: 'backup', label: 'Backup & integrity', href: '/admin/backup', icon: 'package', section: 'settings' },
  { id: 'users', label: 'Users', href: '/admin/users', icon: 'users', section: 'users' },
  { id: 'analytics', label: 'Analytics', href: '/admin/analytics', icon: 'chart', section: 'audit' },
  // Every recorded activity, and the digest of what was too routine to push. Previously the page
  // existed but nothing linked to it, so the feed was written and never read.
  { id: 'activity', label: 'Activity', href: '/admin/activity', icon: 'inbox', section: 'audit' },
  { id: 'audit', label: 'Audit Log', href: '/admin/audit', icon: 'shield', section: 'audit' },
  // Universal (see UNIVERSAL_NAV_IDS), so the section is only a fallback — but it is deliberately
  // 'dashboard' and not 'audit'. This is the person's OWN notification inbox, not the admin log at
  // /admin/notification-log; gating it on 'audit' would hide everybody's inbox from everybody the day
  // the universal set is trimmed.
  { id: 'notifications', label: 'Notifications', href: '/admin/notifications', icon: 'bell', section: 'dashboard' },
  { id: 'settings', label: 'Settings', href: '/admin/settings', icon: 'cog', section: 'settings' },
  { id: 'diagnostics', label: 'Diagnostics', href: '/admin/diagnostics', icon: 'shield', section: 'settings' },
];

// ---------------------------------------------------------------------------------------------
// Integrity of the catalogue itself.
//
// A `section` pointing at a key the registry does not define is the same failure as the old unmapped
// entry: no role can ever be granted it, so the link is hidden from every restricted admin forever
// while looking perfectly fine in source. It is checked once, at module load, and reported — both to
// the log and to /admin/access-preview, which is the screen whose job is to notice.
// ---------------------------------------------------------------------------------------------

/** Every entry, groups flattened, with the group heading it appears under (null at top level). */
export function flattenNav(entries: AdminNavEntry[] = ADMIN_NAV): (AdminNavItem & { group: string | null })[] {
  const out: (AdminNavItem & { group: string | null })[] = [];
  for (const entry of entries || []) {
    if (isNavGroup(entry)) {
      for (const child of entry.children || []) out.push({ ...child, group: entry.label });
    } else if (entry) {
      out.push({ ...entry, group: null });
    }
  }
  return out;
}

/** Section keys named by the nav that the registry does not define. Should always be empty. */
export function danglingNavSections(entries: AdminNavEntry[] = ADMIN_NAV): { id: string; section: string }[] {
  const known = new Set(ALL_ADMIN_SECTION_KEYS);
  return flattenNav(entries)
    .filter((item) => !item.section || !known.has(item.section))
    .map((item) => ({ id: item.id, section: String(item.section || '') }));
}

/**
 * The mirror image: a section the permission editor can grant that no nav entry points at. Granting
 * it puts no link in anybody's sidebar — harmless when the page is reached another way, a dead end
 * when it is not.
 */
export function unusedSectionKeys(entries: AdminNavEntry[] = ADMIN_NAV): string[] {
  const used = new Set(flattenNav(entries).map((item) => item.section));
  return ALL_ADMIN_SECTION_KEYS.filter((k) => !used.has(k));
}

/** Computed once per process, exported so a page can render it instead of only a log line reading it. */
export const NAV_SECTION_PROBLEMS: { id: string; section: string }[] = danglingNavSections(ADMIN_NAV);
if (NAV_SECTION_PROBLEMS.length > 0) {
  logEvent('warn', 'admin.nav.dangling-sections', {
    count: NAV_SECTION_PROBLEMS.length,
    entries: NAV_SECTION_PROBLEMS.map((p) => p.id + ' -> ' + p.section).join(', '),
  });
}

// ---------------------------------------------------------------------------------------------
// The pure core. No database, no session — safe to unit test, and safe to call once per role on a
// page that has to describe all of them.
// ---------------------------------------------------------------------------------------------

/** Wildcard-aware membership, matching holdsPermission() in the registry. */
function holds(permissions: Set<string>, key: string): boolean {
  return permissions.has(WILDCARD) || permissions.has(key);
}

/**
 * Is this ONE entry offered to somebody holding `permissions`?
 *
 * Universal entries always. Otherwise `<section>.view` must be held — and an entry with no section at
 * all is hidden, which is the fail-closed direction: forgetting to describe a new entry under-exposes
 * it instead of showing it to everyone.
 *
 * `<section>.view` is not a shape invented here. It is the same key seedCatalogueRows() writes into
 * permission_catalogue and the same one customRoleKeys() derives from a role_permissions page-key
 * row, so the sidebar, the permission editor and the resolver all name one ability the same way.
 */
export function canSeeNavItem(item: AdminNavItem, permissions: Set<string>): boolean {
  if (!item || !item.id) return false;
  if (UNIVERSAL_NAV_IDS.has(item.id)) return true;
  if (!item.section) return false;
  return holds(permissions, item.section + '.view');
}

/**
 * THE ONE IMPLEMENTATION. Filter a nav tree down to what a given permission set may see.
 *
 * Pure on purpose: /admin/access-preview needs the answer for a ROLE, which has no session and no
 * user id to resolve, and the only way for that screen to be believed is for it to run the same code
 * the sidebar runs — not a second copy that drifts, and not a regex reading the layout's source.
 *
 * A GROUP WITH NO VISIBLE CHILDREN IS DROPPED. An expandable heading that opens onto nothing tells
 * somebody a section exists while refusing to let them into it, which is worse than not mentioning it.
 *
 * @param sections    the nav tree to filter — pass ADMIN_NAV unless you are testing.
 * @param permissions permission keys, e.g. 'applications.view'. WILDCARD ('*') means everything.
 */
export function navForPermissions(
  sections: AdminNavEntry[],
  permissions: Iterable<string> | Set<string> | null | undefined,
): AdminNavEntry[] {
  const held = permissions instanceof Set ? permissions : new Set<string>(permissions || []);
  const out: AdminNavEntry[] = [];
  for (const entry of sections || []) {
    if (!entry) continue;
    if (isNavGroup(entry)) {
      const children = (entry.children || []).filter((c) => canSeeNavItem(c, held));
      if (children.length === 0) continue;
      out.push({ ...entry, children });
    } else if (canSeeNavItem(entry, held)) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * What a BUILT-IN role may VIEW, with no database: the per-role section defaults (ROLE_SECTIONS, via
 * defaultSectionKeysForRole) written as `<section>.view` so the whole module speaks one vocabulary.
 *
 * WHY THE GRANULAR MATRIX IS DELIBERATELY NOT FOLDED IN. PERMS_BY_ROLE is the other built-in matrix,
 * and it is tempting to union the two — a role that holds `roles.view` surely may see the Roles link.
 * It may not, and shipping that would have put dead links in the sidebar: `reviewer` and `editor` both
 * hold `roles.view` in PERMS_BY_ROLE, neither has `roles` in ROLE_SECTIONS, and middleware.ts gates
 * /admin/roles on the SECTION via getViewableSectionKeys — so the click ends at
 * /admin?denied=roles. The two matrices disagree, the section one is the one the door enforces, and a
 * menu that offers what the door refuses is worse than a menu that stays quiet. Read this as: the nav
 * mirrors the lock, and the disagreement between the two matrices is a real finding for someone to
 * settle in permissions.ts, not something for this module to paper over.
 *
 * A ROLE WITH NO SECTION LIST GETS NOTHING HERE, which is a deliberate and narrow tightening.
 * defaultSectionKeysForRole() returns null for two different situations: super_admin (unrestricted on
 * purpose, handled first and given the wildcard) and a role with no ROLE_SECTIONS entry — an unknown
 * value written straight into the database, or a renamed role left behind in the data. The old sidebar
 * read that second null as "do not restrict" and would have handed such an account the entire menu.
 * Nothing is exposed by that today, because canOpenAdmin() refuses any role that does not hold
 * admin.access before the layout ever renders — but that gate was then the only thing standing there,
 * and a menu should not be relying on it.
 */
export function navPermissionsForRole(role: string | null | undefined): Set<string> {
  const set = new Set<string>();
  const key = String(role || '').trim();
  if (!key) return set;

  // super_admin holds everything, including permissions invented next week. Same meaning the registry
  // gives WILDCARD, so the two never disagree about what "super admin" means.
  if (key === 'super_admin') { set.add(WILDCARD); return set; }

  const sections = defaultSectionKeysForRole(key);
  if (sections === null) return set;
  for (const s of sections) set.add(s + '.view');
  return set;
}

/**
 * The sidebar a built-in role would be handed, with no session and no database.
 *
 * This is what /admin/access-preview should call. It describes the BUILT-IN role only — a person also
 * assigned a custom role gets at least this and possibly more, which buildAdminNav() resolves for real.
 */
export function navForRole(role: string | null | undefined, sections: AdminNavEntry[] = ADMIN_NAV): AdminNavEntry[] {
  return navForPermissions(sections, navPermissionsForRole(role));
}

/** Dashboard and Notifications, taken from the catalogue so their labels and hrefs live in one place. */
export function failsafeNav(sections: AdminNavEntry[] = ADMIN_NAV): AdminNavEntry[] {
  const out: AdminNavEntry[] = [];
  for (const id of FAILSAFE_NAV_IDS) {
    const found = (sections || []).find((e) => !isNavGroup(e) && (e as AdminNavItem).id === id);
    if (found) out.push(found);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The answer for a PERSON.
// ---------------------------------------------------------------------------------------------

/** Satisfied by `Astro.locals.user` — the drizzle users row, so there is no second user query. */
export interface AdminNavUser {
  id?: string | null;
  role?: string | null;
  isActive?: boolean | null;
}

/**
 * The nav tree this specific person should see.
 *
 * The identity, the built-in role and the list of custom roles come from resolvePermissions()
 * (src/lib/auth/registry.ts). What each custom role actually grants comes from permissionsForRole(),
 * which returns the explicit grants in role_permission_grants UNION the page-key rows /admin/team/roles
 * writes into role_permissions — so a role created in the admin panel produces navigation with NO code
 * change. That was impossible before: the sidebar consulted only getViewableSectionKeys(), which never
 * looks at the registry's grants table at all.
 *
 * THE BRANCHES MIRROR THE DOOR, deliberately, because the menu must not offer what middleware.ts will
 * refuse:
 *   super_admin        -> everything (WILDCARD)
 *   >= 1 custom role   -> exactly what those roles grant, plus dashboard
 *   otherwise          -> the built-in role's ROLE_SECTIONS defaults
 * That is getViewableSectionKeys()'s own structure, in permission vocabulary, with the registry's
 * grants added to the middle branch.
 *
 * THE ONE PLACE THE MENU CAN STILL LEAD SOMEWHERE THE DOOR REFUSES, stated plainly rather than
 * discovered later: a permission granted ONLY through role_permission_grants (the registry's own
 * table) produces a link here, but middleware.ts still asks getViewableSectionKeys(), which reads only
 * role_permissions — so that link redirects to /admin?denied=<section>. Granting through the section
 * matrix in /admin/team/roles is unaffected and works end to end today. This is the SAME seam
 * registry.ts already documents for admin.access at canOpenAdmin(), and closing it is one change in
 * one place, for a human to make deliberately: have the middleware permission gate resolve through the
 * registry too. Until then, prefer the section matrix when granting.
 *
 * A CUSTOM ROLE ONLY ADDS to what that role itself grants; it never subtracts from another role.
 * Assigning somebody a custom role does REPLACE their built-in section defaults, which is what the
 * door has always done — a custom role is the precise override, not a supplement.
 *
 * PASS `locals`. resolvePermissions memoises per request on Astro.locals, so a page that also checks
 * permissions in its own frontmatter pays for one lookup rather than two.
 *
 * FAILS CLOSED at every step: no session, a resolve that answered anything other than 'ok' (an
 * outage, a deactivated account, a deleted account with a live cookie), or a thrown anything returns
 * failsafeNav() — Dashboard and Notifications, never the full tree.
 */
export async function buildAdminNav(
  user: AdminNavUser | null | undefined,
  opts: { locals?: any; sections?: AdminNavEntry[] } = {},
): Promise<AdminNavEntry[]> {
  const sections = opts.sections || ADMIN_NAV;
  try {
    if (!user?.id) return failsafeNav(sections);
    const role = String(user.role || '').trim();

    // FAST PATH, and the reason it is safe to take: super_admin is unrestricted in BOTH systems — the
    // wildcard in the registry, and the `null` (no filtering) getViewableSectionKeys returns — and a
    // custom role cannot narrow that. No database read can change the answer, so none is made. This
    // keeps every page load by the people who load the console most at zero extra queries, which is
    // what the sidebar costs today and is worth preserving on a database billed by compute time.
    // isActive is still checked: a deactivated account keeps its role, and resolvePermissions would
    // have refused it. `=== true`, not `!== false`. Astro.locals.user is the full users row and validateSession()
    // already deletes the session of a deactivated account, so the fast path still costs zero
    // queries for the real caller. A caller passing a PARTIAL user ({ id, role }) has no isActive to
    // check, and reading "absent" as "active" is how a fast path hands the whole console to an
    // account somebody deactivated an hour ago. Absent now falls through to resolvePermissions,
    // which reads is_active from the database and answers correctly either way.
    if (role === 'super_admin' && user.isActive === true) {
      return navForPermissions(sections, navPermissionsForRole('super_admin'));
    }

    const resolved = await resolvePermissions(String(user.id), { locals: opts.locals });

    // ANY answer that is not 'ok' means the resolver DECLINED to say what this person holds, and its
    // permission set is empty in every one of those cases. Trusting `degraded` alone was a fail-OPEN
    // hole: denied() marks 'not-found' and 'account-disabled' as degraded=false — they are honest
    // answers, not outages — so both fell through to the branch below, which throws the resolver's
    // answer away and recomputes the menu from `user.role` on the session object. A deactivated HR
    // account got the full 34-entry HR sidebar; an account deleted mid-session got the sidebar of
    // whatever role its stale cookie still claimed. Neither could open the pages behind those links,
    // but the link list itself is the disclosure this module exists to withhold.
    if (resolved.reason !== 'ok') {
      // Said out loud, with the reason: an empty sidebar and no explanation reads as a permissions
      // problem and sends somebody looking in the wrong place for hours. 'lookup-failed' is an
      // outage; 'account-disabled' and 'not-found' are a stale session and want a different fix.
      logEvent('warn', 'admin.nav.not-resolved', {
        userId: String(user.id),
        role: role || null,
        reason: resolved.reason,
        degraded: resolved.degraded,
      });
      return failsafeNav(sections);
    }

    if (resolved.customRoles.length === 0) {
      // resolved.role, NOT `resolved.role || role`. Past this point the resolver answered 'ok', so
      // it read users.role from the database — that is the authoritative value, and the one the door
      // enforces against. Falling back to the role on the session object would let a stale or
      // tampered cookie name a wider role than the account actually has and get a wider menu for it.
      // A null here means the stored role is blank, and navPermissionsForRole() answers that with an
      // empty set: nothing but the universal entries, which is the correct answer to "no role".
      return navForPermissions(sections, navPermissionsForRole(resolved.role));
    }

    // 'dashboard' unconditionally, exactly as getViewableSectionKeys does for anyone holding a custom
    // role. It is universal in the nav anyway, so this only matters if that ever changes — and then it
    // should still match the door rather than quietly differ from it.
    const held = new Set<string>(['dashboard.view']);
    if (resolved.permissions.has(WILDCARD)) held.add(WILDCARD);
    for (const custom of resolved.customRoles) {
      // Grants UNION the section matrix, per role. permissionsForRole() logs and returns [] on
      // failure, so a broken read shrinks the menu; it can never grow it.
      for (const grant of await permissionsForRole(custom.id)) held.add(grant.key);
    }
    return navForPermissions(sections, held);
  } catch (e: any) {
    logEvent('error', 'admin.nav.failed', { userId: String(user?.id || ''), message: reason(e) });
    return failsafeNav(sections);
  }
}
