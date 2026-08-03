// src/lib/workforce/widgets.ts — THE WIDGET REGISTRY. Data, not code.
//
// THE DEFECT THIS FIXES. /portal/employee is an INTERN portal that every authenticated account
// receives. It leads with credit hours, attendance percentage, days in, clock in and leave. Those
// are internship concepts. A founder, a CEO, a professor, an engineer and a volunteer all sign in
// and are shown a credit-hours progress bar measuring them against a requirement that was never
// recorded for them. The bar is not wrong for an intern — it is the correct screen for an intern,
// and it stays. What was wrong is that ONE page decided what everyone sees.
//
// SO THIS FILE HOLDS WHAT EACH WIDGET NEEDS, AND src/lib/workforce/composer.ts DECIDES WHO GETS IT.
// A widget definition is a plain object: no queries, no components, no roles, no branching. It
// declares the CONTEXT under which it makes sense — permissions held, employment engagement,
// department scope, whether the person manages anyone, whether they can decide an approval — and
// the composer answers that question once per request against the real gates.
//
// FIVE RULES, AND EVERY ONE OF THEM IS LOAD-BEARING.
//
//   1. NO ROLE NAME APPEARS IN THIS FILE, and none may be added. `WorkspaceContext` deliberately
//      does not carry `role`, so a predicate CANNOT test one. Roles map to capability exactly once,
//      in the composer, using the same tests the writers enforce (hr-leave, hr-wallet,
//      workspace-access). Adding a workforce category — a new department, a new engagement type, a
//      new custom role — must require no edit here. If it does, this file has a bug.
//
//   2. A WIDGET IS REGISTERED ONLY IF ITS DATA SOURCE EXISTS TODAY, and `dataSource` names the
//      table or the function, not a hope. Verified against src/lib/db/schema.ts and against the
//      code that WRITES each column — never against db/hr-schema.sql, which describes tables that do
//      not exist in that form. Five production 500s this week came from querying a column that
//      existed only in someone's mental model (hr_employees.work_email, hr_task_log,
//      meet_rooms.scheduled_at, users.identity_verified, users.full_name). What is not registered is
//      recorded in UNREGISTERED at the bottom of this file with the reason, so the next person does
//      not have to rediscover it.
//
//   3. INTERN WIDGETS ARE NOT DELETED. credit.position, credit.weeksLeft and completion.status carry
//      an audience predicate that is true only for an internship engagement, plus a gate that
//      requires an actual recorded requirement. They keep working, for interns, and they disappear
//      for everybody else. That is the whole change.
//
//   4. ELIGIBILITY IS NOT CONTENT. This registry decides whether a widget MAY appear. Whether it has
//      anything to say is the loader's answer, and `hideWhenEmpty` records which widgets should
//      vanish rather than render a zero. A screen of zeroes is the same failure as the credit bar:
//      it fills a senior person's workspace with facts about somebody else's job.
//
//   5. AN EMPTY BUCKET AND A FAILED READ ARE DIFFERENT SENTENCES. Every loader built against this
//      registry must report whether its read HAPPENED, the way myTasksView() and listBoard() already
//      do with `ok`. "Nothing is waiting on you" printed over a query that threw is the same lie as
//      a green flash over a write that never landed, and this codebase has been punished for it.
//
// This module imports NOTHING that opens a database connection. It is pure data and pure predicates,
// so it can be read, diffed and tested without a database or a request.

// ---------------------------------------------------------------------------------------------
// The context a widget may ask about.
// ---------------------------------------------------------------------------------------------

/**
 * How this person is engaged, which is the ONE distinction this whole exercise turns on.
 *
 * 'unknown' is not a synonym for 'employment'. It means no employee record resolved — the ordinary
 * state for a founder or an HR account that has no hr_employees row — and every predicate below
 * treats it as "do not show the engagement-specific thing", which is the safe direction.
 */
export type Engagement = 'internship' | 'employment' | 'unknown';

/** The bands a workspace is laid out in. Order here is the order a page should render groups in. */
export type WidgetGroup =
  | 'attention'
  | 'work'
  | 'approvals'
  | 'time'
  | 'internship'
  | 'money'
  | 'people'
  | 'growth'
  | 'hiring'
  | 'community'
  | 'account';

export const WIDGET_GROUPS: readonly WidgetGroup[] = [
  'attention', 'work', 'approvals', 'time', 'internship',
  'money', 'people', 'growth', 'hiring', 'community', 'account',
];

/** Human labels, so a page does not hand-type them and drift. */
export const WIDGET_GROUP_LABELS: readonly { group: WidgetGroup; label: string }[] = [
  { group: 'attention', label: 'Needs you' },
  { group: 'work', label: 'Work' },
  { group: 'approvals', label: 'Waiting on your decision' },
  { group: 'time', label: 'Your day' },
  { group: 'internship', label: 'Your internship' },
  { group: 'money', label: 'Money' },
  { group: 'people', label: 'People' },
  { group: 'growth', label: 'Your record' },
  { group: 'hiring', label: 'Hiring' },
  { group: 'community', label: 'Community' },
  { group: 'account', label: 'Account' },
];

/** Column span at the page's discretion. 'full' means it owns its row, at every width. */
export type WidgetSize = 'sm' | 'md' | 'lg' | 'full';

/**
 * WHICH RENDERER draws it. A name, not a component import: this file must stay free of anything
 * that pulls Astro, the database or the DOM into a module the composer imports on every request.
 * The page maps these to real components; `component` below names the existing workforce component
 * where one already fits.
 */
export type WidgetRender =
  | 'triage-list'   // glyph + title + note rows, ranked by urgency
  | 'task-list'     // TaskCard rows
  | 'stat'          // one figure and its label
  | 'stat-row'      // a few related figures
  | 'progress'      // a figure against a recorded target
  | 'list'          // plain rows
  | 'timeline'      // Timeline entries
  | 'identity'      // who you are, as recorded
  | 'form'          // a control that writes (clock, report, hour block)
  | 'link';         // a door, and no data at all

/**
 * A check that must NOT run for everyone, so it cannot live in the synchronous audience predicate.
 * The composer resolves each distinct gate at most once per request, and only for widgets that have
 * already passed `requires` and `audience` — so nothing is read on behalf of a person who was never
 * going to see the widget anyway. A gate that throws DROPS its widget.
 */
export type WidgetGate =
  /** src/lib/wellness.ts canAccessWellness(). Reads eligibility and returns a boolean and a reason —
   *  never a health record, never a row per user. It is the only sanctioned test, and it is here
   *  rather than in `audience` precisely so it is not run against every person who signs in. */
  | 'wellness-eligible'
  /** src/lib/credit-ledger.ts termsFor(). True only when a credit-hour requirement is actually
   *  recorded on the person's row. This is what stops a progress bar rendering against a target
   *  nobody agreed to — including for the "Internal Auditor" whose designation merely contains the
   *  letters i-n-t-e-r-n (a known flaw shared with intern-guard.ts:48, which fails toward MORE
   *  restriction there and would fail toward a wrong progress bar here). */
  | 'engagement-terms';

/** One admin section plus the action on it, answered by canAccessSection() in permissions.ts. */
export interface SectionRequirement {
  /** A key from src/lib/admin-sections.ts, e.g. 'employees', 'payroll'. */
  key: string;
  action: 'view' | 'edit' | 'delete' | 'export';
}

/**
 * Everything a widget is allowed to know about the person, resolved ONCE per request by the
 * composer. Every field is a fact about capability or engagement. There is no role, no email, no
 * name, no gender, no salary and no identifier belonging to anybody else.
 */
export interface WorkspaceContext {
  /** users.id. Collaborator rights, notifications, groups, offline work and the task board are all
   *  keyed by this. */
  userId: string;
  /** hr_employees.id, or null when no employee record is linked to this account. EVERY hr_* table
   *  is keyed by this and never by users.id; handing the wrong one to a reader returns an empty
   *  result forever rather than an error. */
  employeeId: string | null;
  hasEmployeeRecord: boolean;
  engagement: Engagement;
  /** The person's OWN department (hr_employees.department_id). Display and self-scope only; it
   *  never grants the right to see anyone else. Null is the ordinary case — the column has exactly
   *  one writer (src/lib/hr/sync.ts), so anyone HR added by hand has none. */
  departmentId: string | null;
  departmentName: string | null;
  /** The department a lead may QUERY (users.assigned_department_id). Null for everyone else. This,
   *  and only this, is what makes a team widget legitimate. */
  scopeDepartmentId: string | null;
  /** Active employees naming this account as their reporting manager. 0 when the count could not be
   *  read — see contextGaps on the composed result before saying "you manage nobody". */
  directReports: number;
  /** Has people to look after: direct reports, or a department scope. */
  managesPeople: boolean;
  /** Can decide a leave request or a withdrawal — the same authority hr-leave.ts and hr-wallet.ts
   *  enforce at the write, so a widget shown here always has rows to act on at /portal/approvals. */
  approvesRequests: boolean;
  /** Wildcard-aware membership of the resolved permission set. Use this, never `permissions.has()`:
   *  a super_admin holds '*' and would answer false to a bare .has('users.edit'). */
  holds: (key: string) => boolean;
  /** The raw resolved set, for a permissions widget that wants to LIST them. Read-only. */
  permissions: ReadonlySet<string>;
  /** Section grants resolved for this request, as 'key:action'. Only pairs the registry asked for
   *  are present; use grantedSection() rather than reading the set directly. */
  sections: ReadonlySet<string>;
  grantedSection: (key: string, action: SectionRequirement['action']) => boolean;
  /**
   * TODAY, AS THE DATABASE COUNTS IT — 'YYYY-MM-DD', or null when that read did not happen.
   *
   * Six widgets partition on "today" (tasks.dueToday, clock.today, timelog.today,
   * dailyreport.today, worklog.today, schedule.today) and due_on is compared against CURRENT_DATE
   * inside Postgres. A second surface computing `new Date()` in the render process disagrees with
   * the first by a day whenever the process timezone and the session timezone differ, and "due
   * today" is exactly the claim that must not be off by one. Resolved ONCE here so every widget
   * partitions on the same day.
   *
   * NULL IS NOT "TODAY IS UNKNOWABLE, GUESS" — it is "do not render a day-partitioned claim".
   */
  today: string | null;
  /**
   * users.id of the person this account reports to, off the viewer's OWN row. Null when none is
   * recorded, when there is no employee record, or when the read did not happen.
   *
   * THE ID-SPACE TRAP, stated where the value lives: hr_employees.reporting_manager_id holds a
   * USERS id, not an hr_employees id. A loader naming this field must join `m.user_id`, never
   * `m.id` — the wrong join matches zero rows and reads as "not recorded" rather than failing.
   */
  reportingManagerUserId: string | null;
}

/**
 * A DOOR WITH A VERB ON IT — "what can this person DO right now", declared beside the widget that
 * grants it rather than in a second hand-written list.
 *
 * WHY IT LIVES HERE AND NOT ON THE PAGE. /portal/index.astro:416 and BottomNav.astro:115 each keep
 * a static array of links with no capability test at all, so every tab renders for everyone
 * whatever the composer resolved. A third copy on the workspace would be the same defect again.
 * Because a quick action hangs off a WidgetDefinition, it is eligible exactly when its widget is:
 * the composer filters once, and the action list falls out of the answer it already gave.
 */
export interface WidgetQuickAction {
  /** Imperative and true at every moment — the label is not recomputed from live state. */
  label: string;
  /** Where the thumb lands. An in-page anchor is legitimate when the control IS on the workspace. */
  href: string;
  icon: QuickActionIcon;
}

/** Named monochrome glyphs the surface maps to inline SVG. NO EMOJI, anywhere, ever. */
export type QuickActionIcon =
  | 'clock' | 'note' | 'timer' | 'check' | 'calendar'
  | 'stamp' | 'wallet' | 'people' | 'doc' | 'person';

export const QUICK_ACTION_ICONS: readonly QuickActionIcon[] = [
  'clock', 'note', 'timer', 'check', 'calendar', 'stamp', 'wallet', 'people', 'doc', 'person',
];

/** A predicate over the context. Pure, synchronous, no database, and it must not throw. */
export type WidgetAudience = (ctx: WorkspaceContext) => boolean;

export interface WidgetDefinition {
  /** Stable identifier. Never renamed — pages, tests and any future per-person layout store it. */
  key: string;
  title: string;
  group: WidgetGroup;
  /**
   * The table, or the function that owns the table, this widget reads. Verified against
   * src/lib/db/schema.ts and the code that writes the columns. If you cannot name it here without
   * a hedge, the widget does not belong in this registry yet.
   */
  dataSource: string;
  /** Permission keys, resolved through src/lib/auth/registry.ts. ALL must be held. Empty means the
   *  widget needs no permission — which is most of them, because most read the person's own rows. */
  requires: readonly string[];
  /** Admin section grants, answered by canAccessSection(). ALL must be granted. */
  requiresSection?: readonly SectionRequirement[];
  audience: WidgetAudience;
  /** An asynchronous check the composer runs only for survivors. */
  gate?: WidgetGate;
  /** Lower renders first. Bands are documented at PRIORITY below. */
  priority: number;
  size: WidgetSize;
  render: WidgetRender;
  /** An existing component in src/components/workforce, where one already fits. */
  component?: string;
  /** The full surface behind this widget. NULL means there is no page to send them to — either the
   *  widget is the whole thing, or the door is shut and linking would bounce them. */
  href: string | null;
  /** The verb form of this widget, for the quick-action row. Absent means there is nothing to DO
   *  here — a card that only reports (a balance, a roster, a manager's name) has no action, and
   *  inventing one would send someone to a screen that cannot answer them. */
  quickAction?: WidgetQuickAction;
  /** Render nothing at all when the loader comes back empty, rather than a zero. */
  hideWhenEmpty?: boolean;
  /** Shown when the context could not be resolved. See MINIMAL_WIDGETS. */
  minimal?: boolean;
  /** What the next person needs to know before building the loader: the trap, the caveat, or the
   *  reason this is narrower than it looks. */
  notes?: string;
}

// ---------------------------------------------------------------------------------------------
// Predicates. Named, composable, and the only vocabulary a widget speaks.
// ---------------------------------------------------------------------------------------------

/** Any signed-in person. The composer never calls a predicate without a user. */
const anyone: WidgetAudience = () => true;
const withEmployeeRecord: WidgetAudience = (c) => c.hasEmployeeRecord;
const internshipOnly: WidgetAudience = (c) => c.engagement === 'internship';
const leadsADepartment: WidgetAudience = (c) => !!c.scopeDepartmentId;
const managesPeople: WidgetAudience = (c) => c.managesPeople;
const decidesApprovals: WidgetAudience = (c) => c.approvesRequests;
/** Compose two facts when a widget needs both. Kept because the alternative — inlining `&&` into a
 *  definition — is where a role test would eventually be smuggled in. */
export const and = (a: WidgetAudience, b: WidgetAudience): WidgetAudience => (c) => a(c) && b(c);

/**
 * "Holds every permission there is."
 *
 * Declared here as a literal so this file stays free of src/lib/auth/registry.ts (which imports the
 * database). composer.ts asserts at COMPILE TIME that this still equals registry.WILDCARD, so a
 * rename over there fails the build instead of silently granting nothing here.
 *
 * Used for exactly one widget, whose destination page admits exactly the accounts that hold it.
 * Expressing the door as a capability rather than a role name is the point: the rule stays true if
 * the role is ever renamed, and no role string enters this file.
 */
export const HOLDS_EVERY_PERMISSION = '*';

// ---------------------------------------------------------------------------------------------
// PRIORITY bands. Lower is earlier. Gaps are deliberate: a new widget slots in without renumbering
// its neighbours, and a renumber is a diff nobody can review.
//
//    10- 99  what needs you today
//   100-199  your work
//   200-299  decisions waiting on you
//   300-399  your day: clock, hours, reports, leave
//   400-499  internship progress            (internship engagement only)
//   500-599  money
//   600-699  people you are responsible for
//   700-799  your record: goals, probation, reviews
//   800-899  hiring
//   900-949  community
//   950-999  account and system
// ---------------------------------------------------------------------------------------------

export const WIDGETS: readonly WidgetDefinition[] = [
  // ------------------------------------------------------------------ attention
  {
    key: 'welcome.banner',
    title: 'Welcome',
    group: 'attention',
    dataSource:
      'THE COMPOSED CONTEXT ITSELF — WorkspaceContext plus the Workspace resolveWorkspace() already ' +
      'returned (identity, designation, department, engagement). NO QUERY OF ITS OWN.',
    requires: [],
    audience: anyone,
    priority: 5,
    size: 'full',
    render: 'identity',
    href: null,
    minimal: true,
    notes:
      'IN MINIMAL_WIDGETS, and that is the point: it needs nothing but the session, so a workspace ' +
      'whose context could NOT be resolved still opens with a name and a sentence instead of a blank ' +
      'screen. It states only what was actually read — no greeting invented from a clock the database ' +
      'did not supply, and no department when ctx.departmentId is null. users has `name`, NOT ' +
      'full_name. Never render a role name here: the context carries none, deliberately.',
  },
  {
    key: 'attention.queue',
    title: 'What needs you today',
    group: 'attention',
    dataSource:
      'Composed, read-only: myTasksView() + listBoard() (src/lib/employee-tasks.ts), ' +
      'pendingLeaveForApprover() (src/lib/hr-leave.ts), pendingWithdrawalsForApprover() ' +
      '(src/lib/hr-wallet.ts), listDocs() (src/lib/hr-onboarding.ts).',
    requires: [],
    audience: anyone,
    priority: 10,
    size: 'full',
    render: 'triage-list',
    href: null,
    notes:
      'Every source reports whether it RAN. If any did not, the headline total must be withheld and ' +
      'the gap named — "nothing is waiting on you" is a claim this card is not in a position to make ' +
      'over a failed read. Deliberately NOT in MINIMAL_WIDGETS: it aggregates sources whose scoping ' +
      'depends on the very context that failed to resolve.',
  },
  {
    key: 'notifications.unread',
    title: 'Unread notifications',
    group: 'attention',
    dataSource: 'notifications WHERE user_id = self AND is_read = false (table created by src/lib/push.ts:110).',
    requires: [],
    audience: anyone,
    priority: 20,
    size: 'md',
    render: 'list',
    href: null,
    hideWhenEmpty: true,
    minimal: true,
    notes:
      'href is null ON PURPOSE. /portal/notifications.astro:8 redirects every non-applicant to /admin, ' +
      'so an employee has no portal inbox to link to even though rows ARE written for them ' +
      '(KNOWN_GAPS.md). Render each row against its own notifications.action_url instead, and set an ' +
      'href here only once that door is opened.',
  },
  {
    key: 'schedule.today',
    title: 'Today',
    group: 'attention',
    dataSource:
      'ASSEMBLED FROM ROWS THAT ALREADY EXIST, and from nothing else: the due-today partition of ' +
      'myTasksView(employeeId) against ctx.today, approved hr_leave_request rows covering ctx.today ' +
      'via listLeave({ employeeId }) (src/lib/hr-leave.ts:75), and the first punch of the day from ' +
      'the clock.today read. No table is invented and no second query is added.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 30,
    size: 'full',
    render: 'list',
    href: '/portal/tasks',
    notes:
      'THIS IS NOT A CALENDAR AND MUST NEVER BE TITLED AS ONE. There is no shift, roster, ' +
      'work_schedule, holiday or staff-meeting table anywhere in src/ or db/ — meetings.today stays ' +
      'UNREGISTERED below with the evidence, meet_rooms.scheduled_at is written by nothing, and ' +
      'src/lib/calendar.ts is the LEARNER deadline feed. So this widget shows the day someone ' +
      'already has on record and says plainly, once, that scheduled meetings are not part of it. ' +
      'Rendering an empty "no meetings today" would claim a calendar was consulted. ' +
      'PARTITION ON ctx.today, never on the render process clock: when ctx.today is null the ' +
      'day-partitioned rows are withheld rather than guessed.',
  },

  // ------------------------------------------------------------------ work
  {
    key: 'tasks.mine',
    title: 'My tasks',
    group: 'work',
    dataSource: 'myTasksView(employeeId) -> employee_tasks (src/lib/employee-tasks.ts:992).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 100,
    size: 'lg',
    render: 'task-list',
    component: 'src/components/workforce/TaskCard.astro',
    href: '/portal/tasks',
    quickAction: { label: 'My tasks', href: '/portal/tasks', icon: 'check' },
    notes:
      'Takes hr_employees.id, NOT users.id. myTasksView rather than listMyTasks + taskCounts because ' +
      'it reports whether the read happened; the other two return [] and zeroes either way.',
  },
  {
    key: 'tasks.dueToday',
    title: 'Due today',
    group: 'work',
    dataSource: 'myTasksView(employeeId), partitioned against SELECT CURRENT_DATE from Postgres.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 110,
    size: 'md',
    render: 'task-list',
    component: 'src/components/workforce/TaskCard.astro',
    href: '/portal/tasks',
    hideWhenEmpty: true,
    notes:
      'Compare against the DATABASE\'s today, never the render process\'s. due_on is evaluated against ' +
      'CURRENT_DATE in Postgres, and the two disagree by a day whenever the timezones differ. If that ' +
      'one-column read fails, render nothing rather than guessing.',
  },
  {
    key: 'tasks.blocked',
    title: 'Blocked',
    group: 'work',
    dataSource: "employee_tasks status='blocked' with blocked_reason, via myTasksView(employeeId).",
    requires: [],
    audience: withEmployeeRecord,
    priority: 120,
    size: 'md',
    render: 'task-list',
    component: 'src/components/workforce/TaskCard.astro',
    href: '/portal/tasks',
    hideWhenEmpty: true,
    notes: 'blocked is a first-class state with real transition edges and a required reason. Show the reason.',
  },
  {
    key: 'tasks.signoff',
    title: 'Waiting for your sign-off',
    group: 'work',
    dataSource:
      "listBoard(userId) (src/lib/employee-tasks.ts:1464), status='under_review' where viewerRoles " +
      "holds approver or lead. Roles are resolved per row IN SQL.",
    requires: [],
    audience: anyone,
    priority: 130,
    size: 'md',
    render: 'task-list',
    component: 'src/components/workforce/TaskCard.astro',
    href: '/portal/tasks',
    hideWhenEmpty: true,
    notes:
      'Takes users.id, NOT hr_employees.id — collaborators are keyed by users.id. Deliberately open to ' +
      'anyone signed in: a senior reviewer with no hr_employees row still holds approver rights, and ' +
      'this is often the only work widget they should see.',
  },
  {
    key: 'tasks.review',
    title: 'Waiting for your review',
    group: 'work',
    dataSource: "listBoard(userId), status='under_review' where viewerRoles holds reviewer.",
    requires: [],
    audience: anyone,
    priority: 140,
    size: 'md',
    render: 'task-list',
    component: 'src/components/workforce/TaskCard.astro',
    href: '/portal/tasks',
    hideWhenEmpty: true,
    notes:
      'Count a task as sign-off OR review, never both, or somebody holding both roles sees it twice. ' +
      "An empty bucket is the ordinary state: seedCollaborators creates 'assignee' and 'approver' only, " +
      'so reviewers exist only where someone added one by hand.',
  },
  {
    key: 'tasks.assignedByMe',
    title: 'Work you assigned',
    group: 'work',
    dataSource: "listBoard(userId) where viewerRoles holds 'assigner' (employee_tasks.assigned_by_user_id).",
    requires: [],
    audience: anyone,
    priority: 150,
    size: 'md',
    render: 'task-list',
    component: 'src/components/workforce/TaskCard.astro',
    href: '/portal/tasks',
    hideWhenEmpty: true,
    notes:
      'NO LONGER STRUCTURALLY EMPTY. This note said createTask() had zero callers, so nothing in the ' +
      'application could create a task; that stopped being true at commit 98ef5e3, which added the ' +
      'assign form at src/pages/portal/tasks/index.astro:424. Rows can now exist. It stays ' +
      'hideWhenEmpty because most people assign nothing, and the wording stays "nothing yet" rather ' +
      'than "you have assigned nothing" — the second is a judgement.',
  },
  {
    key: 'tasks.team',
    title: 'Your department\'s work',
    group: 'work',
    dataSource: 'listTasksForTeam(departmentId) (src/lib/employee-tasks.ts:1016).',
    requires: [],
    audience: leadsADepartment,
    priority: 160,
    size: 'lg',
    render: 'task-list',
    component: 'src/components/workforce/TaskCard.astro',
    href: '/portal/team',
    notes:
      'listTasksForTeam takes a department id and applies NO viewer gate of its own, so it may only ever ' +
      'be handed ctx.scopeDepartmentId — which comes from the session (users.assigned_department_id) and ' +
      'never from a query string. Render DEPARTMENT_COVERAGE_NOTICE beside it: hr_employees.department_id ' +
      'has one writer, so a hand-created record is invisible here and a short list reads as a complete one.',
  },
  {
    key: 'tasks.activity',
    title: 'Recent activity on your tasks',
    group: 'work',
    dataSource:
      "listTaskActivity(taskId, userId) (src/lib/employee-tasks.ts:1418) -> audit_log WHERE " +
      "entity='employee_task', visibility re-derived in SQL.",
    requires: [],
    audience: anyone,
    priority: 170,
    size: 'md',
    render: 'timeline',
    component: 'src/components/workforce/Timeline.astro',
    href: null,
    hideWhenEmpty: true,
    notes:
      'PER TASK, so the loader must cap this hard — call it only for the handful of tasks already on the ' +
      'board it just read, never for the whole board. There is no cross-task activity reader today, and ' +
      'inventing one means exporting visibleToSql() from employee-tasks.ts, which is a separate change.',
  },

  // ------------------------------------------------------------------ approvals
  {
    key: 'approvals.leave',
    title: 'Leave requests to decide',
    group: 'approvals',
    dataSource: 'pendingLeaveForApprover(user) -> hr_leave_request (src/lib/hr-leave.ts:99).',
    requires: [],
    audience: decidesApprovals,
    priority: 200,
    size: 'md',
    render: 'list',
    href: '/portal/approvals',
    quickAction: { label: 'Decide requests', href: '/portal/approvals', icon: 'stamp' },
    hideWhenEmpty: true,
    notes:
      'Exclude the viewer\'s OWN pending rows: your request is not an approval waiting on you. The reader ' +
      'shows everything to super_admin/admin/hr and, to everyone else, only employees whose ' +
      'reporting_manager_id is their own USERS id — which is why a reporting manager sees this at all. ' +
      'decideLeave() re-checks authority at the write; a list is not an authorisation.',
  },
  {
    key: 'approvals.withdrawal',
    title: 'Withdrawals to decide',
    group: 'approvals',
    dataSource: 'pendingWithdrawalsForApprover(user) -> hr_withdrawal (src/lib/hr-wallet.ts:158).',
    requires: [],
    audience: decidesApprovals,
    priority: 210,
    size: 'md',
    render: 'list',
    href: '/portal/approvals',
    hideWhenEmpty: true,
    notes:
      'Money already earned, waiting to be released. Counts and names only — the admin reader returns ' +
      'account_number, ifsc and upi_id UNMASKED (hr-wallet.ts:136), and none of that belongs in the ' +
      'render context of a workspace card.',
  },
  {
    key: 'onboarding.review',
    title: 'Joining documents to review',
    group: 'approvals',
    dataSource:
      "COUNT over hr_onboarding_documents WHERE status='submitted' AND user_id <> self " +
      '(table owned by src/lib/hr-onboarding.ts:41).',
    requires: ['admin.access'],
    requiresSection: [{ key: 'employees', action: 'edit' }],
    audience: anyone,
    priority: 220,
    size: 'sm',
    render: 'stat',
    href: '/admin/hr/onboarding',
    hideWhenEmpty: true,
    notes:
      "The section grant is the same test /api/portal/onboarding/documents uses to authorise the review. " +
      "admin.access is required ALONGSIDE it because canAccessSection() can return true for a custom role " +
      "that does not hold admin.access, and middleware.ts bounces exactly that role off /admin — a count " +
      "whose only route to action is a redirect is worse than no count. A COUNT, not pendingForReview(), " +
      "which returns names and email addresses for up to 150 people.",
  },

  // ------------------------------------------------------------------ time
  {
    key: 'clock.today',
    title: 'Today\'s clock',
    group: 'time',
    dataSource:
      'hr_clock_events for CURRENT_DATE + hr_attendance for today (written by ' +
      'src/pages/portal/employee.astro:159-179).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 300,
    size: 'md',
    render: 'form',
    href: null,
    // An in-page anchor, because the control IS on the workspace — the punch forms are driven by
    // element ids (submitClock('clockForm')) and a second copy elsewhere would give two elements the
    // same id and break the punch that already works. The label is state-free on purpose: "Clock in"
    // rendered for somebody already clocked in is a lie the quick-action row cannot detect, and this
    // label is correct at every moment of the day.
    quickAction: { label: 'Clock in or out', href: '#attendance', icon: 'clock' },
    notes:
      'A FAILED PUNCH READ LOOKS EXACTLY LIKE "clocked out, 0h", so the loader must carry a read-failed ' +
      'flag and the card must say "we could not read your punches" rather than stating somebody\'s day as ' +
      'a fact. Both attendance writes are .catch(() => {}) today, so a green flash proves nothing. Hours ' +
      'are wall-clock from the first punch: breaks are recorded and subtracted from nothing.',
  },
  {
    key: 'timelog.today',
    title: 'Hours logged today',
    group: 'time',
    dataSource: 'hr_time_logs WHERE employee_id = self AND log_date = today.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 310,
    size: 'md',
    render: 'form',
    href: '/portal/workspace',
    quickAction: { label: 'Log hours', href: '#time-log', icon: 'timer' },
    notes:
      'start_time and end_time are TEXT and order lexicographically, which is correct only for zero-padded ' +
      'HH:MM. There is no admin writer or editor: the portal copy telling people to "ask HR" for older ' +
      'entries points at a route that does not exist in code.',
  },
  {
    key: 'dailyreport.today',
    title: 'Today\'s report',
    group: 'time',
    dataSource: 'hr_daily_reports WHERE employee_id = self AND report_date = today.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 320,
    size: 'md',
    render: 'form',
    href: null,
    quickAction: { label: "Write today's report", href: '#daily-report', icon: 'note' },
    notes:
      'One writer, five readers including three admin surfaces — so what is typed here genuinely reaches ' +
      'someone, unlike worklog.today. The table has no runtime DDL anywhere in src/ ' +
      '(docs/workforce-os-architecture.md §3.1, which also names the unguarded top-level await at ' +
      'admin/hr/attendance/index.astro:117); it ' +
      'exists only because db/hr-schema.sql was applied by hand. Read it inside a try/catch.',
  },
  {
    key: 'worklog.today',
    title: 'What you logged at clock-out',
    group: 'time',
    dataSource: 'hr_task_log WHERE employee_id = self AND log_date = CURRENT_DATE.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 330,
    size: 'sm',
    render: 'list',
    href: null,
    hideWhenEmpty: true,
    notes:
      'Sparse by construction: the only writer is the clock_out branch of portal/employee.astro:185, and ' +
      'only when the text field is non-empty, inside a silent try/catch. It has ZERO admin readers — what ' +
      'someone types at clock-out currently reaches nobody. Do not imply it was read.',
  },
  {
    key: 'attendance.month',
    title: 'This month\'s attendance',
    group: 'time',
    dataSource: 'hr_attendance WHERE employee_id = self, grouped by status for the current month.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 340,
    size: 'md',
    render: 'stat-row',
    href: null,
    notes:
      'Days present / on leave / absent — NOT a percentage against a target and NOT a completion bar. The ' +
      'target framing belongs to credit.position, which is internship-only, and putting it here is exactly ' +
      'the defect this registry exists to fix. Never show overtime_hours: it has zero writers and is ' +
      'structurally always 0. "Absent" is counted against CALENDAR days — there is no holiday table — so ' +
      'weekends land in it. Say so or count only weekdays.',
  },
  {
    key: 'offline.queue',
    title: 'Work waiting to sync',
    group: 'time',
    dataSource: 'offline_work WHERE user_id = self, via GET /api/offline/mine (table: api/offline/sync.ts:13).',
    requires: [],
    audience: anyone,
    priority: 350,
    size: 'sm',
    render: 'stat',
    href: '/portal/worklog',
    hideWhenEmpty: true,
    notes:
      'The queue is client-side (IndexedDB, public/offline-sync.js); this shows what has landed. The payload ' +
      'is opaque jsonb and reaches no other table — it is a record that work happened, not a task or an hour ' +
      'block.',
  },
  {
    key: 'leave.mine',
    title: 'Your leave',
    group: 'time',
    dataSource: 'listLeave({ employeeId }) -> hr_leave_request (src/lib/hr-leave.ts:74).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 360,
    size: 'md',
    render: 'list',
    href: '/portal/employee/leave',
    quickAction: { label: 'Apply for leave', href: '/portal/employee/leave', icon: 'calendar' },
  },
  {
    key: 'leave.balance',
    title: 'Leave balance',
    group: 'time',
    dataSource: 'getBalances(employeeId) (src/lib/hr-leave.ts:46) — a SUM over hr_leave_request per year.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 370,
    size: 'sm',
    render: 'stat-row',
    href: '/portal/employee/leave',
    notes:
      'Entitlement is the CODE CONSTANT LEAVE_TYPES (hr-leave.ts:11), not a per-person record: no accrual, ' +
      'no carry-forward, no pro-rata for a mid-year joiner, no override. A mid-year joiner is shown the full ' +
      'annual allowance, which is wrong for them. Word it as the standard allowance, not as their balance.',
  },

  // ------------------------------------------------------------------ internship
  // The three widgets this whole exercise is about. They are NOT deleted — they are correct, and
  // they are the point of the intern workspace. They require an internship engagement; only the one
  // that states a figure AGAINST A TARGET additionally requires that target to be recorded.
  {
    key: 'credit.position',
    title: 'Credit hours',
    group: 'internship',
    dataSource: 'ledgerFor(employeeId, termsFor(employeeId)) (src/lib/credit-ledger.ts:110) over hr_attendance + approved hr_leave_request.',
    requires: [],
    audience: internshipOnly,
    priority: 400,
    size: 'lg',
    render: 'progress',
    href: '/portal/workspace',
    notes:
      'THE WIDGET THAT STARTED THIS. Senior leadership signing in and being shown a credit-hours progress ' +
      'bar was the reported failure. The lock is the internship engagement. Derived live, never stored — do ' +
      'not "optimise" it into a ledger table, because a stored balance drifts the first time a leave request ' +
      'is cancelled. ' +
      'NO `engagement-terms` GATE, DELIBERATELY, and this is the second time it has been reconsidered. ' +
      'hr_employees.required_credit_hours has exactly ONE writer — the per-person form at ' +
      '/admin/hr/completion/[id].astro — so it is NULL for almost every intern, and gating on it removed ' +
      'the credit hours, attendance percentage and days-in figures from the very people the whole surface ' +
      'exists for. It also contradicted the master spec (§11.4): the card renders "no credit-hour ' +
      'requirement recorded" rather than "0% complete", because zero and unknown are different facts. The ' +
      'progress BAR is already suppressed on its own when requiredCreditHours is unset (creditPct === null ' +
      'in portal/employee.astro), so nothing here can render a bar against a target nobody agreed to.',
  },
  {
    key: 'credit.weeksLeft',
    title: 'Weeks remaining',
    group: 'internship',
    dataSource: 'remainingWeeks(summary, terms) (src/lib/credit-hours.ts), from the same ledger read.',
    requires: [],
    audience: internshipOnly,
    gate: 'engagement-terms',
    priority: 410,
    size: 'sm',
    render: 'stat',
    href: '/portal/workspace',
    notes:
      'Share one ledgerFor() call with credit.position. Two reads of the same arithmetic can disagree. ' +
      'This one KEEPS the `engagement-terms` gate: "weeks remaining" is a countdown to a target, and ' +
      'remainingWeeks() has nothing to count towards when no requirement is recorded.',
  },
  {
    key: 'completion.status',
    title: 'Completion',
    group: 'internship',
    dataSource: 'completionFor() (src/lib/credit-ledger.ts:307) — the same engine the completion letter uses.',
    requires: [],
    audience: internshipOnly,
    priority: 420,
    size: 'md',
    render: 'stat-row',
    href: null,
    hideWhenEmpty: true,
    notes:
      'Same engine as the letter, deliberately, so what the person reads here is what the letter will say. ' +
      'No terms gate: "nothing has been recorded yet" is a legitimate and useful answer near the end of an ' +
      'engagement, where credit.position would be a bar against nothing.',
  },

  // ------------------------------------------------------------------ money
  {
    key: 'wallet.balance',
    title: 'Salary wallet',
    group: 'money',
    dataSource: 'getBalance(employeeId) -> hr_wallet_txn (src/lib/hr-wallet.ts:50, self-creating schema).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 500,
    size: 'md',
    render: 'stat-row',
    href: '/portal/employee/wallet',
    quickAction: { label: 'Wallet', href: '/portal/employee/wallet', icon: 'wallet' },
    notes: 'Credits are idempotent on ref=\'payslip:<id>\', so re-running a payroll credit cannot double-pay.',
  },
  {
    key: 'wallet.recent',
    title: 'Recent wallet activity',
    group: 'money',
    dataSource: 'listTxns(employeeId, limit) -> hr_wallet_txn (src/lib/hr-wallet.ts:59).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 510,
    size: 'md',
    render: 'list',
    href: '/portal/employee/wallet',
    hideWhenEmpty: true,
  },
  {
    key: 'payslips.mine',
    title: 'Your payslips',
    group: 'money',
    dataSource: 'hr_payslips JOIN hr_payroll_runs WHERE employee_id = self.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 520,
    size: 'md',
    render: 'list',
    href: null,
    hideWhenEmpty: true,
    notes:
      'LIVE LIABILITY on the download route, not on this list: src/lib/hr-payslip.ts:24 SELECTs ' +
      'e.work_email, a column NOTHING writes, created at runtime only by an unrelated page\'s bootstrap. ' +
      'Where that page has not loaded, /portal/payslip/[id] 500s. This widget must list from hr_payslips ' +
      'directly and must not name work_email. Neither table has runtime DDL anywhere in src/.',
  },
  {
    key: 'bank.status',
    title: 'Payout account',
    group: 'money',
    dataSource: 'listBankAccounts(employeeId) -> hr_bank_account, masked by mask() (src/lib/hr-wallet.ts:71).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 530,
    size: 'sm',
    render: 'stat',
    href: '/portal/employee/wallet',
    notes:
      'Show "on file" or "not added" and the masked tail — never the account number, never the IFSC. Do NOT ' +
      'render a "verified" badge: hr_bank_account.verified is read and written by nothing, so it is ' +
      'permanently false. Two bank stores exist and never meet — hr_employees.bank_* is written by three ' +
      'onboarding forms and read by nothing, while payouts read hr_bank_account only.',
  },
  {
    key: 'payroll.lastRun',
    title: 'Last payroll run',
    group: 'money',
    dataSource: 'hr_payroll_runs, most recent row.',
    requires: ['admin.access'],
    requiresSection: [{ key: 'payroll', action: 'view' }],
    audience: anyone,
    priority: 540,
    size: 'sm',
    render: 'stat',
    href: '/admin/hr/payroll',
    hideWhenEmpty: true,
    notes:
      'RESIDUAL GAP, stated rather than hidden: /admin/hr/payroll narrows further than any capability this ' +
      'registry can express (an explicit two-role list at index.astro:10), so a custom role granted the ' +
      'payroll section reaches this card and is redirected at the door. The fix belongs on that page — it ' +
      'should ask canAccessSection() like everything else — not in a role test smuggled into this file. ' +
      'hr_payroll_runs has no runtime DDL: read it inside a try/catch.',
  },

  // ------------------------------------------------------------------ people
  {
    key: 'manager.card',
    title: 'Your reporting manager',
    group: 'people',
    dataSource:
      'hr_employees (full_name, designation) WHERE user_id = hr_employees.reporting_manager_id of the ' +
      'viewer\'s own row.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 600,
    size: 'sm',
    render: 'identity',
    href: null,
    hideWhenEmpty: true,
    notes:
      'THE ID-SPACE TRAP, and the most likely implementation error in this codebase: ' +
      'reporting_manager_id holds a USERS id, not an hr_employees id. Joining it to hr_employees.id ' +
      'matches zero rows and reads as "not recorded" instead of failing. ORDER BY is_active DESC, ' +
      'created_at DESC LIMIT 1 — one human can hold several hr_employees rows. Two display columns only: ' +
      'this is the one row belonging to someone else that a personal workspace may read.',
  },
  {
    key: 'department.card',
    title: 'Your department',
    group: 'people',
    dataSource:
      'ctx.departmentId + ctx.departmentName, resolved by lookupWorkspace() from ' +
      'hr_employees.department_id joined to departments.name. NO QUERY OF ITS OWN.',
    requires: [],
    audience: withEmployeeRecord,
    priority: 605,
    size: 'sm',
    render: 'identity',
    href: null,
    notes:
      'DISPLAY ONLY, AND SAY SO. ctx.departmentId is documented as self-scope and display; it never ' +
      'grants the right to see anybody else, and it must never be handed to departmentFilter() to ' +
      'manufacture a peer list — that is a new authorisation decision, not a rendering one. ' +
      'NOT hideWhenEmpty, deliberately, and it is the same reasoning as manager.card: ' +
      'hr_employees.department_id has exactly ONE writer (src/lib/hr/sync.ts, on the ' +
      'application-to-hire path), so it is permanently NULL for anyone HR added by hand — and an ' +
      'unrecorded department is not an empty field, it is the reason that person is invisible to ' +
      'every department list in the product. Hiding the card hides the one sentence that gets it ' +
      'fixed. A null NAME with a non-null id means the key points at no departments row: say the ' +
      'code, do not print "null".',
  },
  {
    key: 'reports.direct',
    title: 'Your direct reports',
    group: 'people',
    dataSource: 'hr_employees WHERE reporting_manager_id = users.id of the viewer AND is_active.',
    requires: [],
    audience: managesPeople,
    priority: 610,
    size: 'md',
    render: 'list',
    component: 'src/components/workforce/AvatarStack.astro',
    href: null,
    notes:
      'Names and designations only. Never gender, government ids, bank details or salary — the ' +
      'EMPLOYEE_COLUMNS allow-list in workspace-access.ts:155 exists because a SELECT * on this table ' +
      'dragged gender into a page that showed none of it. The column is ALTERed in by only two admin pages ' +
      'at page load, so it may be absent: read it inside a try/catch and fail to zero.',
  },
  {
    key: 'team.roster',
    title: 'Your department',
    group: 'people',
    dataSource: 'hr_employees narrowed by departmentFilter(gate) (src/lib/auth/workspace-access.ts:513).',
    requires: [],
    audience: leadsADepartment,
    priority: 620,
    size: 'lg',
    render: 'list',
    component: 'src/components/workforce/AvatarStack.astro',
    href: '/portal/team',
    notes:
      'departmentFilter never returns true — the worst a mistake produces is an empty list, never the whole ' +
      'table. Render DEPARTMENT_COVERAGE_NOTICE: a hand-created record has no department and cannot appear.',
  },
  {
    key: 'attendance.team',
    title: 'Department attendance',
    group: 'people',
    dataSource: 'hr_attendance JOIN hr_employees, narrowed by departmentFilter(gate), for the current month.',
    requires: [],
    audience: leadsADepartment,
    priority: 630,
    size: 'lg',
    render: 'stat-row',
    href: '/portal/team',
    notes:
      'hr_attendance ONLY — status and hours. NEVER hr_clock_events for anybody but the signed-in person: it ' +
      'stores GPS, IP, device and a selfie per punch (workspace-access.ts:36-39). A lead needs to know who ' +
      'was working, not where they were standing.',
  },
  {
    key: 'headcount.summary',
    title: 'Headcount',
    group: 'people',
    dataSource: 'COUNT over hr_employees by employment_status / employment_type.',
    requires: ['admin.access'],
    requiresSection: [{ key: 'employees', action: 'view' }],
    audience: anyone,
    priority: 640,
    size: 'md',
    render: 'stat-row',
    href: '/admin/hr/employees',
    notes:
      'Aggregate only. A per-person list on this surface is /admin/hr/employees\' job, behind its own gate. ' +
      'Counting by employment_type will read oddly: the column is free text written inconsistently ' +
      "('Internship' from the HR form, 'full_time' from the auto-hire path), so group it loosely or not at all.",
  },

  // ------------------------------------------------------------------ growth
  {
    key: 'goals.mine',
    title: 'Your goals',
    group: 'growth',
    dataSource: 'listGoals(employeeId) -> hr_employee_goals (src/lib/hr-lifecycle.ts:259, self-creating).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 700,
    size: 'md',
    render: 'list',
    href: null,
    hideWhenEmpty: true,
    notes:
      'THIS IS THE FIRST PORTAL READER OF THIS TABLE. Goals are written by HR and, until now, could not be ' +
      'seen by the person they are about. employee_acknowledged is declared and written by nothing, so never ' +
      'render an acknowledgement state or an "accepted" tick — read-only until an acknowledgement surface ' +
      'exists.',
  },
  {
    key: 'probation.mine',
    title: 'Probation',
    group: 'growth',
    dataSource: 'getActiveProbation(employeeId) -> hr_probation (src/lib/hr-lifecycle.ts:166).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 710,
    size: 'sm',
    render: 'stat',
    href: null,
    hideWhenEmpty: true,
    notes: 'Dates and status only. Reviewer notes on hr_probation_reviews are the reviewer\'s working record, not feedback.',
  },
  {
    key: 'pip.mine',
    title: 'Improvement plan',
    group: 'growth',
    dataSource: 'listPips(employeeId) -> hr_pips (src/lib/hr-lifecycle.ts:299).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 720,
    size: 'md',
    render: 'list',
    href: null,
    hideWhenEmpty: true,
    notes:
      'A FAIRNESS GAP, not a cosmetic one: employee_acknowledged is never written on any of the four ' +
      'lifecycle tables, so a plan the person never saw is today indistinguishable from one they accepted. ' +
      'Showing it to them is the first half of closing that; the acknowledgement write is the second and is ' +
      'not built. Do not imply acknowledgement.',
  },
  {
    key: 'perf.mine',
    title: 'Performance review',
    group: 'growth',
    dataSource:
      'hr_performance_reviews WHERE employee_id = self AND status=\'submitted\', joined to ' +
      'hr_review_cycles (the query at src/pages/portal/workspace.astro:342).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 730,
    size: 'md',
    render: 'list',
    href: '/portal/workspace',
    hideWhenEmpty: true,
    notes:
      "Submitted rows only, and NEVER reviewer_comments — that is the reviewer's working note, and a " +
      'half-finished draft is not feedback. Do not join pr.reviewer_id: the column is declared nowhere and ' +
      'written by nothing, and the admin page that joins it renders an empty list with no error.',
  },
  {
    key: 'reviews.mine',
    title: 'Reviews on your record',
    group: 'growth',
    dataSource: 'reviewsFor(employeeId) -> hr_reviews (src/lib/credit-ledger.ts:278, self-creating).',
    requires: [],
    audience: withEmployeeRecord,
    priority: 740,
    size: 'md',
    render: 'list',
    href: null,
    hideWhenEmpty: true,
    notes:
      'hr_reviews is the completion-letter flow and is a DIFFERENT table from hr_performance_reviews and ' +
      'hr_probation_reviews. Three review tables exist and never meet; do not present them as one history.',
  },
  {
    key: 'onboarding.docs',
    title: 'Your joining documents',
    group: 'growth',
    dataSource: 'listDocs(userId) -> hr_onboarding_documents (src/lib/hr-onboarding.ts:78, self-creating).',
    requires: [],
    audience: anyone,
    priority: 750,
    size: 'md',
    render: 'list',
    href: '/portal/onboarding',
    quickAction: { label: 'Joining documents', href: '/portal/onboarding', icon: 'doc' },
    notes:
      'Keyed by users.id, not employee_id (the employee_id column is declared and always NULL). listDocs ' +
      'THROWS rather than returning [] on failure, which is what this needs: an empty list and a failed read ' +
      'must not become the same sentence. A rejected row is usually the sharing permission, not the document.',
  },

  // ------------------------------------------------------------------ hiring
  {
    key: 'hiring.pipeline',
    title: 'Applications in flight',
    group: 'hiring',
    dataSource: 'COUNT over applications grouped by status.',
    requires: ['admin.access', 'applications.view'],
    audience: anyone,
    priority: 800,
    size: 'md',
    render: 'stat-row',
    href: '/admin/applications',
    notes: 'Counts only. Candidate names belong on the pipeline page, behind its own gate, not on a workspace card.',
  },
  {
    key: 'hiring.openRoles',
    title: 'Open roles',
    group: 'hiring',
    dataSource: 'roles WHERE is_open = true (src/lib/db/schema.ts).',
    requires: ['admin.access', 'roles.view'],
    audience: anyone,
    priority: 810,
    size: 'sm',
    render: 'stat',
    href: '/admin/roles',
    notes: 'The table is `roles`, never `open_roles`. department_id is a varchar(50) SLUG — never cast it to ::uuid.',
  },
  {
    key: 'offers.pending',
    title: 'Offers awaiting signature',
    group: 'hiring',
    dataSource:
      'offer_letters WHERE signed_at IS NULL AND withdrawn_at IS NULL AND declined_at IS NULL ' +
      '(src/lib/db/schema.ts:368).',
    requires: ['admin.access', 'offers.view'],
    audience: anyone,
    priority: 820,
    size: 'sm',
    render: 'stat',
    href: '/admin/offers',
    hideWhenEmpty: true,
    notes:
      'The ISSUER\'s side. The candidate side — "an offer is waiting for YOUR signature" — is deliberately ' +
      'not registered: signing is reached by an unguessable token sent to one person, so no per-user inbox ' +
      'query exists. Never widen the wording into one.',
  },
  {
    key: 'requisitions.mine',
    title: 'Your hiring requisitions',
    group: 'hiring',
    dataSource: 'hiring_requisitions WHERE requester_user_id = self (src/lib/hr-requisition.ts:11, self-creating).',
    requires: ['admin.access'],
    audience: anyone,
    priority: 830,
    size: 'md',
    render: 'list',
    href: '/admin/hr/requisitions',
    hideWhenEmpty: true,
    notes:
      'YOUR OWN rows and their stage — never a "waiting on your approval" queue. decideRequisition() ' +
      'performs NO role check and takes the stage from a hidden form field, so any non-applicant account can ' +
      'approve at both stages including its own requisition. A queue built on that would be wrong for ' +
      'everyone. Fix the authorisation hole first; see UNREGISTERED. Also: opened_role_id is never written, ' +
      'so "approved requisitions become open roles" is a comment and not a behaviour.',
  },

  // ------------------------------------------------------------------ community
  {
    key: 'groups.mine',
    title: 'Your groups',
    group: 'community',
    dataSource: 'visibleGroupsFor(userId) -> work_groups + work_group_members (src/lib/work-groups.ts).',
    requires: [],
    audience: anyone,
    priority: 900,
    size: 'md',
    render: 'list',
    href: '/portal/team-groups',
    quickAction: { label: 'Community', href: '/portal/team-groups', icon: 'people' },
    notes:
      'The ONLY permitted way to list groups. A group the person is not entitled to is ABSENT from the ' +
      'result, not greyed out and not "request access" — a list of team names is a map of the organisation. ' +
      'It selects has_link and never join_url: a chat invite link is a bearer credential, revealed only by a ' +
      'POST after membership is re-derived. Never render a count of groups they cannot see.',
  },
  {
    key: 'discussion.recent',
    title: 'Recent discussion',
    group: 'community',
    dataSource: 'discussions (inline DDL at src/pages/portal/discussion.astro:51).',
    requires: [],
    audience: anyone,
    priority: 910,
    size: 'md',
    render: 'list',
    href: '/portal/discussion',
    hideWhenEmpty: true,
    notes:
      'Do NOT order by is_pinned or filter on is_deleted: both are declared, both are ordered and filtered ' +
      'on by the board today, and NOTHING writes either — pinning and deletion appear to exist in the sort ' +
      'order and do not exist at all. Order by created_at. The board itself has no moderation surface and ' +
      'its only gate is "signed in".',
  },
  {
    key: 'huddle.active',
    title: 'Live huddles',
    group: 'community',
    dataSource: "meet_presence WHERE last_seen > NOW() - interval (src/pages/api/portal/meet/[id]/signal.ts:28).",
    requires: [],
    audience: anyone,
    priority: 920,
    size: 'sm',
    render: 'stat',
    href: '/portal/meet',
    hideWhenEmpty: true,
    notes:
      'WHO IS IN A ROOM RIGHT NOW — a presence heartbeat, and the only meeting fact this database can state. ' +
      'Scheduled meetings are NOT registered: meet_rooms.scheduled_at, duration_min, invitees and recurrence ' +
      'are written by nothing, the sole INSERT creates an ad-hoc untitled huddle, and the scheduler UI POSTs ' +
      'to /api/meet/rooms, which does not exist. Never present presence as a calendar.',
  },

  // ------------------------------------------------------------------ account
  {
    key: 'profile.me',
    title: 'Your record',
    group: 'account',
    dataSource:
      'resolveWorkspace(user) -> hr_employees identity columns only (EMPLOYEE_COLUMNS, ' +
      'src/lib/auth/workspace-access.ts:155), falling back to users.name and users.email.',
    requires: [],
    audience: anyone,
    priority: 950,
    size: 'md',
    render: 'identity',
    href: '/portal/profile',
    // /portal/profile itself is `if (!user)` only and admits every role — the redirect that used to
    // bounce employees out of their own profile is gone (profile.astro:7-10). /portal/profile/EDIT
    // still carries it, so no quick action points there.
    quickAction: { label: 'My profile', href: '/portal/profile', icon: 'person' },
    minimal: true,
    notes:
      'In MINIMAL_WIDGETS because it needs nothing but the session: when the context could not be resolved ' +
      'it still answers "you are signed in as", which is exactly the right thing on a degraded screen. ' +
      'users has `name`, NOT full_name — four files queried full_name and 500ed a live page. Identity and ' +
      'engagement only: no gender, no government ids, no bank details, no salary.',
  },
  {
    key: 'permissions.mine',
    title: 'What you can do here',
    group: 'account',
    dataSource: 'The resolved context itself — resolvePermissions() (src/lib/auth/registry.ts:678). No query.',
    requires: [],
    audience: anyone,
    priority: 960,
    size: 'md',
    render: 'list',
    href: null,
    hideWhenEmpty: true,
    notes:
      'Costs nothing: the composer has already resolved it. A super_admin holds the wildcard rather than a ' +
      'list, so render "every permission" for that case instead of printing a single asterisk. If ' +
      'ResolvedPermissions.degraded is true the set is empty because the lookup FAILED, not because they ' +
      'hold nothing — say so, or this widget tells someone they have lost their access.',
  },
  {
    key: 'support.hr',
    title: 'Your HR support sessions',
    group: 'account',
    dataSource:
      'hr_application_support WHERE user_id = self OR candidate_email = self (src/lib/hr-support.ts:11, ' +
      'self-creating), plus a count of hr_support_messages per request.',
    requires: [],
    audience: anyone,
    priority: 970,
    size: 'sm',
    render: 'list',
    href: '/portal/hr-support',
    hideWhenEmpty: true,
    notes:
      'HONEST NARROWING: this is the paid application-support service, which is CANDIDATE-facing, and it is ' +
      'the only HR support store that exists in this codebase. There is no staff helpdesk table. So the ' +
      'widget shows the person their OWN sessions and nothing else, hides itself when there are none, and ' +
      'must never be titled as if it were a way to raise a workplace issue. Do not print the fee.',
  },
  {
    key: 'wellness.entry',
    title: 'Wellness',
    group: 'account',
    dataSource: 'canAccessWellness(user) (src/lib/wellness.ts:302) — ELIGIBILITY ONLY. No health data is read.',
    requires: [],
    audience: anyone,
    gate: 'wellness-eligible',
    priority: 980,
    size: 'sm',
    render: 'link',
    href: '/portal/wellness',
    notes:
      'A DOOR, AND NOTHING ELSE. render is \'link\' deliberately: no cycle, no symptom, no prediction, no ' +
      'count and no date may appear on a workspace card. No admin, and not the founder, may see one ' +
      'person\'s wellness record; oversight is aggregate-only and suppresses any group below MIN_GROUP. The ' +
      'gate is asynchronous precisely so eligibility is not evaluated for every person who signs in, and it ' +
      'returns a boolean — the composer never learns, stores or logs why.',
  },
  {
    key: 'legalhold.mine',
    title: 'Who has opened your records',
    group: 'account',
    dataSource: 'accessHistoryFor(userId) -> the legal-hold access log (src/lib/legal-hold.ts:330).',
    requires: [],
    audience: anyone,
    priority: 985,
    size: 'sm',
    render: 'list',
    href: '/portal/my-record-access',
    hideWhenEmpty: true,
    notes:
      'The subject\'s own view of who read their held records, and a transparency right rather than a ' +
      'feature. hideWhenEmpty keeps the card off a workspace where nothing has happened; the SURFACE at ' +
      '/portal/my-record-access stays reachable either way, so hiding the card never hides the right.',
  },
  {
    key: 'activity.feed',
    title: 'Platform activity',
    group: 'account',
    dataSource: 'activity_log (src/lib/activity-feed.ts:56).',
    requires: [HOLDS_EVERY_PERMISSION],
    audience: anyone,
    priority: 990,
    size: 'md',
    render: 'timeline',
    component: 'src/components/workforce/Timeline.astro',
    href: '/admin/activity',
    hideWhenEmpty: true,
    notes:
      'Requiring the wildcard is how "the account that holds everything" is said without naming a role — it ' +
      'admits exactly the accounts /admin/activity admits. SPARSE BY CONSTRUCTION: attachActivityFeed() ' +
      '(activity-feed.ts:192) is never called anywhere, so the bus-to-log subscription does not exist at ' +
      'runtime and only three direct record() call sites produce rows. No task event reaches it at all. ' +
      'Present it as a partial trail, never as the record of what happened.',
  },
  {
    key: 'audit.recent',
    title: 'Recent audit entries',
    group: 'account',
    dataSource: 'audit_log (src/lib/db/schema.ts:306), newest first.',
    requires: ['admin.access', 'audit.view'],
    audience: anyone,
    priority: 995,
    size: 'md',
    render: 'timeline',
    component: 'src/components/workforce/Timeline.astro',
    href: '/admin/audit',
    hideWhenEmpty: true,
    notes:
      'THE TRAIL IS INCOMPLETE BY CONSTRUCTION — logAudit() swallows its own exception (audit.ts:21), and ' +
      'the intern bulk-demotion writes no audit row at all. Never say "everything that happened". ' +
      'admin.access is required ALONGSIDE audit.view for the same reason onboarding.review requires it: ' +
      'middleware.ts:327 and canOpenAdmin() (admin-access.ts:137) bounce any account without admin.access ' +
      'off /admin entirely, so a custom role granted audit.view alone would be shown a card whose only ' +
      'route to action is a redirect. Requiring it hides the card from nobody who can open the page — ' +
      'every account that reaches /admin/audit already holds both. ' +
      'RESIDUAL WIDTH MISMATCH, stated rather than hidden: /admin/audit gates audit.view with can(), which ' +
      'reads PERMS_BY_ROLE only, while this requirement is resolved through the registry — so a custom ' +
      'role GRANTED audit.view still passes here and is redirected there. The fix for THAT is to migrate ' +
      'the page to the registry, not to narrow this to a role.',
  },
];

// ---------------------------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT REGISTERED, and why. Recorded here so the next person does not spend an
// afternoon rediscovering it, and so "it is missing" is never mistaken for "nobody thought of it".
// Each line names the artefact that would have to exist first.
// ---------------------------------------------------------------------------------------------

export const UNREGISTERED: readonly { key: string; reason: string }[] = [
  {
    key: 'meetings.today',
    reason:
      'meet_rooms.scheduled_at, duration_min, invitees and recurrence are written by NOTHING; the sole ' +
      'INSERT creates an ad-hoc untitled huddle, host_user_id is declared INTEGER against ::uuid casts in ' +
      'its own reader, and the scheduler UI POSTs to /api/meet/rooms, which does not exist. Needs the ' +
      'staff_meetings + staff_meeting_invitees pair (architecture doc §3.8). huddle.active is what CAN be ' +
      'answered today.',
  },
  {
    key: 'announcements.latest',
    reason:
      'No announcements table exists anywhere in src, db or scripts. discussions.is_pinned cannot ' +
      'substitute: nothing writes it. Needs staff_announcements (§3.9), which can ride the notification ' +
      'system that already works.',
  },
  {
    key: 'mentions.me',
    reason:
      'No mentions table, no mention column, no tokenising on write. employee_task_comments has five ' +
      'columns: no parent_id, no read state, no mentions, no receipts. "X is waiting for your answer" ' +
      'cannot be derived from any table in this database.',
  },
  {
    key: 'learning.assigned',
    reason:
      'training_enrollments has ONE writer — the learner opening a course themselves — and no assigned_by, ' +
      'due_at or required column. "What I have started" is answerable; "what is assigned to me" is not. The ' +
      'training_* tables also have no CREATE TABLE anywhere in the repo (§3.10), so every column named ' +
      'against them is unverified.',
  },
  {
    key: 'approvals.requisition',
    reason:
      'SECURITY, not schema. decideRequisition() performs no role check and takes the stage from a hidden ' +
      'form field, so any non-applicant account can approve at both stages including its own requisition. A ' +
      '"waiting on you" count would be wrong for everyone and would advertise the hole. Fix the ' +
      'authorisation first (§3.12); requisitions.mine ships in the meantime.',
  },
  {
    key: 'offers.awaitingMySignature',
    reason:
      'Signing is reached by an unguessable 32-character token sent to one person. There is no per-user ' +
      'inbox query, and inventing one would mean querying by candidate_email, which is not the same person ' +
      'as the signed-in account.',
  },
  {
    key: 'comments.unread',
    reason:
      'employee_task_comments has no read state and no receipts. The only honest number is a total, which ' +
      'is not "waiting on you". chat_message_receipts exists but the DM ticks are hardcoded read, so a tick ' +
      'proves nothing.',
  },
  {
    key: 'overtime.month',
    reason:
      'hr_attendance.overtime_hours has ZERO writers — four grep hits, none of them a write. Any total is ' +
      'structurally 0 and would read as a real figure. No overtime rule, rate, threshold or approval exists.',
  },
  {
    key: 'projects.mine',
    reason:
      'No projects table, no project_id, no projectId anywhere in src/ or db/ — grep-verified twice. ' +
      'employee_tasks has no project relation, so "group my work by project" is not a question this ' +
      'database can answer at all. (The second half of this reason — "and createTask() still has no ' +
      'caller" — is now out of date: the assign form landed at portal/tasks/index.astro:424. The ' +
      'missing TABLE is what still blocks it, and that has not changed.)',
  },
  {
    key: 'wellness.summary',
    reason:
      'DELIBERATELY IMPOSSIBLE. No individual health data reaches any workspace, any admin surface or the ' +
      'founder. wellness.entry is a door and carries no data. A widget that returned a row per user is the ' +
      'screen that must not exist.',
  },
];

// ---------------------------------------------------------------------------------------------
// Derived views of the registry. All computed from WIDGETS, so nothing can drift from it.
// ---------------------------------------------------------------------------------------------

/**
 * What a person sees when the context could NOT be resolved.
 *
 * Every widget here is scoped by users.id alone: no employee record, no department, no permission,
 * no engagement. Over-showing is the failure that cannot be undone, and a degraded workspace that
 * quietly renders everything is exactly how one person's screen ends up showing another's work.
 */
export const MINIMAL_WIDGETS: readonly WidgetDefinition[] =
  WIDGETS.filter((w) => w.minimal === true && w.requires.length === 0 && !w.requiresSection && !w.gate);

const BY_KEY = new Map<string, WidgetDefinition>(WIDGETS.map((w) => [w.key, w]));

export function getWidget(key: string): WidgetDefinition | null {
  return BY_KEY.get(key) || null;
}

export const WIDGET_KEYS: readonly string[] = WIDGETS.map((w) => w.key);

/** Lower priority first; key breaks a tie so the order is stable across processes. */
export function byPriority(a: WidgetDefinition, b: WidgetDefinition): number {
  return a.priority - b.priority || a.key.localeCompare(b.key);
}

/**
 * Structural self-check. Returns the problems rather than throwing: a malformed registry must not
 * be able to take a workspace down, and the composer logs whatever this finds.
 *
 * It cannot check that a data source exists — only a person reading the writers can do that — so it
 * checks the things that CAN be checked mechanically and would otherwise fail silently.
 */
export function validateRegistry(defs: readonly WidgetDefinition[] = WIDGETS): string[] {
  const problems: string[] = [];
  const seenKey = new Set<string>();
  const seenPriority = new Map<number, string>();
  const groups = new Set<string>(WIDGET_GROUPS);

  for (const w of defs) {
    if (!w.key) { problems.push('a widget has no key'); continue; }
    if (seenKey.has(w.key)) problems.push('duplicate key: ' + w.key);
    seenKey.add(w.key);

    if (!w.title) problems.push(w.key + ': no title');
    if (!w.dataSource) problems.push(w.key + ': no dataSource — an unnamed source is not a source');
    if (!groups.has(w.group)) problems.push(w.key + ': unknown group ' + w.group);
    if (typeof w.audience !== 'function') problems.push(w.key + ': audience is not a predicate');
    if (!Number.isFinite(w.priority)) problems.push(w.key + ': priority is not a number');

    const clash = seenPriority.get(w.priority);
    if (clash) problems.push(w.key + ': shares priority ' + w.priority + ' with ' + clash);
    else seenPriority.set(w.priority, w.key);

    // A minimal widget that needs anything resolved is not minimal — it would appear on exactly the
    // screen where the thing it needs could not be resolved.
    if (w.minimal && (w.requires.length > 0 || w.requiresSection || w.gate)) {
      problems.push(w.key + ': marked minimal but depends on a permission, a section or a gate');
    }

    // A quick action with no destination is a button that does nothing, and an unknown icon name
    // renders as a hole in the row. Both fail silently at runtime, which is why they are checked
    // here — the composer logs whatever this finds rather than throwing.
    if (w.quickAction) {
      const qa = w.quickAction;
      if (!qa.label) problems.push(w.key + ': quick action has no label');
      if (!qa.href) problems.push(w.key + ': quick action has no href — a verb with no door');
      if (QUICK_ACTION_ICONS.indexOf(qa.icon) < 0) {
        problems.push(w.key + ': quick action icon ' + String(qa.icon) + ' is not in QUICK_ACTION_ICONS');
      }
    }
  }
  return problems;
}
