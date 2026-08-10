// src/lib/workforce/elevation.ts — THE ONE LIST OF ADMIN SURFACES THE PORTAL IS ALLOWED TO OFFER.
//
// WHAT THIS IS FOR, AND WHAT IT REFUSES TO BECOME.
//
// The ask was that somebody who runs this company should be able to act from inside the employee
// portal instead of leaving it for /admin. The dangerous reading of that ask is "build the admin
// actions again, in the portal". This codebase has already shipped two chat tables, three XP
// systems, two progress writers and two course players; a second place to approve leave would be
// that same mistake in the worst possible spot, because the two copies drift and the one that stops
// auditing is the one nobody is watching.
//
// So this module contains NO ACTION. It is a list of DOORS: for each elevated surface, the route
// that already implements it and the exact test that surface's own guard applies. The portal
// SURFACES the admin module — it never reimplements it. Everything here is read by:
//
//   - src/lib/workforce/composer.ts, which resolves the section grants below (once per request, and
//     only for somebody who could open the console at all), and
//   - src/lib/workforce/navigation.ts, which turns each one into a drawer entry whose audience is
//     "the composer already confirmed this person is admitted by the destination's own gate".
//
// WHY THE SECTION PAIRS LIVE HERE AND NOT IN navigation.ts. navigation.ts is a PURE PROJECTION: it
// performs no query and cannot open a database connection, which is the property that stops it from
// becoming a second authorization engine. Answering "does this person hold the `leave` section" is a
// query. So the QUESTION is declared here, the composer ANSWERS it beside every other section it
// already resolves (through canAccessSection, the same function the admin side uses), and the nav
// only READS the answer off the composed context. One implementation of the test, three readers.
//
// WHY IT IS NOT A CAPABILITY LIST. Two different namespaces gate /admin and they are not
// interchangeable: `admin.access` and friends are CAPABILITIES (src/lib/auth/permissions.ts, checked
// with can()/holds()), and `employees`, `leave`, `attendance`, `departments` are SECTION keys
// (src/lib/admin-sections.ts, checked with canAccessSection()). src/middleware.ts applies BOTH — the
// deny-by-default canOpenAdmin gate first, then the section gate from its PATH_SECTION table. An
// entry mirroring only the first would be a broken promise for every restricted admin: the link
// renders, the door bounces them to /admin?denied=<section>.
//
// FAIL-CLOSED IN THE SAME DIRECTION AS EVERYTHING AROUND IT. A section that cannot be answered is
// not granted (composer.ts step 8), an unknown key is never granted, and an entry whose predicate
// throws is dropped by buildWorkspaceNav. Under-showing costs one message to HR. Over-showing hands
// somebody a surface that was not theirs — or, just as bad here, tells them a surface EXISTS that
// they may not open, which is a disclosure even when the page behind it is locked.
import type { WorkspaceContext, SectionRequirement } from '@/lib/workforce/widgets';

/**
 * The widget key that means "the composer already decided this person may open the admin console".
 *
 * It is not a second test. src/lib/workforce/widgets.ts declares `console.admin` with
 * requires ['admin.access'] and audience `engagement !== 'internship'` — which is exactly what
 * canOpenAdmin() (src/lib/auth/admin-access.ts) refuses on, and exactly what src/middleware.ts asks
 * at the door. Reading the composer's verdict rather than re-deriving it is the difference between
 * one answer and two answers that agree until they do not.
 */
export const CONSOLE_WIDGET_KEY = 'console.admin';

/**
 * Does this composition belong to somebody who can open the console at all?
 *
 * MIRRORS canOpenAdmin's two live tests in the composition's vocabulary, for the ONE caller that
 * cannot wait for the widget verdict: the composer itself, which must decide whether to spend the
 * section queries BEFORE it knows which widgets survive. Everything else asks the widget.
 *
 * `holds` is wildcard-aware, so a super_admin's '*' answers true here. A bare permissions.has()
 * would answer false and hide the console from the founder — that has happened on this project.
 */
export function mayOpenConsole(ctx: WorkspaceContext | null | undefined): boolean {
  if (!ctx) return false;
  try {
    return ctx.holds('admin.access') === true && ctx.engagement !== 'internship';
  } catch {
    // A context that throws is a context that cannot vouch for anybody. Deny.
    return false;
  }
}

/**
 * ONE ELEVATED DOOR: an admin surface the portal may point at, and the test that surface applies to
 * itself. `section` is null when src/middleware.ts's PATH_SECTION table resolves no key for the path
 * — in which case canOpenAdmin IS the whole gate, and mayOpenConsole is the whole predicate here.
 */
export interface ElevatedSurface {
  /** Nav key. Prefixed `admin-` so a drawer row that leaves the portal is identifiable at a glance. */
  key: string;
  label: string;
  /** A route that exists in src/pages/admin today. */
  href: string;
  /** The section key src/middleware.ts resolves for this path, or null when it resolves none. */
  section: SectionRequirement | null;
  /** Why this surface and not another. Read this before adding one. */
  why: string;
}

/**
 * THE ELEVATED SURFACES, and the reason each earned a door rather than every admin route getting
 * one. src/lib/day-one.ts already ordered this company's setup and the link census ordered its daily
 * use; these are the intersection.
 *
 * DELIBERATELY ABSENT: PAYROLL. It is among the most linked-to admin surfaces in the codebase and it
 * is still not here, because src/lib/day-one.ts states the thing that decides it — "a payroll run
 * cannot be regenerated". A one-way, irreversible, monthly act is the worst possible candidate for a
 * door sitting one tap from a phone's home screen, and the single place where two surfaces drifting
 * apart would be unrecoverable. /admin/hr/payroll keeps its one door, in the console, where the
 * person opening it has already changed context on purpose.
 *
 * ALSO ABSENT: every /admin route that is a LIST rather than an act — users, roles, content,
 * products, audit. A drawer with thirty admin links is a second admin console with worse information
 * architecture, which is the thing this whole design refuses to build.
 */
export const ELEVATED_SURFACES: readonly ElevatedSurface[] = [
  {
    key: 'admin-leave',
    label: 'Leave requests (HR)',
    href: '/admin/hr/leave',
    section: { key: 'leave', action: 'view' },
    why:
      'THE HIGHEST-VALUE ELEVATED DOOR, and the one the engine was already built for. leave.approve ' +
      'is one of only two domains in src/lib/workflow.ts carrying a STANDING capability rather than ' +
      'per-row routing, and day-one step 5 records why it is urgent: leave approvals start working ' +
      'immediately and charge every day in a request. NOTE WHAT THIS IS NOT — it is not a second ' +
      'approval path. A reporting manager decides their own line at /portal/approvals, which routes ' +
      'through decideLeave() and re-derives authority at the write; this door is the HR view of the ' +
      'WHOLE company, which has exactly one implementation and it is /admin/hr/leave.',
  },
  {
    key: 'admin-attendance',
    label: 'Attendance (HR)',
    href: '/admin/hr/attendance',
    section: { key: 'attendance', action: 'view' },
    why:
      'The company-wide register behind the twice-a-day act every employee performs. An employee ' +
      'checks in at /portal/employee/attendance; the person who has to answer "who is not in today" ' +
      'reads /admin/hr/attendance. Two surfaces, two audiences, one implementation of each.',
  },
  {
    key: 'admin-departments',
    label: 'Departments',
    href: '/admin/departments',
    section: { key: 'departments', action: 'view' },
    why:
      'SETUP STEP 1 in src/lib/day-one.ts — "everything else in the organization hangs off a ' +
      'department" — and the prerequisite for the employee register, the org graph, and every ' +
      'approval routed from it. A founder who cannot reach it from a phone cannot unblock anything ' +
      'downstream of it.',
  },
  {
    key: 'admin-setup',
    label: 'Organization setup',
    href: '/admin/setup',
    // NO SECTION KEY, AND THAT IS A FACT ABOUT src/middleware.ts RATHER THAN AN OVERSIGHT HERE:
    // resolveAdminSection('/admin/setup') returns null because PATH_SECTION carries no prefix for
    // it, so canOpenAdmin is the entire gate at the door and mayOpenConsole is the entire predicate
    // here. Mirrored exactly — no narrower, and not one step wider.
    section: null,
    why:
      'THE ORDERED CHECKLIST, not another list of links: src/pages/admin/setup.astro singles out the ' +
      'org-graph step as the prerequisite that halts the most modules, and the graph is what every ' +
      'approval in this product reads instead of a job title. A LINK ONLY — that page and ' +
      'src/pages/admin/org/** belong to another workstream and nothing here touches them.',
  },
];

/**
 * The distinct section pairs the composer must resolve so the nav can mirror middleware.
 *
 * Small and fixed on purpose. Each pair is one canAccessSection() call; they are resolved together
 * in the single Promise.all that already resolves the widget sections, and ONLY for somebody
 * mayOpenConsole() has already said yes to — which on this deployment is a handful of accounts. An
 * ordinary employee's composition pays nothing at all for this module, and a super_admin pays
 * nothing either: canAccessSection short-circuits to true on that role with no query.
 */
export const ELEVATED_SECTION_PAIRS: readonly SectionRequirement[] = ELEVATED_SURFACES
  .map((s) => s.section)
  .filter((s): s is SectionRequirement => s !== null);

/** Lookup by nav key, for navigation.ts. Built once. */
const BY_KEY = new Map<string, ElevatedSurface>(ELEVATED_SURFACES.map((s) => [s.key, s]));

/**
 * MAY THIS COMPOSITION BE OFFERED THIS ELEVATED DOOR?
 *
 * Both tests, in the order middleware applies them: the console gate first, then the section grant
 * the destination's own path resolves. An unknown key answers false — a door nobody declared is a
 * door nobody may walk through.
 *
 * `consoleKept` is the composer's OWN verdict on the console.admin widget, passed in by
 * navigation.ts rather than re-derived, so the console door and every door behind it answer from one
 * decision. mayOpenConsole is the fallback for a caller with no widget list.
 */
export function mayOpenElevated(
  ctx: WorkspaceContext | null | undefined,
  key: string,
  consoleKept: boolean,
): boolean {
  if (!ctx || !consoleKept) return false;
  const surface = BY_KEY.get(key);
  if (!surface) return false;
  if (!surface.section) return true;
  try {
    return ctx.grantedSection(surface.section.key, surface.section.action) === true;
  } catch {
    return false;
  }
}

/** The declared surface for a key, or undefined. Used by navigation.ts to build its entries. */
export function elevatedSurface(key: string): ElevatedSurface | undefined {
  return BY_KEY.get(key);
}
