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
    gate: 'Page: signed in (mail.astro:6). Narrowed here to people who work here. NOTE: /portal/mail is the internal portal mailbox, NOT the SMTP/IMAP system mounted at /admin/mail — see NAV_BACKLOG.',
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

  // ---------------------------------------------------------------- record
  {
    key: 'documents',
    label: 'Documents',
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
    key: 'learning',
    label: 'Learning',
    href: '/portal/courses',
    icon: 'book',
    group: 'record',
    bar: 11,
    // No widget backs this: learning.assigned is UNREGISTERED because training_enrollments has one
    // writer (the learner opening a course) and no assigned_by, due_at or required column. The
    // catalogue itself is open to any signed-in account and narrows its own rows by access_type.
    audience: anyone,
    gate: 'Signed in (courses/index.astro:6). The catalogue narrows itself by access_type.',
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
    key: 'calendar',
    reason:
      'ABSENT FOR STAFF. The only calendars that exist are learner calendars (edu_deadlines via ' +
      'src/lib/calendar.ts, aq_study_plan). There is no shift, roster, work_schedule or holiday table; ' +
      'meet_rooms.scheduled_at, duration_min, invitees and recurrence are written by nothing and the ' +
      'scheduler UI POSTs to /api/meet/rooms, which does not exist. Needs staff_meetings + ' +
      'staff_meeting_invitees; reuse calendar.ts\'s ICS serializer and token scheme rather than a second one.',
  },
  {
    key: 'performance',
    reason:
      'NO DEDICATED ROUTE. Submitted reviews render inside /portal/workspace, which the "Attendance and ' +
      'hours" entry already opens. A second nav entry pointing at the same URL is a false distinction, ' +
      'not a destination. It becomes a real entry when a /portal/performance surface exists — the ' +
      'readers for goals, probation and PIPs already exist in src/lib/hr-lifecycle.ts and have no portal ' +
      'reader at all today.',
  },
  {
    key: 'notifications',
    reason:
      'THE ENGINE IS COMPLETE AND ROWS ARE ALREADY WRITTEN FOR EMPLOYEES. /portal/notifications.astro:7 ' +
      'redirects every non-applicant to /admin, so linking there would send an employee into the exact ' +
      'bounce this build exists to prevent. This is one page-level fix (open that redirect), not a new ' +
      'module — notifications.unread already carries href: null for the same reason.',
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
      'A reporting manager with direct reports has NO team surface. ctx.managesPeople is true for them ' +
      'and the reports.direct widget exists, but nothing anywhere loads it and there is no ' +
      'directReportsFor(userId). /portal/team is department-lead only and would refuse them, so no entry ' +
      'may point there for them.',
  },
  {
    key: 'mail.real',
    reason:
      'TWO MAIL SYSTEMS EXIST. The real one (own SMTP/IMAP, folders, groups, rules, templates) has ' +
      'exactly one UI mount, MailClient.astro at /admin/mail, and /api/mail/send refuses a non-admin by ' +
      'canOpenAdmin. The Mail entry therefore points at /portal/mail, the internal-only mailbox on a ' +
      'different schema. What is missing is an EMPLOYEE MOUNT of MailClient.astro plus a non-admin ' +
      'authorisation for /api/mail/*, not a new mail module.',
  },
  {
    key: 'documents.library',
    reason:
      'There is no company document library, policy repository or shared file store anywhere in src/ or ' +
      'db/. The Documents entry opens JOINING documents only, and by standing rule documents are Drive ' +
      'links rather than uploads. Do not widen the label until a library exists.',
  },
  {
    key: 'profile.edit',
    reason:
      'An employee cannot edit their own record anywhere in the product: /portal/profile/edit:7 still ' +
      'redirects every non-applicant to /admin, and middleware bounces anyone without admin.access ' +
      'straight back. That is the loop shape that took /portal down before. Three more portal pages ' +
      'carry the same line — /portal/notifications:7, /portal/requests/index:6, /portal/wallet:10 — and ' +
      'no nav entry points at any of the four.',
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
