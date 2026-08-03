// src/lib/workforce/navigation.ts — the workspace navigation, DERIVED from a composition.
//
// THIS FILE DECIDES NOTHING. That sentence is the whole design.
//
// src/lib/workforce/composer.ts already answered "what may this person reach" — once per request,
// from the real gates, against capabilities rather than role names. A navigation bar that asked that
// question a second time would be a second authorization engine, and the two would disagree within a
// month; the one that answered too generously would be the one nobody noticed. So this module takes
// the COMPOSED RESULT as its only input and projects it into a list of doors. It performs no query,
// imports nothing that opens a database connection, compares no role name, and cannot widen anything.
//
// FOUR RULES, ALL LOAD-BEARING.
//
//   1. A DESTINATION IS OFFERED ONLY IF THE COMPOSER ALREADY KEPT SOMETHING THAT PROVES THE PERSON
//      MAY OPEN IT. Most entries are gated on `has('<widget key>')` — the widget the composer decided
//      to show, whose own audience predicate and permission requirements have already been resolved
//      against the real gates. A nav entry the user cannot open is worse than no entry: it is a
//      promise the app breaks, and the person is bounced to a denial screen with no idea why.
//
//   2. WHERE NO WIDGET EXISTS, THE ENTRY MIRRORS THE DESTINATION'S OWN GATE AND MAY ONLY NARROW IT.
//      Four surfaces (Messages, Meet, Mail, Settings) have no registered widget because no loader for
//      them exists yet. Their pages gate on "signed in" and nothing more. Offering them to every
//      signed-in account would therefore be accurate and still wrong as a product: an applicant does
//      not belong in the staff DM list. So they carry `worksHere` — has an employee record, or holds
//      admin.access — which is strictly NARROWER than the page's own gate. Narrowing under-shows,
//      which costs one message to HR. Widening hands somebody a surface that was not theirs.
//      NO PREDICATE HERE MAY EVER BE WIDER THAN THE GATE ON THE PAGE IT LINKS TO.
//
//   3. EVERY HREF IS A ROUTE THAT EXISTS TODAY. Verified against src/pages/. What does not exist is
//      recorded in NAV_BACKLOG with the artefact that must ship first, so "it is missing" is never
//      mistaken for "nobody thought of it". Inventing a link to a module that does not exist is the
//      same defect as a nav entry the person cannot open, with a 404 instead of a denial.
//
//   4. A DEGRADED COMPOSITION COLLAPSES THE NAV, AUTOMATICALLY. When the composer could not resolve
//      the context it returns MINIMAL_WIDGETS (welcome.banner + notifications.unread + profile.me).
//      Because eligibility here is expressed as "did the composer keep this widget", every
//      widget-gated entry drops out on its own — no separate degraded branch to write, and none to
//      forget. What SURVIVES is Home, Profile, and the two entries whose audience is `anyone`:
//      Learning and Settings. That is checked, not assumed, and it is correct — /portal/courses and
//      /portal/security each gate on "signed in" and nothing more, which is exactly what a degraded
//      composition still establishes. Four entries fit the bar, so no More tab appears.
//      NOTE the ordering consequence: `worksHere` reads ctx.hasEmployeeRecord and ctx.holds(), both
//      of which are false/empty on a degraded context, so Messages, Meet and Mail drop out too.
//
// MOBILE IS THE PRIMARY TARGET. Roughly nine in ten of these people are on a phone. The bar holds at
// most four tabs, because BottomNav.astro:121-123 measured that five at 360px gives about 72px each
// against a 10px label. Everything else lives behind one "More" tab that opens the full list. The
// component that renders this (src/components/workforce/WorkspaceNav.astro) holds to a 44px touch
// floor via --wf-touch and never lets a row scroll the page sideways.
import type { ComposedWorkspace } from '@/lib/workforce/composer';
import type { WorkspaceContext } from '@/lib/workforce/widgets';

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * The glyph names BottomNav.astro:88-95 actually carries. Deliberately restricted to that set: this
 * module hands `icon` straight to that component, which falls back to 'grid' for anything it does not
 * know, and a fallback that renders silently is how two different destinations end up wearing the
 * same picture without anybody noticing.
 *
 * There is no 'menu' glyph over there today, so the More tab reuses 'grid'. Adding one is a one-line
 * change to an existing component and is recorded in the build report rather than made here.
 */
export type NavIcon = 'grid' | 'message' | 'book' | 'user' | 'calendar' | 'checklist';

/** The bands the drawer lays out in. Order here is the order they render in. */
export type NavGroup = 'workspace' | 'work' | 'communicate' | 'time' | 'record' | 'account';

export const NAV_GROUP_LABELS: readonly { group: NavGroup; label: string }[] = [
  { group: 'workspace', label: 'Workspace' },
  { group: 'work', label: 'Work' },
  { group: 'communicate', label: 'Talk to people' },
  { group: 'time', label: 'Your time' },
  { group: 'record', label: 'Your record' },
  { group: 'account', label: 'Account' },
];

/**
 * Everything a nav predicate is allowed to know. It is the composed context plus the composer's own
 * verdict on each widget — no user object, no email, no role, no database handle. A predicate that
 * cannot reach a role cannot test one.
 */
export interface NavView {
  ctx: WorkspaceContext;
  /** Did the composer KEEP this widget for this person? */
  has: (widgetKey: string) => boolean;
}

export type NavAudience = (v: NavView) => boolean;

export interface NavDestination {
  key: string;
  label: string;
  /** A route that exists in src/pages today. Empty string means "resolved per person" — Home only. */
  href: string;
  icon: NavIcon;
  group: NavGroup;
  /**
   * Rank in the bottom bar; lower is further left. `null` means drawer only. At most three ranked
   * entries reach the bar when a More tab is needed, so this ordering is what decides the three
   * things a person can reach with one thumb.
   */
  bar: number | null;
  audience: NavAudience;
  /**
   * The gate on the destination page itself, written out so the next reader can check that the
   * predicate above is not wider than it. This is documentation with teeth: if these two ever
   * disagree, the entry is a broken promise or a leak.
   */
  gate: string;
}

// ---------------------------------------------------------------------------------------------
// Predicates. Named, and the only vocabulary a destination speaks.
// ---------------------------------------------------------------------------------------------

/** Any signed-in person. The composition is never built without one. */
const anyone: NavAudience = () => true;

/**
 * "This person works here."
 *
 * An employee record, OR admin.access. The second arm is not a convenience: `hasEmployeeRecord` is
 * false for exactly the people the workforce surfaces exist to serve at the top — an HR account or a
 * founder who has no hr_employees row of their own — and gating the workplace cluster on the record
 * alone would hand them the narrowest screen in the product. Both facts come off the composed
 * context. Neither is a role name.
 */
const worksHere: NavAudience = (v) => v.ctx.hasEmployeeRecord || v.ctx.holds('admin.access');

/** The composer kept at least one of these widgets. */
const keptAny = (...keys: string[]): NavAudience => (v) => keys.some((k) => v.has(k));

// ---------------------------------------------------------------------------------------------
// THE DESTINATIONS. Every href checked against src/pages on 2026-08-03.
// ---------------------------------------------------------------------------------------------

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  // ---------------------------------------------------------------- workspace
  {
    key: 'home',
    label: 'Home',
    // Resolved per person by buildWorkspaceNav: /portal/employee for anyone with an employee record,
    // /portal otherwise. It is the ONE entry whose target depends on who is reading, because "home"
    // is the only word in this list that means a different room to different people.
    href: '',
    icon: 'grid',
    group: 'workspace',
    bar: 0,
    audience: anyone,
    gate: '/portal/employee and /portal both gate on "signed in" only; each renders its own denial.',
  },
  {
    key: 'notifications',
    label: 'Notifications',
    href: '/portal/notifications',
    icon: 'grid',
    group: 'workspace',
    // DRAWER ONLY. bar:null on purpose — the bar slots are already spoken for, and an inbox that
    // displaces a work surface is a worse trade than one more tap. Filed under 'workspace' rather
    // than 'communicate' because it is not a conversation: approvals, leave decisions, attendance
    // flags, workflow steps and mail all land in it.
    bar: null,
    // `anyone`, and that is EXACTLY the page's own gate. Every row in `notifications` is keyed by
    // user_id and every query on that page is narrowed to the reader's own, so there is no
    // capability to ask for and nothing a narrower audience would protect — it would only hide an
    // inbox from the person it belongs to. That was the whole defect: the page carried
    // `if (user.role !== 'applicant') return Astro.redirect('/admin')`, which threw every employee
    // at a console middleware then bounced them off. That line is gone; this is the door.
    audience: anyone,
    gate: 'Signed in (notifications.astro). Own rows only — every read is narrowed by user_id, and both writes go through /api/portal/notifications-recent, which narrows the same way.',
  },

  // ---------------------------------------------------------------- work
  {
    key: 'tasks',
    label: 'Tasks',
    href: '/portal/tasks',
    icon: 'checklist',
    group: 'work',
    bar: 1,
    // EXACTLY the page's own gate, in the composition's vocabulary. tasks/index.astro:132 runs
    // requireEmployee and gives a 'no-employee-record' denial a second look through requireTeamLead —
    // so an employee record OR a department scope opens the board, and nothing else does. Gating on
    // tasks.signoff (audience: anyone) instead would offer the board to every signed-in account and
    // land most of them on a denial.
    audience: (v) => v.has('tasks.mine') || !!v.ctx.scopeDepartmentId,
    gate: 'requireEmployee, with requireTeamLead as the second look for a no-employee-record denial.',
  },
  {
    key: 'approvals',
    label: 'Approvals',
    href: '/portal/approvals',
    icon: 'checklist',
    group: 'work',
    bar: 4,
    // ctx.approvesRequests, reached through the two widgets rather than the flag, so the entry and the
    // cards cannot disagree. The page itself checks only "signed in" — the authority lives in the
    // readers (pendingLeaveForApprover / pendingWithdrawalsForApprover) and is re-checked at the
    // write by decideLeave / decideWithdrawal. Offering the door to someone with no queue would show
    // them an empty screen, not another person's rows, but an empty screen is still a broken promise.
    audience: keptAny('approvals.leave', 'approvals.withdrawal'),
    gate: 'Page: signed in. Contents and every decision: approverRole() per row, re-checked at the write.',
  },
  {
    key: 'community',
    label: 'Community',
    href: '/portal/discussion',
    icon: 'message',
    group: 'work',
    bar: 5,
    // groups.mine is audience: anyone, so this is offered to any resolvable composition and disappears
    // on a degraded one — which is the correct direction for a board whose only gate is "signed in".
    audience: keptAny('groups.mine', 'discussion.recent'),
    gate: 'Signed in. Group membership is scoped inside visibleGroupsFor(); an unentitled group is absent, not greyed out.',
  },
  {
    key: 'referrals',
    label: 'Refer someone',
    href: '/portal/employee/referrals',
    icon: 'user',
    group: 'work',
    // DRAWER ONLY. Referring somebody is something a person does a handful of times a year, and
    // taking a bar slot from Tasks or Messages to give it one would be a worse trade than the extra
    // tap. The four ranked tabs are unchanged by this entry.
    bar: null,
    // EXACTLY the page's own gate, in the composition's vocabulary. /portal/employee/referrals gates
    // on having an employee record — a FACT about a row, not a capability — because an employee's
    // account frequently carries the `applicant` role, which holds nothing at all. Not `worksHere`:
    // that arm also admits admin.access holders with no employee record, and the page would give
    // them the "not on the employee register" screen. Narrower than the page, never wider.
    audience: (v) => v.ctx.hasEmployeeRecord === true,
    gate: 'Signed in, then an employee record. Every query is narrowed to the reader\'s own referrals by referrerUserId in the WHERE clause.',
  },
  {
    key: 'procurement',
    label: 'Purchases',
    href: '/portal/employee/procurement',
    icon: 'checklist',
    group: 'work',
    // DRAWER ONLY. Asking to buy something is an occasional act, and a ranked entry would push an
    // existing tab out of the four-slot bar. Same reasoning as 'payslips' and 'organization'.
    bar: null,
    // EXACTLY the page's own gate, in the composition's vocabulary: procurement.astro runs
    // requireEmployee and renders a named denial without one. NOT gated on a capability, and there
    // must not be one here — an employee's account frequently carries the `applicant` role, which
    // holds nothing at all, and gating on a permission would hide a person's own requests from them.
    //
    // NOTE that this page ALSO carries an approver's own decision queue, resolved through
    // workflow.pendingForApprover() — routed and delegated steps only. The entry is not gated on
    // being an approver: the page is primarily the requester's, and an approver without an employee
    // record cannot be routed anything anyway, because the Organization Graph is keyed on
    // hr_employees.id.
    audience: (v) => v.ctx.hasEmployeeRecord,
    gate: 'requireEmployee, then own rows only — listRequests() is narrowed by requester_user_id in the WHERE clause and refuses outright rather than widening if that id is unusable. The decision queue is workflow.pendingForApprover(), and every decision is re-checked by mayAct() inside the engine against the POSTED instance id.',
  },

  // ---------------------------------------------------------------- communicate
  {
    key: 'messages',
    label: 'Messages',
    href: '/portal/messages',
    icon: 'message',
    group: 'communicate',
    bar: 2,
    audience: worksHere,
    gate: 'Page: signed in (messages.astro:6). Threads are scoped by membership in the query. This entry NARROWS that to people who work here.',
  },
  {
    key: 'meet',
    label: 'Meet',
    href: '/portal/meet',
    icon: 'calendar',
    group: 'communicate',
    bar: 6,
    audience: worksHere,
    gate: 'Page: signed in (meet/index.astro:6). Narrowed here to people who work here.',
  },
  {
    key: 'mail',
    label: 'Mail',
    href: '/portal/mail',
    icon: 'message',
    group: 'communicate',
    bar: 7,
    audience: worksHere,
    gate: 'Page: signed in (mail.astro). /portal/mail is now a READ-ONLY ARCHIVE of the old portal_mail_* schema and redirects to /portal/employee/mail — the real SMTP/IMAP client — for anyone with nothing stored in it. Narrowed here to people who work here, which matches canUseMailbox() on the route it hands off to. See NAV_BACKLOG mail.archive.',
  },

  // ---------------------------------------------------------------- time
  {
    key: 'attendance',
    label: 'Attendance and hours',
    href: '/portal/workspace',
    icon: 'calendar',
    group: 'time',
    bar: 8,
    audience: keptAny('attendance.month', 'clock.today', 'timelog.today'),
    gate: 'requireEmployee (workspace.astro:45); every query narrowed by employeeFilter(ws) in the WHERE clause.',
  },
  {
    key: 'leave',
    label: 'Leave',
    href: '/portal/employee/leave',
    icon: 'calendar',
    group: 'time',
    bar: 9,
    audience: keptAny('leave.mine', 'leave.balance'),
    gate: 'Page: signed in, then its own employee lookup. Widget audience: withEmployeeRecord, which is the narrower of the two.',
  },
  {
    key: 'timesheet',
    label: 'Attendance',
    href: '/portal/employee/attendance',
    icon: 'calendar',
    group: 'time',
    // RANK 3, SHARED WITH 'team', AND THE TIE IS DELIBERATE RATHER THAN AN OVERSIGHT.
    // buildWorkspaceNav sorts by rank with Array.prototype.sort, which is stable by specification,
    // so equal ranks keep NAV_DESTINATIONS order — and the `time` group is declared above `record`.
    // When a department lead is eligible for both, Attendance takes the bar slot and Team moves to
    // the drawer. That is the right trade: checking in is a daily act performed with one thumb, and
    // a team roster is a reference somebody opens occasionally. It is deterministic, not luck.
    //
    // NOT the same destination as the 'attendance' entry above it. That one opens /portal/workspace,
    // which SHOWS a month of recorded hours alongside credit hours, documents and reviews. This one
    // is the surface a person WRITES from: check in, check out, breaks, the week's timesheet, and
    // the way into a correction request. Two different acts, and merging them would mean the read
    // screen's other four sections sit between somebody and the check-in button.
    bar: 3,
    // EXACTLY the page's own gate, in the composition's vocabulary. index.astro runs requireEmployee
    // and renders its named denial without one; all three of these widgets carry withEmployeeRecord,
    // so they are true for precisely the accounts the page admits. Gating on the roster-management
    // capability instead would hide check-in from everybody who is not HR.
    audience: keptAny('attendance.month', 'clock.today', 'timelog.today'),
    gate: 'requireEmployee. Every punch, timesheet and correction is scoped to the caller\'s own employee id in the query; the write re-checks the punch rule on the POSTED value rather than on the rendered buttons.',
  },
  {
    key: 'calendar',
    label: 'Calendar',
    href: '/portal/employee/calendar',
    icon: 'calendar',
    group: 'time',
    // DRAWER ONLY. The four bar slots are already spoken for by daily acts; a calendar is something
    // people open when they are planning, not something they tap between two other things.
    bar: null,
    // The page itself gates on "signed in" and then scopes every source. `worksHere` NARROWS that to
    // people with an employee record or admin.access, which is the same treatment Messages, Meet and
    // Mail get and for the same reason: an applicant does not belong in the staff calendar even
    // though the page would give them an honest empty personal view if they arrived.
    //
    // DELIBERATELY NOT gated on managing anybody. The team and department tabs scope themselves from
    // the Organization Graph inside the query, so offering the door costs nothing and hiding it from
    // every non-manager would hide their own hours, leave and holidays from them.
    audience: worksHere,
    gate: 'Page: signed in. Contents: personal sources scoped to the caller\'s own employee id; team and department scoped from the Organization Graph (direct reports, headed departments) or employee.manage. A person you may not see is not fetched rather than hidden.',
  },
  {
    key: 'search',
    label: 'Search',
    href: '/portal/search',
    icon: 'grid',
    group: 'workspace',
    // DRAWER ONLY, on purpose. Search is a destination people go to with intent, and giving it one
    // of four thumb slots would cost Tasks or Messages theirs.
    bar: null,
    // `worksHere`, strictly narrower than the page's own "signed in" gate. Every source narrows
    // itself in its WHERE clause, so the entry decides only whether the door is worth showing.
    audience: worksHere,
    gate: 'Page: signed in. Every source is scoped in the query — people through the Organization Graph, departments through employee.manage or a headed department, tasks to your own and ones you assigned, documents to your own account, drafts through content.view. A result you may not open is never selected, so it cannot appear as a hidden row or move a count.',
  },

  // ---------------------------------------------------------------- record
  {
    key: 'documents',
    // RENAMED from 'Documents' when the company library shipped. This entry opens JOINING papers
    // (/portal/onboarding); the library is 'library' below. One word meaning two rooms is a
    // navigation defect, not a naming preference.
    label: 'Joining documents',
    href: '/portal/onboarding',
    icon: 'book',
    group: 'record',
    bar: 10,
    // HONEST LABEL, NARROW CONTENT: this is the JOINING-document surface. There is no company document
    // library, policy repository or shared drive anywhere in this codebase, and documents here are
    // Google Drive links rather than uploads, by standing rule. See NAV_BACKLOG.
    audience: keptAny('onboarding.docs'),
    gate: 'Signed in, own rows only (keyed by users.id). The review branch is a separate section grant.',
  },
  {
    key: 'payslips',
    label: 'Payslips',
    href: '/portal/employee/payslips',
    icon: 'book',
    group: 'record',
    // DRAWER ONLY. Adding a ranked entry would push an existing tab out of the four-slot bar, and pay
    // is something people open monthly, not with a thumb between meetings. Same reasoning as
    // 'organization' above.
    bar: null,
    // EXACTLY the page's own gate, expressed in the composition's vocabulary. payslips.astro resolves
    // an hr_employees row for the signed-in account and renders a named empty state when there is
    // none; every read on it is narrowed by employee_id in the WHERE clause. There is no capability
    // involved, and there must not be one here: an employee's account frequently carries the
    // `applicant` role, which holds nothing at all, and gating on a permission would hide a person's
    // own pay from them.
    audience: (v) => v.ctx.hasEmployeeRecord,
    gate: 'Signed in, then its own hr_employees lookup; payslipsForEmployee() narrows every row by employee_id. Individual payslips open at /portal/payslip/[id], which re-checks ownership.',
  },
  {
    key: 'contract',
    label: 'My contract',
    href: '/portal/employee/contract',
    icon: 'book',
    group: 'record',
    // DRAWER ONLY, for the same reason as Payslips: a ranked entry would push an existing tab out of
    // the four-slot bar, and a person opens their contract when something prompts them to — a renewal
    // date, a question about notice — not with a thumb between meetings.
    bar: null,
    // EXACTLY the page's own gate in the composition's vocabulary. contract.astro runs
    // requireEmployee(), which admits an ACTIVE employee record and nothing else, and
    // ctx.hasEmployeeRecord is set from the same resolveWorkspace() lookup (composer.ts:523) — so the
    // entry and the gate answer from one source rather than two that can drift.
    //
    // NO CAPABILITY HERE, and that is deliberate: an employee's account very often carries the
    // `applicant` role, which holds nothing at all, and gating this on a permission would hide a
    // person's own employment terms from them. No widget backs it either — a contract is not a
    // dashboard card, and inventing one to gate a link would put a second reader of the same rows on
    // the home screen.
    audience: (v) => v.ctx.hasEmployeeRecord,
    gate: 'requireEmployee (contract.astro): an active employee record. Every read is filtered by ws.employeeId from the SESSION — there is no employee id in the URL, so there is nothing to change in the address bar.',
  },
  {
    key: 'expenses',
    label: 'Expenses and claims',
    href: '/portal/employee/expenses',
    icon: 'book',
    group: 'record',
    bar: null,
    // Same predicate, same reason. NOTE that this page ALSO carries an approver's own decision queue,
    // resolved through workflow.pendingForApprover() — routed and delegated steps only — and that
    // section renders only when it has rows. The nav entry is not gated on being an approver: the page
    // is primarily the claimant's, and an approver without an employee record cannot be routed
    // anything in the first place, because the Organization Graph is keyed on hr_employees.id.
    audience: (v) => v.ctx.hasEmployeeRecord,
    gate: 'Signed in, then its own hr_employees lookup. Claims are scoped by employee_id; the decision queue is scoped by workflow.pendingForApprover() and every decision is re-checked by mayAct() at the write.',
  },
  {
    key: 'learning',
    label: 'Learning',
    href: '/portal/courses',
    icon: 'book',
    group: 'record',
    bar: 11,
    // THE CATALOGUE, and it stays pointed at the catalogue. No widget backs this: learning.assigned
    // is UNREGISTERED because training_enrollments has one writer (the learner opening a course) and
    // no assigned_by, due_at or required column. The catalogue is open to any signed-in account and
    // narrows its own rows by access_type — which is why the audience is `anyone`, and why this entry
    // must NOT be repointed at the employee learning surface below: an applicant belongs in the
    // catalogue and does not belong in a staff learning path.
    audience: anyone,
    gate: 'Signed in (courses/index.astro:6). The catalogue narrows itself by access_type.',
  },
  {
    // MY LEARNING — the assigned path, skills, certificates and the training calendar.
    //
    // DRAWER ONLY (`bar: null`), for the same reason Organization is: the bar holds four tabs at
    // 360px, and taking one from Tasks or Messages for a surface people open weekly rather than
    // hourly is a worse trade than the extra tap.
    //
    // `worksHere` — an employee record, or admin.access — is STRICTLY NARROWER than the page's own
    // gate, which is "signed in". The page gives an account with no employee record an honest screen
    // saying so and pointing at the open catalogue, so anybody who arrives is never stranded; the
    // narrowing is a product decision, not a security one. Rule 2 of this file: a nav predicate may
    // narrow a page's gate and may never widen it.
    key: 'mylearning',
    label: 'My learning',
    href: '/portal/employee/learning',
    icon: 'book',
    group: 'record',
    bar: null,
    audience: worksHere,
    gate: 'Page: signed in, then its own hr_employees lookup. Assignments and skills are scoped by employee_id; who may assign to whom is resolved per row from the Organization Graph.',
  },
  {
    // PERFORMANCE — goals and OKRs, appraisal, feedback, and a team tab for a manager.
    //
    // THIS ANSWERS THE `performance` NAV_BACKLOG ENTRY below, which said the entry becomes real when
    // a dedicated portal surface exists rather than pointing at /portal/workspace. It now does.
    //
    // NOT GATED ON MANAGING PEOPLE, deliberately. Goals, appraisal and feedback are the employee's
    // own and are most of what this page is; the team tab appears INSIDE the page when the
    // Organization Graph records direct reports, or the viewer holds `performance.manage`. Gating the
    // door on being a manager would hide an employee's own appraisal from them.
    //
    // `worksHere` is narrower than the page's own gate ("signed in"), exactly like My learning above.
    key: 'performance',
    label: 'Performance',
    href: '/portal/employee/performance',
    icon: 'checklist',
    group: 'record',
    bar: null,
    audience: worksHere,
    gate: 'Page: signed in, then its own hr_employees lookup. Every other-person read is scoped by src/lib/performance-scope.ts, which defers to org-graph.ts isResponsibleFor / getDirectReports — a relationship per row, never a role name.',
  },
  {
    key: 'team',
    label: 'Team',
    href: '/portal/team',
    icon: 'user',
    group: 'record',
    bar: 3,
    // team.roster carries audience leadsADepartment, which is ctx.scopeDepartmentId — the same and only
    // thing requireTeamLead() admits on. A reporting manager with direct reports is NOT a team lead
    // here and gets no entry, because /portal/team would refuse them; reports.direct has no surface to
    // link to yet (NAV_BACKLOG).
    audience: keptAny('team.roster'),
    gate: 'requireTeamLead (team.astro:96): department.lead capability AND users.assigned_department_id, and never an intern.',
  },
  {
    key: 'organization',
    label: 'Organization',
    href: '/portal/organization',
    icon: 'user',
    group: 'record',
    // DRAWER ONLY. `bar: null` keeps the four ranked tabs exactly as they were: this is a reference
    // surface people open occasionally, not a thumb destination, and taking a bar slot from Tasks or
    // Messages to give it one would be a worse trade than the extra tap.
    bar: null,
    // `worksHere` — an employee record, or admin.access. STRICTLY NARROWER than the page's own gate,
    // which is "signed in", exactly like Messages, Meet and Mail above and for the same reason: an
    // applicant does not belong in the staff org chart even though the page would give them an
    // honest "you are not on the organization graph" screen if they arrived.
    //
    // NOT gated on holding the whole-graph capability. That would offer the page ONLY to HR and hide
    // it from every employee entitled to see their own reporting line — which is most of the people
    // it was built for. The page scopes itself per viewer in the QUERY; the nav entry only decides
    // whether the door is worth showing.
    audience: worksHere,
    gate: 'Page: signed in. Contents: resolveOrgViewerScope() — employee.manage for the whole graph, a department_head EDGE in the graph for a department subtree, an employee record for your own line. Never a role name.',
  },
  {
    key: 'hr',
    label: 'HR',
    href: '/admin/hr/employees',
    icon: 'user',
    group: 'record',
    bar: 12,
    // THE PEOPLE TEAM'S OWN WORKSPACE. headcount.summary already requires admin.access AND the
    // employees:view section grant, resolved by the composer through canAccessSection() — the same two
    // tests middleware.ts enforces at the door (the deny-by-default canOpenAdmin gate at :353 and the
    // section gate at :374). So anybody offered this entry is admitted by middleware, and anybody
    // middleware would bounce never sees it.
    audience: keptAny('headcount.summary'),
    gate: 'middleware canOpenAdmin (admin.access, and no current internship record) + section employees:view.',
  },
  {
    key: 'analytics',
    label: 'Analytics',
    // NOT /admin/analytics. That route already exists and is the WEBSITE traffic console
    // (analytics_pageviews, analytics_sessions, live visitor sessions) — a different subject on a
    // different data model. Two paths, no duplicated module, and nothing that page does is moved.
    href: '/admin/analytics/workforce',
    icon: 'grid',
    group: 'record',
    // DRAWER ONLY. Two accounts hold the capability; it does not need a thumb slot.
    bar: null,
    // MIRRORS THE PAGE'S OWN GATE EXACTLY, which is the rule for an entry with no widget behind it.
    // The page asks can(user, 'analytics.view') on its first lines, because src/middleware.ts
    // has no section key for that path and canOpenAdmin() alone would admit every admin-capable role.
    // ctx.holds is wildcard-aware, so a super_admin's '*' answers true here — a bare set membership
    // test would hide the console from the founder, which is exactly how a console became
    // unreachable on this project once already.
    //
    // Nobody offered this entry is refused by the page, and nobody the page would refuse sees it.
    audience: (v) => v.ctx.holds('analytics.view'),
    gate: 'Page: can(user, \'analytics.view\') — super_admin and hr. Contents: aggregate only, every query a count or a breakdown, nothing per person, and anything covering fewer than the platform minimum group size is withheld along with its total.',
  },

  // ---------------------------------------------------------------- account
  {
    key: 'profile',
    label: 'Profile',
    href: '/portal/profile',
    icon: 'user',
    group: 'account',
    bar: 13,
    // profile.me is a MINIMAL widget, so this survives a degraded composition — which is exactly right:
    // "you are signed in as" is the one thing still worth offering when nothing else resolved.
    // NOTE: /portal/profile/edit still redirects every non-applicant to /admin, so this entry points at
    // the read surface only. See NAV_BACKLOG.
    audience: keptAny('profile.me'),
    gate: 'Signed in (profile.astro:6). The non-applicant redirect that used to sit here was removed after it caused a redirect loop.',
  },
  {
    key: 'employee-profile',
    label: 'My employee profile',
    href: '/portal/employee/profile',
    icon: 'user',
    group: 'account',
    // DRAWER ONLY, and NOT a replacement for 'profile' above. The two are different rooms: /portal/profile
    // is the ACCOUNT — who you are signed in as, offered to anybody including applicants — and this is
    // the EMPLOYEE RECORD an employee owns and edits. Labelled so the difference is readable in the
    // drawer rather than resolved by clicking both.
    bar: null,
    // The employee record, from the composed context. Same predicate as 'payslips' and 'expenses', and
    // NOT a capability: an employee's account frequently carries the `applicant` role, which holds
    // nothing at all, so a permission gate here would hide a person's own record from them.
    audience: (v) => v.ctx.hasEmployeeRecord,
    gate: 'requireEmployee (profile.astro). Every read and every write is scoped to the employee id resolved from the SESSION, never from a form field. HR keeps reading the same hr_employees columns on /admin/hr/employees; no admin surface is built over the profile sections, and this page widens nobody\'s visibility. There is no medical section anywhere in it.',
  },
  {
    key: 'settings',
    label: 'Settings',
    href: '/portal/security',
    icon: 'user',
    group: 'account',
    bar: 14,
    audience: anyone,
    gate: 'Signed in (security.astro:7). Sign-in methods and 2FA for the signed-in account only.',
  },
  {
    key: 'support',
    label: 'Support',
    href: '/portal/hr-support',
    icon: 'message',
    group: 'account',
    bar: 15,
    // HONEST NARROWING, carried over from the widget's own note: hr_application_support is the PAID,
    // CANDIDATE-facing application-support service. It is the only support store in this codebase.
    // The entry shows a person their own sessions; it must never be worded as a way to raise a
    // workplace issue, because there is no staff helpdesk behind it.
    audience: keptAny('support.hr'),
    gate: 'Signed in, self-scoped in the WHERE clause (candidate_email = self OR user_id = self).',
  },

  // ---------------------------------------------------------------- workplace services
  {
    key: 'helpdesk',
    label: 'Helpdesk',
    href: '/portal/employee/support',
    icon: 'message',
    group: 'work',
    // DRAWER ONLY (bar: null would hide it from the ranked list entirely; a high rank keeps it in
    // the More drawer without taking a thumb slot from Tasks or Messages).
    bar: 16,
    // `worksHere` - an employee record, or admin.access. STRICTLY NARROWER than the page's own gate,
    // which is "signed in": the page renders an honest "no employee record" state for anybody else,
    // and an applicant has no business being offered the staff helpdesk.
    audience: worksHere,
    gate: 'Page: signed in, then its own hr_employees lookup. Every ticket read is narrowed by requester_employee_id in the WHERE clause, and every write re-checks mayViewTicket/mayWorkTicket on the posted id.',
  },
  {
    key: 'assets',
    label: 'My assets',
    href: '/portal/employee/assets',
    icon: 'grid',
    group: 'record',
    bar: 17,
    // NARROWER STILL: an employee record and nothing else. Assets are issued against hr_employees.id,
    // so an admin account with no employee row would open a page that can only say "nothing here" -
    // and `worksHere` would offer it to them. hasEmployeeRecord is the honest predicate.
    audience: (v) => v.ctx.hasEmployeeRecord,
    gate: 'Page: signed in, then its own hr_employees lookup. employeeAssets() narrows by that employee id in the WHERE clause; there is no all-assets read behind this page.',
  },
  {
    key: 'library',
    label: 'Document library',
    href: '/portal/employee/documents',
    icon: 'book',
    group: 'record',
    bar: 18,
    // DELIBERATELY A DIFFERENT KEY AND LABEL FROM 'documents' ABOVE, which opens JOINING papers at
    // /portal/onboarding. Two entries called "Documents" pointing at different rooms is how somebody
    // spends ten minutes looking for the travel policy in their own PAN card upload.
    audience: worksHere,
    gate: 'Page: signed in. Contents: listDocuments() narrows in the WHERE clause to what this person owns, what is published to the company or their department, and what is shared with them by name. The curator arm is a capability the page resolves and passes in.',
  }
];

// ---------------------------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT IN THE BAR, and the artefact each one needs first. Recorded here for the
// same reason widgets.ts records UNREGISTERED: so the next person does not spend an afternoon
// rediscovering that a module is missing rather than merely unlinked.
// ---------------------------------------------------------------------------------------------

export const NAV_BACKLOG: readonly { key: string; reason: string }[] = [
  {
    key: 'projects',
    reason:
      'ABSENT. No projects table, no project_id and no projectId anywhere in src/ or db/ — employee_tasks ' +
      'has no project relation. Grouping work by project is not answerable from this database, so there ' +
      'is no route to link to and none may be invented.',
  },
  {
    key: 'calendar.meetings',
    reason:
      'PARTLY ANSWERED, AND WORTH READING BEFORE ASSUMING IT STILL IS. A staff calendar now EXISTS at ' +
      '/portal/employee/calendar with a real nav entry: hr_shifts, hr_roster_assignments and hr_holidays ' +
      'were the missing tables and they are in src/lib/attendance-schema.ts, so the personal, team, ' +
      'department, holiday and training views all read live data. MEETINGS ARE ANSWERED NOW TOO, and ' +
      'the artefact this entry asked for is the thing that answered them. meet_rooms was bootstrapped ' +
      'in TWO shapes — /portal/meet/index.astro declared id TEXT with host_user_id INTEGER, ' +
      '/portal/meet/[id].astro declared both UUID — and src/lib/meet-schema.ts is now the ONE module ' +
      'that creates them, reconciling both additively (ALTER TABLE ... ADD COLUMN IF NOT EXISTS: ' +
      'nothing dropped, no type altered, no row rewritten). Because `invitees` is therefore guaranteed ' +
      'to exist, calendar-hub.ts reads meetings you were INVITED to as well as ones you host, and the ' +
      'scheduler\'s four call sites reach a real route at /api/meet/rooms. TWO HONEST LIMITS REMAIN. ' +
      'Invitations are still a JSONB array of addresses matched by text containment rather than rows, ' +
      'so a real invitee table is still the better artefact — it simply no longer sits on an ambiguous ' +
      'parent. And on a database still carrying the legacy id TEXT / host_user_id INTEGER types, no ' +
      'ALTER ... ADD COLUMN can change a column TYPE; that needs a human-run migration, and the ' +
      'surfaces say so rather than throwing. If an ICS feed is wanted, reuse src/lib/calendar.ts\'s ' +
      'serializer and token scheme rather than writing a second one.',
  },
  {
    key: 'performance',
    reason:
      'ANSWERED, and left here so the reasoning survives. This said an entry becomes real when a ' +
      'dedicated surface exists rather than pointing a second nav entry at /portal/workspace. It now ' +
      'does: /portal/employee/performance carries goals and OKRs, the appraisal cycle, continuous and ' +
      '360 feedback, and a manager tab, so `performance` is a real DESTINATION above and no longer a ' +
      'gap. WHAT IS STILL MISSING: probation and PIPs. src/lib/hr-lifecycle.ts holds working readers ' +
      'for both (getActiveProbation, listProbationReviews, listPips, listPipCheckins) and they have no ' +
      'portal reader anywhere — a person on a PIP cannot see their own plan or their own check-ins. ' +
      'That is a surface, not a module: the data and the writers already exist.',
  },
  {
    key: 'wallet',
    reason:
      'REACHABLE BUT NOT IN THE REQUESTED SET. /portal/employee/wallet exists and wallet.balance is ' +
      'registered, so an entry is a one-line addition when money is wanted in the bar. Left out here ' +
      'rather than added silently.',
  },
  {
    key: 'reports.direct',
    reason:
      'PARTLY ANSWERED, and worth reading before assuming it still is. A reporting manager with direct ' +
      'reports now has a place to SEE them: /portal/organization renders their own reporting line plus ' +
      'their direct reports, resolved from the Organization Graph — but only once the graph has been ' +
      'backfilled, and only as a read. ctx.managesPeople still comes from ' +
      'hr_employees.reporting_manager_id, the reports.direct widget still has no loader, and ' +
      '/portal/team is still department-lead only and would refuse them. What is missing is a WORKING ' +
      'surface for a manager (their reports\' tasks, leave and hours in one place), not a view of who ' +
      'they are.',
  },
  {
    key: 'mail.archive',
    reason:
      'ANSWERED, WITH ONE THING LEFT. MailClient.astro is now mounted for employees at ' +
      '/portal/employee/mail and /api/mail/{send,draft,action} authorise through ' +
      'src/lib/auth/mail-access.ts instead of canOpenAdmin, so the Mail entry reaches the REAL system. ' +
      'What remains is DATA, not code: /portal/mail is now a read-only archive of the old ' +
      'portal_mail_* schema and still redirects to the real mailbox for anyone with nothing in it. ' +
      'Those rows are not migrated into mail_messages/mail_box — that is a migration against live ' +
      'tables and belongs to a human. Until it runs, the Mail entry keeps pointing at /portal/mail so ' +
      'the redirect can hand people on without orphaning anybody\'s archive; repoint it straight at ' +
      '/portal/employee/mail the day the archive is empty.',
  },
  {
    key: 'documents.library',
    reason:
      'SHIPPED, and this entry is kept as the record of what changed. There is now a company document ' +
      'library (src/lib/documents.ts, /portal/employee/documents) with folders, categories, versions, ' +
      'sharing, retention and search, and it is reachable as the "Document library" entry above. The ' +
      'standing rule still holds and is enforced at the WRITE rather than in the form: documents are ' +
      'Google Drive links, never uploads. The Documents entry above is still JOINING papers only and ' +
      'was relabelled to say so.'
  },
  {
    key: 'profile.edit',
    reason:
      'ANSWERED, and worth reading before assuming it still is not. An employee now edits their own ' +
      'record at /portal/employee/profile — personal details, emergency contact, education, ' +
      'experience, skills, languages, certifications, achievements, links, identity-document links, ' +
      'the signature link, the optional bank and tax sections and the profile photo — behind the ' +
      'employee-profile entry above. It is a NEW page with its own requireEmployee gate rather than ' +
      'an edit to the loop: /portal/profile/edit:7 still redirects every non-applicant to /admin, and ' +
      'middleware bounces anyone without admin.access straight back, which is the loop shape that ' +
      'took /portal down before. THREE PAGES STILL CARRY THAT LINE and still have no entry pointing ' +
      'at them — /portal/notifications:7, /portal/requests/index:6, /portal/wallet:10. Each is a ' +
      'one-line page fix, not a module.',
  },
];

// ---------------------------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------------------------

/** The fragment the More tab targets. The drawer opens on :target — no JavaScript, and none needed. */
export const MORE_TARGET_ID = 'wsnav-more';

/** How many tabs the bar holds at 360px. Measured in BottomNav.astro:121-123, not guessed. */
export const BAR_CAPACITY = 4;

export interface NavEntry {
  key: string;
  label: string;
  href: string;
  icon: NavIcon;
  group: NavGroup;
}

export interface WorkspaceNavigation {
  /** Where Home points for this person. */
  home: string;
  /** Every destination this composition authorises, in bar order then declaration order. */
  entries: readonly NavEntry[];
  /** The bottom bar: at most BAR_CAPACITY, with the last slot given to More when anything is left over. */
  bar: readonly NavEntry[];
  /** The full list, grouped, for the drawer. Empty groups are absent, never rendered as a heading. */
  drawer: readonly { group: NavGroup; label: string; entries: readonly NavEntry[] }[];
  /** Is a More tab needed at all? False when everything authorised already fits in the bar. */
  hasMore: boolean;
  /** The key of the entry the reader is currently on, resolved from the path when not passed. */
  active: string;
  /** True when the composition was degraded — the caller should say so rather than imply this is all there is. */
  degraded: boolean;
}

export interface BuildNavOptions {
  /** The key of the current destination. When absent it is resolved from `pathname`. */
  active?: string;
  /** Astro.url.pathname. Used only to light the tab the person is already on. */
  pathname?: string;
}

/**
 * Project a composition into a navigation.
 *
 * Pure and synchronous: no query, no await, no user object. Call it with the SAME ComposedWorkspace
 * the page rendered its widgets from — composeWorkspace() memoises on Astro.locals, so a page that
 * composes and then navigates pays for one composition, not two.
 */
export function buildWorkspaceNav(
  composed: ComposedWorkspace,
  opts: BuildNavOptions = {},
): WorkspaceNavigation {
  const kept = new Set<string>(composed.widgets.map((w) => w.key));
  const view: NavView = {
    ctx: composed.context,
    has: (key: string) => kept.has(key),
  };

  // Home is the one per-person target. hasEmployeeRecord comes off the composition; it is not a role
  // test and it cannot be spoofed from the request.
  const home = composed.context.hasEmployeeRecord ? '/portal/employee' : '/portal';

  const entries: NavEntry[] = [];
  for (const d of NAV_DESTINATIONS) {
    let allowed = false;
    try {
      allowed = d.audience(view) === true;
    } catch {
      // A predicate that throws is a broken entry, and a broken entry must not be offered to
      // everybody. Fail closed, exactly as the composer does with a widget audience.
      allowed = false;
    }
    if (!allowed) continue;
    entries.push({
      key: d.key,
      label: d.label,
      href: d.key === 'home' ? home : d.href,
      icon: d.icon,
      group: d.group,
    });
  }

  // Bar order is the `bar` rank; anything unranked never reaches the bar.
  const rankOf = new Map<string, number>(
    NAV_DESTINATIONS.map((d) => [d.key, d.bar === null ? Number.MAX_SAFE_INTEGER : d.bar]),
  );
  const ranked = entries
    .filter((e) => (rankOf.get(e.key) ?? Number.MAX_SAFE_INTEGER) < Number.MAX_SAFE_INTEGER)
    .sort((a, b) => (rankOf.get(a.key) as number) - (rankOf.get(b.key) as number));

  const hasMore = ranked.length > BAR_CAPACITY;
  const bar: NavEntry[] = hasMore ? ranked.slice(0, BAR_CAPACITY - 1) : ranked.slice(0, BAR_CAPACITY);

  const drawer: { group: NavGroup; label: string; entries: NavEntry[] }[] = [];
  for (const g of NAV_GROUP_LABELS) {
    const inGroup = entries.filter((e) => e.group === g.group);
    if (inGroup.length > 0) drawer.push({ group: g.group, label: g.label, entries: inGroup });
  }

  return {
    home,
    entries,
    bar,
    drawer,
    hasMore,
    active: resolveActive(entries, opts),
    degraded: composed.degraded === true || composed.ok !== true,
  };
}

/**
 * Which tab is lit.
 *
 * Longest matching href wins, so /portal/employee/leave lights Leave rather than Home. An exact match
 * always beats a prefix. Returns '' when nothing matches, which lights nothing — better than lighting
 * the wrong thing, because an aria-current on the wrong tab tells a screen-reader user they are
 * somewhere they are not.
 */
function resolveActive(entries: readonly NavEntry[], opts: BuildNavOptions): string {
  if (opts.active) return opts.active;
  const path = String(opts.pathname || '').replace(/\/+$/, '') || '/';
  let bestKey = '';
  let bestLen = -1;
  for (const e of entries) {
    const href = e.href.replace(/\/+$/, '') || '/';
    const match = path === href || path.startsWith(href + '/');
    if (match && href.length > bestLen) {
      bestKey = e.key;
      bestLen = href.length;
    }
  }
  return bestKey;
}
