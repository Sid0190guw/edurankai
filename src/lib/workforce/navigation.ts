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
//      composition still establishes. Four entries survive; three of them take bar slots and the
//      fourth moves into the drawer, because the More tab is no longer conditional — see `hasMore`.
//      It carries the account block (who you are signed in as, and sign out), which must exist on a
//      degraded render too: that is the render where somebody is most likely to want out.
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
 * 'menu' EXISTS NOW, AND THE MORE TAB USES IT. It did not, and the More tab reused 'grid' — which is
 * also Home's glyph, so two of the four tabs wore the same picture. On a 360px bar the labels are
 * 10px, which makes the icon the primary scan target, and that made Home and More interchangeable at
 * a glance. Both BottomNav.astro and WorkspaceNav.astro carry the glyph now.
 */
export type NavIcon = 'grid' | 'message' | 'book' | 'user' | 'calendar' | 'checklist' | 'menu';

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
    // MOVED OUT OF THE BAR, from rank 2. Three ranked entries reach the bar, so rank 2 was a thumb
    // slot and this had it. An HRIS workspace is not a chat app: its DM volume is a fraction of its
    // punch volume, and the daily-open set on a staff portal is attendance, leave, payslips and
    // tasks. Rank 6 keeps it high in the More drawer, one tap away, and hands the slot to check-in.
    // It ties with 'meet' at 6; the sort is stable by specification and this entry is declared first,
    // so Messages wins the tie deterministically rather than by luck.
    bar: 6,
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
    // THE COMPANY FEED — announcements, recognition and milestones, on one page.
    //
    // IT WAS REACHABLE ONLY BY NOTIFICATION, WHICH IS NOT REACHABLE. The only two links to
    // /portal/feed/company anywhere in this codebase are actionUrl strings inside
    // src/lib/announcements.ts and src/lib/recognition.ts — so a person could open the wall the day
    // somebody recognised them and never find it again, and a person nobody had recognised yet could
    // not find it at all. An announcement nobody can go and read is a notice board in a locked room.
    //
    // `worksHere` — an employee record, or admin.access — is STRICTLY NARROWER than the page's own
    // gate, which is "signed in" followed by buildFeedViewer(). Same treatment as Messages, Meet and
    // Mail above and for the same reason: an applicant does not belong on the staff notice board even
    // though the page would give them an honest empty view. Rule 2 of this file.
    //
    // DRAWER ONLY. The four bar slots are daily acts; a notice board is read when something lands.
    key: 'company-feed',
    label: 'Company feed',
    href: '/portal/feed/company',
    icon: 'message',
    group: 'communicate',
    bar: null,
    audience: worksHere,
    gate: 'Page: signed in, then buildFeedViewer(). Audience scoping for every announcement is applied in the WHERE clause; recognition is public by design and carries no leaderboard. Narrowed here to people who work here.',
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
    // DELEGATION LIVES IN THE PORTAL because it is not something done TO a person: it is a person
    // deciding somebody may act for them while they are away. The one who decides is the one whose
    // authority it is, so the screen belongs beside their leave, not in a console they never open.
    //
    // Ranked below the daily surfaces on purpose. Handing authority over is a considered act
    // performed occasionally, not a thing anybody needs on the bar; it lives behind More, where a
    // person goes when they are already thinking about being away.
    key: 'delegation',
    label: 'Acting for each other',
    href: '/portal/employee/delegation',
    icon: 'user',
    group: 'account',
    bar: 22,
    audience: keptAny('leave.mine', 'leave.balance', 'clock.today', 'attendance.month'),
    gate: 'Page: signed in, then its own employeeIdForUser lookup. The principal is always the signed-in person and is never a form field, so no request can give away somebody else authority.',
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
    // RANK 2, AND THIS IS THE SLOT MESSAGES USED TO HOLD.
    //
    // The reasoning below was already written down and the number disagreed with it. Three ranked
    // entries reach the bar (the fourth slot is always the More tab), so rank 3 was the drawer: an
    // ordinary employee's bar read Home | Tasks | Messages | More, and clock-in — the one act
    // performed twice a day by every single person with a record — was two taps behind More. That is
    // the most repeated action in the product sitting deeper than a DM list.
    //
    // At rank 2 the bar reads Home | Tasks | Attendance | More. 'team' keeps rank 3 and moves to the
    // drawer for a department lead, which is the same trade the old comment argued for and got
    // wrong by one: checking in is a daily act performed with one thumb, a team roster is a
    // reference somebody opens occasionally.
    //
    // NOT the same destination as the 'attendance' entry above it. That one opens /portal/workspace,
    // which SHOWS a month of recorded hours alongside credit hours, documents and reviews. This one
    // is the surface a person WRITES from: check in, check out, breaks, the week's timesheet, and
    // the way into a correction request. Two different acts, and merging them would mean the read
    // screen's other four sections sit between somebody and the check-in button.
    bar: 2,
    // EXACTLY the page's own gate, in the composition's vocabulary. index.astro runs requireEmployee
    // and renders its named denial without one; all three of these widgets carry withEmployeeRecord,
    // so they are true for precisely the accounts the page admits. Gating on the roster-management
    // capability instead would hide check-in from everybody who is not HR.
    audience: keptAny('attendance.month', 'clock.today', 'timelog.today'),
    gate: 'requireEmployee. Every punch, timesheet and correction is scoped to the caller\'s own employee id in the query; the write re-checks the punch rule on the POSTED value rather than on the rendered buttons.',
  },
  {
    key: 'weekly-timesheet',
    label: 'Timesheet',
    href: '/portal/employee/timesheet',
    icon: 'calendar',
    group: 'time',
    // DRAWER ONLY. A timesheet is filled in once a week, usually on a Friday, and giving it one of
    // the four thumb slots would push out something people tap every day. NOT a duplicate of the
    // 'timesheet' entry above it: that one opens /portal/employee/attendance, which is where a
    // person CHECKS IN. This is the weekly declaration they submit for approval, which is a
    // different act on a different table.
    bar: null,
    // EXACTLY the page's own gate in the composition's vocabulary. timesheet.astro runs
    // requireEmployee and renders its named denial without one, and all three of these widgets carry
    // withEmployeeRecord - so the entry is true for precisely the accounts the page admits.
    audience: keptAny('attendance.month', 'clock.today', 'timelog.today'),
    gate: 'requireEmployee. Every read and write is scoped to the caller\'s own employee id; approval is routed by src/lib/workflow.ts to the reporting manager from the Organization Graph, and the page has no approve button of its own.',
  },
  {
    key: 'overtime',
    label: 'Overtime',
    href: '/portal/employee/attendance/overtime',
    icon: 'calendar',
    group: 'time',
    // DRAWER ONLY, same reasoning: claiming extra hours is occasional, not daily.
    bar: null,
    audience: keptAny('attendance.month', 'clock.today', 'timelog.today'),
    gate: 'requireEmployee. A claim is checked against the caller\'s OWN punches and shift, routed through src/lib/workflow.ts, and comp off is credited only when the engine says approved. Nothing on the page credits anything.',
  },
  {
    key: 'time-approvals',
    label: 'Approvals waiting on you',
    href: '/portal/employee/attendance/approvals',
    icon: 'checklist',
    group: 'time',
    // DRAWER ONLY. Offered to every employee rather than gated on managing anybody, DELIBERATELY:
    // who approves what is resolved PER ROW from the Organization Graph, not from a capability, so
    // there is no per-user predicate that could answer "is this person an approver" without asking
    // the graph. The page itself is honest when the answer is nobody - it says nothing is waiting on
    // you - and pendingForApprover() returns only what is routed or delegated to the caller, so an
    // employee who approves nothing sees an empty list rather than somebody else's requests.
    bar: null,
    audience: keptAny('attendance.month', 'clock.today', 'timelog.today'),
    gate: 'requireEmployee, then pendingForApprover(user.id) - routed and delegated steps only, never capability holders. decideStep() re-checks routing and mayAct() at the moment of the write, so a posted step id for somebody else\'s queue is refused by the engine.',
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

  {
    // FOCUS AND WELLBEING — a browser-side companion: a focus timer, a breathing pacer, desk
    // exercises, hydration and meal reminders, and a focus streak. It was orphaned: nothing in
    // src/ linked /portal/wellbeing at all.
    //
    // READ THE LABEL CAREFULLY, BECAUSE THE NEAR-MISS MATTERS. This is NOT the wellness programme at
    // /portal/wellness, which is women-only, gated server-side, and whose individual data no admin
    // and no founder may see. Nothing behind this entry reads or writes a health record: everything
    // it does happens in the browser, and the page stores nothing about a person's body. The label
    // says "focus" first for exactly that reason — one word meaning two rooms is the navigation
    // defect this file already fixed once for "Documents".
    //
    // `anyone`, and that is EXACTLY the page's own gate: it redirects a signed-out visitor to the
    // login screen and asks for nothing else. There is no capability to narrow to and nothing a
    // narrower audience would protect.
    key: 'wellbeing',
    label: 'Focus and wellbeing',
    href: '/portal/wellbeing',
    icon: 'grid',
    group: 'workspace',
    // DRAWER ONLY. The bar slots belong to the acts people repeat every day.
    bar: null,
    audience: anyone,
    gate: 'Signed in (wellbeing.astro). Everything on it runs in the browser; there is no query on the page and no row written anywhere. NOT the wellness programme — that is /portal/wellness and it is gated separately in src/lib/wellness.ts.',
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
    key: 'loans',
    label: 'Loans and advances',
    href: '/portal/employee/loans',
    icon: 'book',
    group: 'record',
    // DRAWER ONLY, for the same reason Payslips is: the bar holds four tabs at 360px, and a person
    // opens this when something prompts them to — a repayment showing on a payslip, or needing an
    // advance — not with a thumb between meetings. Taking a tab from Tasks or Messages would be a
    // worse trade than the extra tap.
    bar: null,
    // EXACTLY the page's own gate in the composition's vocabulary. loans.astro resolves an
    // hr_employees row for the signed-in account and renders a named empty state when there is none;
    // loansForEmployee() narrows every row by employee_id, and the POST handler takes the employee id
    // from the SESSION rather than from the form, so there is no id to change in the address bar.
    //
    // NO CAPABILITY HERE, and there must not be one: an employee's account very often carries the
    // `applicant` role, which holds nothing at all, and gating this on a permission would hide a
    // person's own borrowing and their own repayments from them.
    audience: (v) => v.ctx.hasEmployeeRecord,
    gate: 'Signed in, then its own hr_employees lookup. Every read is narrowed by employee_id; requesting and withdrawing both resolve the employee from the session, never from the form.',
  },
  {
    // THE WALLET — where net pay lands, and where a withdrawal to a bank account is raised from.
    //
    // THREE PAGES ALREADY POINT AT IT (payslips, expenses, loans) AND NOTHING OPENED IT DIRECTLY.
    // NAV_BACKLOG `wallet` said this was "a one-line addition when money is wanted in the bar" and
    // left it out rather than adding it silently. It is wanted: the money surfaces around it all end
    // sentences with "open your wallet", so a person who arrived at any of them from the drawer had a
    // door and a person who came looking for their balance first had none.
    //
    // hasEmployeeRecord, and NOT `worksHere` — the narrower of the two, for the same reason 'assets'
    // and 'projects' use it. A wallet is resolved from hr_employees, so an admin account with no
    // employee row would open a page that can only say there is nothing here.
    key: 'wallet',
    label: 'Wallet',
    href: '/portal/employee/wallet',
    icon: 'book',
    group: 'record',
    // DRAWER ONLY. Pay lands monthly; this is not a thumb destination.
    bar: null,
    audience: (v) => v.ctx.hasEmployeeRecord,
    gate: 'Page: signed in, then its own hr_employees lookup (linked account first, then the three email columns). Every balance and every withdrawal row is narrowed by that employee id; a withdrawal is routed through src/lib/workflow.ts and the page approves nothing.',
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
    // FEEDBACK — the STRUCTURED item, which is a different thing from the note on the Performance
    // page above and deliberately has its own door.
    //
    // WHY NOT A FIFTH TAB ON PERFORMANCE. That page is already four tabs deep and its feedback tab
    // owns the lightweight any-to-any note. A structured item is a form with twelve dimensions, an
    // applicable period, a circumstance and REQUIRED evidence; burying it as a tab inside a tab is
    // how a thing nobody can find gets built. Both write to the same table, and neither reads the
    // other as a rating: a note with no dimension rows contributes to no dimension score.
    //
    // `worksHere` rather than a capability, for the same reason Performance uses it. Giving feedback
    // and reading your own record are things every employee does, and gating the door on managing
    // people would hide somebody's own record from them. WHOSE record may be opened is resolved per
    // ROW inside the page by src/lib/horizon/feedback/visibility.ts, which defers to the
    // Organization Graph and fails closed.
    key: 'feedback',
    label: 'Feedback',
    href: '/portal/employee/feedback',
    icon: 'message',
    group: 'record',
    bar: null,
    audience: worksHere,
    gate: 'Page: signed in, then its own employee lookup. Every other-person read goes through src/lib/horizon/feedback/contract.ts, which resolves a view from the Organization Graph per row, redacts by that view, and logs the access against the reader.',
  },
  {
    // YOUR RECORD — the personal intelligence view (Patch 15).
    //
    // ONE READER, AND IT IS THE SUBJECT. The page takes no id: every query behind it is narrowed to
    // the reader's own employee record, and the digital twin is built with this person as both
    // viewer and subject, so it grants on twinAccess's "it is you" arm and never on an HR
    // capability. There is deliberately no manager-facing variant of this route.
    //
    // `worksHere` rather than a capability, for the same reason Performance uses it: this is a
    // person's own record, and gating it on holding something would hide somebody's record from
    // themselves. It is narrower than the page's own gate ("signed in", then resolveEmployeeIdentity
    // renders its own denial in place), which is the direction that is safe — the entry never offers
    // a door the page refuses.
    //
    // DRAWER ONLY. The four ranked bar slots are already spoken for by Home, Tasks, Approvals and
    // Team; this is a surface people open to read and reflect, not a thumb destination.
    key: 'intelligence',
    label: 'Your record',
    href: '/portal/employee/intelligence',
    icon: 'user',
    group: 'record',
    bar: null,
    audience: worksHere,
    gate: 'Page: signed in, then resolveEmployeeIdentity, which renders its denial in place. Every read is narrowed to the reader\'s own employee_id; consent, reflections and correction requests are all keyed by it.',
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
    key: 'directory',
    label: 'Directory',
    href: '/portal/employee/directory',
    icon: 'user',
    group: 'record',
    // DRAWER ONLY, for the same reason Organization is: a reference surface people open when they
    // need it, not a thumb destination worth taking a bar slot from Tasks.
    bar: null,
    //
    // WHY A SECOND PEOPLE SURFACE IS NOT A SECOND ANSWER.
    //
    // Organization draws the reporting TREE and /portal/search matches a NAME across seven sources
    // eight hits at a time. Neither of them is a list somebody can page through, which is the shape
    // the question "who is in my department" actually has once the department is larger than a
    // screen. This is that list — and it asks resolveOrgViewerScope(), the same function BOTH of
    // those use, so all three agree to the row about who this viewer may see. If they ever disagree,
    // the bug is in one of the three pages and never in this entry.
    //
    // `worksHere`, strictly narrower than the page's own gate of "signed in", exactly as
    // Organization is: an applicant does not belong in a staff directory even though the page would
    // give them an honest empty-scope screen if they arrived.
    audience: worksHere,
    gate: 'Page: signed in. Contents: resolveOrgViewerScope(), identical to /portal/organization and the people source of /portal/search. Name, designation, employee code and department only — no contact details, no pay, no identity documents.',
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
    label: 'Security',
    href: '/portal/employee/security',
    icon: 'user',
    group: 'account',
    bar: 14,
    audience: anyone,
    gate: 'Signed in (portal/employee/security.astro). Sign-in methods, the per-account second-step opt-in, and recovery codes — all scoped to the signed-in account and nobody else.',
  },
  {
    key: 'support',
    // RENAMED FROM 'Support', WHICH WAS THE WRONG DOOR WEARING THE OBVIOUS WORD.
    //
    // The note below already said this entry must never be worded as a way to raise a workplace
    // issue — and then it was labelled 'Support', filed under Account, which is the first place
    // somebody looking for help goes. An employee with a payroll problem landed in a paid
    // CANDIDATE-facing application-support queue, and the staff helpdesk one group away was called
    // 'Helpdesk', a word that does not obviously beat 'Support'.
    //
    // The label now names the audience. WCAG 2.2 SC 3.2.6 Consistent Help (A) asks that help appear
    // in a consistent relative order across pages; the deeper fix is that the two labels no longer
    // invert the routing. Copy only — no gate, no query and no schema behind this change.
    label: 'Application support (candidates)',
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
    // RENAMED FROM 'Helpdesk'. This is the door a member of staff with a workplace problem wants,
    // and it now says so in the words somebody in trouble actually reaches for. Its counterpart in
    // the Account group is 'Application support (candidates)', so the two no longer compete for the
    // same reader.
    label: 'Get help (staff)',
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
  },
  {
    key: 'knowledge',
    label: 'Knowledge base',
    href: '/portal/employee/knowledge',
    icon: 'book',
    group: 'work',
    // DRAWER ONLY, and ranked immediately after the helpdesk it deflects for: somebody looking for
    // the answer and somebody about to ask for it are the same person one screen apart.
    bar: 19,
    // `worksHere` — an employee record, or admin.access — which is EXACTLY what the page means by
    // "everyone with a workspace" and exactly what makeViewer() computes as hasWorkspace. An
    // applicant has no workspace and is offered nothing; the page would show them an empty library
    // anyway, and offering it would be a promise it does not keep.
    //
    // DELIBERATELY NOT A CAPABILITY. Reading the handbook needs no permission of its own: the
    // article names its own audience and that is applied in the WHERE clause. Gating the ENTRY on
    // `knowledge.manage` would hide the leave policy from everybody it was written for.
    audience: worksHere,
    gate: 'Page: signed in. Contents: every read goes through visibilityClause() in src/lib/knowledge-base.ts, which narrows to articles for everyone with a workspace plus restricted ones whose named capability this person actually holds. Acknowledging a policy writes the SESSION user id, never a posted one.',
  },
  {
    key: 'projects',
    label: 'My projects',
    href: '/portal/employee/projects',
    icon: 'grid',
    group: 'work',
    bar: 19,
    // hasEmployeeRecord, and NOT `worksHere` — the narrower of the two, for the same reason 'assets'
    // uses it. Project membership is keyed on hr_employees.id, so an admin account with no employee
    // row would open a page that can only say "nothing here". A capability would be wrong in the
    // other direction: projects.view is the ORG-WIDE portfolio, and an employee needs nothing at all
    // to see the projects they are on.
    audience: (v) => v.ctx.hasEmployeeRecord,
    gate: 'Page: requireEmployee, then listProjects() in src/lib/projects.ts, which puts the whole scope in the WHERE clause: the projects this person is a member of, the ones the Organization Graph records them as running, their department\'s if they head one, and everything only for a holder of projects.view. An empty graph renders "Organization Graph not yet initialized" rather than an empty list.',
  }
];

// ---------------------------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT IN THE BAR, and the artefact each one needs first. Recorded here for the
// same reason widgets.ts records UNREGISTERED: so the next person does not spend an afternoon
// rediscovering that a module is missing rather than merely unlinked.
// ---------------------------------------------------------------------------------------------

export const NAV_BACKLOG: readonly { key: string; reason: string }[] = [
  // NOTE FOR ANYONE LOOKING FOR 'projects' HERE: IT HAS SHIPPED, and its entry is in the list above.
  // The finding that used to sit here — "no projects table, no project_id and no projectId anywhere in
  // src/ or db/, employee_tasks has no project relation" — was accurate when it was written and is no
  // longer true of any clause: src/lib/projects.ts carries the register, and employee_tasks.project_id
  // is declared in src/lib/employee-tasks.ts, in the module that owns that table. src/lib/search-global.ts
  // still returns the old honest note for its `projects` source and is a separate module's call to make.
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
      'ANSWERED. This said an entry was "a one-line addition when money is wanted in the bar" and was ' +
      'left out rather than added silently. It is in the list above now, drawer-only, gated on the ' +
      'employee record — because /portal/employee/{payslips,expenses,loans} all end sentences with ' +
      '"open your wallet" while nothing opened it directly, so the balance was reachable only by ' +
      'arriving somewhere else first.',
  },
  {
    key: 'totp-setup.duplicate',
    reason:
      'CLOSED — /portal/totp-setup is now a redirect to /portal/security. It turned out to be worse ' +
      'than a duplicate door: every statement on it wrote `user_totp_secrets`, a table NO sign-in ' +
      'path reads (the real authenticator is `user_totp`, src/lib/auth/twofactor.ts), it activated ' +
      'the factor on any six digits with no RFC 6238 check at all, and it cleared the factor on a ' +
      'bare POST with no current code. So it told people their account was protected by an ' +
      'authenticator while nothing anywhere consulted one. The URL is kept as a redirect rather ' +
      'than deleted because it may still be sitting in an old email, and a 404 on a security link ' +
      'reads as the whole feature having been withdrawn. Authenticator enrolment is done INLINE on ' +
      '/portal/security and /portal/employee/security through TwoFactorPanel, which is the entry ' +
      'the Security destination above already opens.',
  },
  {
    key: 'learner.surfaces',
    reason:
      'NOT A WORKSPACE GAP, AND DELIBERATELY NOT SOLVED HERE. /portal/{achievements, crm, doubts, ' +
      'feed, flashcards, groups, hackathons, jobs, library, notes, parent, resume-builder} are ' +
      'LEARNER surfaces, every one gated on "signed in" and nothing more, and every one of them was ' +
      'orphaned — no nav entry and no link from any reachable page. They are now linked from the ' +
      'footer of /portal/index.astro, which is the learner home, rather than added to this list: an ' +
      'HRIS drawer that already holds ~30 destinations does not need twelve more that an employee ' +
      'will never open, and rule 1 of this file is about what is OFFERED, not only about what is ' +
      'permitted. If a learner navigation module is ever written, it belongs beside this one and not ' +
      'inside it.',
  },
  {
    key: 'visvambhara.loop',
    reason:
      'AN ORPHAN THAT MUST STAY ONE UNTIL A PAGE IS FIXED. /portal/visvambhara:12 carries ' +
      '`if (user.role !== \'applicant\') return Astro.redirect(\'/admin\')` — the same loop shape ' +
      'profile.edit records below, where middleware bounces anyone without admin.access straight ' +
      'back. It is unreachable today, and linking it before that line goes would hand every employee ' +
      'a redirect loop. Same for /portal/requests/index:7 and /portal/wallet:11 (the LEARNER wallet ' +
      'at /portal/wallet, which is not /portal/employee/wallet in the list above). Each is a ' +
      'one-line page fix in a file this pass does not own.',
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
      'took /portal down before. /portal/notifications HAS NOW HAD THAT LINE REMOVED — it gates on ' +
      '"signed in", narrows every read by user_id, and has the notifications entry above pointing at ' +
      'it — so TWO PAGES still carry it with no entry pointing at them: /portal/requests/index:7 and ' +
      '/portal/wallet:11. Each is a one-line page fix, not a module.',
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
  /**
   * HOW MANY THINGS ARE WAITING BEHIND THIS DOOR. Absent when the caller supplied nothing, and
   * absent — never zero — when the number is zero: a bar covered in "0" pills teaches people to
   * stop reading the pills.
   *
   * THIS DOES NOT BREAK RULE 1 OF THIS FILE. The number rides along with a destination the composer
   * ALREADY authorised: an entry that is not in `entries` cannot carry a badge, because it does not
   * exist. Nothing here decides who may see a count — the page that resolved the count decided that
   * when it ran the query, and it passes the figure in through `opts.badges`. This module still
   * performs no read and still cannot widen anything.
   */
  badge?: number;
}

export interface WorkspaceNavigation {
  /** Where Home points for this person. */
  home: string;
  /** Every destination this composition authorises, in bar order then declaration order. */
  entries: readonly NavEntry[];
  /** The ranked destinations that reach the bar: BAR_CAPACITY - 1 of them, because the last slot is
   *  always the More tab. See `hasMore` for why that is unconditional. */
  bar: readonly NavEntry[];
  /** The full list, grouped, for the drawer. Empty groups are absent, never rendered as a heading. */
  drawer: readonly { group: NavGroup; label: string; entries: readonly NavEntry[] }[];
  /**
   * Is a More tab needed at all?
   *
   * ALWAYS TRUE SINCE THE ACCOUNT CONTROL SHIPPED, and that is a fact about what the drawer holds
   * rather than a shortcut. The drawer now carries "you are signed in as ..." and the sign-out
   * button, and neither of those can ever take a bar slot: a tab bar is a row of links, and a
   * sign-out has to be a POST. So there is always something behind the More tab, which is precisely
   * what this field means — it did not change meaning, the contents changed.
   *
   * WHY IT MATTERS THAT IT IS UNCONDITIONAL. The old value was `ranked.length > BAR_CAPACITY`, so a
   * DEGRADED composition — four surviving entries — produced no More tab and therefore no drawer at
   * all. That is the exact moment a person most needs to end their session and hand the phone back,
   * and it was the one render in which the control would not have existed.
   */
  hasMore: boolean;
  /** The key of the entry the reader is currently on, resolved from the path when not passed. */
  active: string;
  /** True when the composition was degraded — the caller should say so rather than imply this is all there is. */
  degraded: boolean;
  /**
   * WHAT THE MORE TAB IS HIDING. The sum of every badge on an authorised entry that did NOT reach
   * the bar, so a count behind the drawer is still visible from the outside. Zero when there is
   * nothing, and the renderer must show nothing at zero.
   *
   * Without this the whole badge mechanism is decorative for the people it matters to: 'approvals'
   * is rank 4 and three ranked entries reach the bar, so a manager's pending queue lives in the
   * drawer, and a count you have to open a menu to discover is a count nobody discovers.
   */
  moreBadge: number;
}

export interface BuildNavOptions {
  /** The key of the current destination. When absent it is resolved from `pathname`. */
  active?: string;
  /** Astro.url.pathname. Used only to light the tab the person is already on. */
  pathname?: string;
  /**
   * HOW MANY THINGS ARE WAITING, BY DESTINATION KEY — for example `{ approvals: 3, notifications: 7 }`.
   *
   * SUPPLIED BY THE PAGE, NEVER RESOLVED HERE. The caller has already run the query and already
   * scoped it; this module only projects the figure onto a door it had independently decided to
   * offer. A key naming a destination this composition does NOT authorise is DISCARDED rather than
   * rendered, so a stale or over-generous badge map cannot leak the existence of a surface — that
   * is the same fail-closed direction every other decision in this file takes.
   *
   * Anything that is not a finite number greater than zero is dropped. A NaN from a failed count
   * would otherwise render as a pill reading "NaN" on the most-looked-at element on the phone.
   */
  badges?: Record<string, number>;
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
    // The badge is attached ONLY here, inside the branch that has already decided this person may be
    // offered the destination. A key in `opts.badges` naming an entry that did not survive the
    // audience test never reaches this line, so it is discarded rather than rendered.
    const badge = badgeFor(opts.badges, d.key);
    entries.push({
      key: d.key,
      label: d.label,
      href: d.key === 'home' ? home : d.href,
      icon: d.icon,
      group: d.group,
      ...(badge > 0 ? { badge } : {}),
    });
  }

  // Bar order is the `bar` rank; anything unranked never reaches the bar.
  const rankOf = new Map<string, number>(
    NAV_DESTINATIONS.map((d) => [d.key, d.bar === null ? Number.MAX_SAFE_INTEGER : d.bar]),
  );
  const ranked = entries
    .filter((e) => (rankOf.get(e.key) ?? Number.MAX_SAFE_INTEGER) < Number.MAX_SAFE_INTEGER)
    .sort((a, b) => (rankOf.get(a.key) as number) - (rankOf.get(b.key) as number));

  // THE DRAWER ALWAYS EXISTS, so the last bar slot is ALWAYS the More tab.
  //
  // This used to be `ranked.length > BAR_CAPACITY`, which gave a person with four or fewer
  // destinations a full bar and no drawer. That was fine while the drawer held only overflow links.
  // It stopped being fine the moment the drawer became the only place carrying "signed in as ..."
  // and the sign-out button: on a degraded composition exactly four entries survive, so the bar
  // filled, the More tab vanished, and there was no way to end the session on that render — the one
  // render where somebody is most likely to want to.
  //
  // The cost is one ranked destination moving from the bar into the drawer for those people. That is
  // one extra tap on a link. The thing it buys is a sign-out that is present on every single render,
  // which is the whole point of this control existing.
  const hasMore = true;
  const bar: NavEntry[] = ranked.slice(0, BAR_CAPACITY - 1);

  const drawer: { group: NavGroup; label: string; entries: NavEntry[] }[] = [];
  for (const g of NAV_GROUP_LABELS) {
    const inGroup = entries.filter((e) => e.group === g.group);
    if (inGroup.length > 0) drawer.push({ group: g.group, label: g.label, entries: inGroup });
  }

  // What the More tab is hiding: every badge on an authorised entry that did not take a bar slot.
  // Summed over `entries` rather than over `opts.badges`, so an unauthorised key still cannot move
  // the number — the count on the tab and the rows behind it are computed from one list.
  const inBar = new Set<string>(bar.map((e) => e.key));
  const moreBadge = entries.reduce(
    (total, e) => (inBar.has(e.key) ? total : total + (e.badge || 0)),
    0,
  );

  return {
    home,
    entries,
    bar,
    drawer,
    hasMore,
    active: resolveActive(entries, opts),
    degraded: composed.degraded === true || composed.ok !== true,
    moreBadge,
  };
}

/**
 * One badge, sanitised.
 *
 * Anything that is not a finite number above zero comes back as 0 and is then dropped by the caller.
 * That covers the three shapes a count actually arrives in when something upstream went wrong — NaN
 * from a `Number(undefined)`, a negative from a subtraction, and a string from a raw pg row — none of
 * which should ever be painted onto the most-looked-at element on the phone. Capped at 99 for the
 * same reason the renderer shows "99+": a four-digit pill widens a 90px tab and that is the one way
 * a tab bar makes the page scroll sideways at 360px.
 */
function badgeFor(badges: Record<string, number> | undefined, key: string): number {
  if (!badges) return 0;
  const raw = Number(badges[key]);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), 99);
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
