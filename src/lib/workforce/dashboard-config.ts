// src/lib/workforce/dashboard-config.ts — WHICH WIDGETS EACH KIND OF PERSON SEES, AND IN WHAT ORDER.
// Data, not branches. This file is the only place that answer is written down.
//
// WHAT THIS IS FOR. src/lib/workforce/widgets.ts says what each widget NEEDS. composer.ts resolves
// what one person HAS and returns the widgets whose conditions are met. Neither of them says what a
// SCREEN should look like — which three cards lead, which four follow, and which sit at the bottom.
// /portal/employee answers that today by hand, in one hard-coded order, for everybody. This file
// replaces that with a registry: a small set of profiles, each declaring the SIGNALS it needs and the
// widget keys it places in four slots. The composer stays the authority on eligibility; this file
// only ever ARRANGES what the composer already granted, and it can never add to it (see layoutFor).
//
// SIX RULES, EVERY ONE LOAD-BEARING.
//
//   1. NO ROLE NAME APPEARS IN THIS FILE, AND NONE MAY BE ADDED. WorkspaceContext carries no `role`,
//      so a predicate here CANNOT test one, and every signal below is a capability, an engagement, a
//      department slug or an organisational relationship. `Intern`, `Engineer`, `HR`, `Finance`,
//      `Executive` and `Super Admin` are names for PROFILES in this file; not one of them is a value
//      of users.role, and three of them (finance, executive, employee) are not roles in this database
//      at all. Writing them as role strings is what the previous phase spent a very large amount of
//      effort removing.
//
//   2. TEAM LEAD, DEPARTMENT HEAD, MANAGER AND MENTOR ARE RELATIONSHIPS, NOT ROLES AND NOT
//      CAPABILITIES. They are facts about particular rows — "these five people report to you", "you
//      are the recorded head of this department" — and a capability granted to a role can never say
//      that: granting one "to cover managers" hands every manager authority over every employee
//      (src/lib/auth/permissions.ts:213-226 says exactly this). So they live in RELATIONSHIPS below,
//      each with an honest resolution status. Two of the four CANNOT BE ANSWERED by this database
//      today; their profiles are declared, they never match, and what they are waiting for is named
//      in BLOCKED_ON_ORG_GRAPH. A role check standing in for a missing relationship is the defect
//      this file exists to prevent, not a shortcut around it.
//
//   3. AN UNANSWERABLE SIGNAL IS NOT A "NO", AND IT IS NOT A "YES". A relationship that cannot be
//      resolved returns null. Matching treats null as "did not match" — fail closed — and records it
//      in `unresolvedRelationships`, so the surface can say "we could not read who reports to you"
//      rather than printing an empty team as a fact. An empty bucket and an unreadable one are
//      different sentences; this project has shipped the wrong one twice. A relationship NOTHING can
//      answer yet is reported separately (`blockedRelationshipsConsulted`) and is never said out loud
//      to a reader: telling every employee we cannot tell whether they head a department is true of
//      everyone and useful to no one.
//
//   4. A PROFILE MAY ONLY NAME A REGISTERED WIDGET. Every key in every slot is checked against
//      widgets.ts at module load. A layout naming a widget that does not exist leaves a hole in a
//      designed grid, and a layout naming one whose data source does not exist is the failure class
//      this codebase keeps paying for.
//
//   5. THE CONFIG ARRANGES; IT NEVER AUTHORISES. layoutFor() intersects a profile's slots with the
//      widget list the composer returned. It cannot add a key the composer dropped — not by mistake,
//      not by a typo, not by a future edit — because the only widgets it can output are the ones
//      handed to it. Eligibility resolves BEFORE any loader runs, and this file runs after both.
//
//   6. THE CAPS ARE A MOBILE CONSTRAINT, NOT A STYLE PREFERENCE. Around nine in ten of these people
//      are on a phone. One attention card (two competing "look here first" cards means none), three
//      primary, four secondary, four quiet — plus the universal baseline. A longer screen is a screen
//      nobody reaches the bottom of at 360px.
//
// This module imports NOTHING that opens a database connection and holds no queries, no components
// and no DOM. It can be read, diffed and tested without a database or a request.
import {
  getWidget, HOLDS_EVERY_PERMISSION,
  type Engagement, type SectionRequirement, type WorkspaceContext,
} from '@/lib/workforce/widgets';

// ---------------------------------------------------------------------------------------------
// ORGANISATIONAL RELATIONSHIPS. The whole of rule 2 lives in this block.
// ---------------------------------------------------------------------------------------------

/**
 * The four organisational relationships this product needs, plus the two derived answers the
 * composer already resolves. Named as keys so a profile can DECLARE a dependency on one instead of
 * testing for a role that approximates it.
 */
export type RelationshipKey =
  /** Active people whose hr_employees.reporting_manager_id is this account's USERS id. */
  | 'has-direct-reports'
  /** This account is the recorded manager OF a particular employee. Per-row, never per-person. */
  | 'is-manager-of'
  /** Leads one department, i.e. has a department this account may legitimately query. */
  | 'leads-department'
  /** Is the department's HEAD OF RECORD — an org-graph fact, distinct from the capability proxy. */
  | 'department-head-of-record'
  /** Mentors, or is mentored by, another person. */
  | 'mentor-of'
  /** Can decide a leave request or a withdrawal — capability OR reporting line, resolved together. */
  | 'decides-approvals';

/** How well this database can answer a relationship today. */
export type RelationshipStatus =
  /** The composer resolves it from real rows. It may still be SPARSE — see `sparse`. */
  | 'resolved'
  /** Answered today through a stand-in that is not the org fact. Named, never hidden. */
  | 'proxy'
  /** Cannot be answered at all. resolve() returns null and every profile requiring it never matches. */
  | 'blocked'
  /**
   * Answerable, but ONLY against one named row — so it can gate a write and can never gate a
   * dashboard. resolve() returns null for the same reason 'blocked' does, and a profile requiring it
   * is equally unreachable, but the fix is not a new column: there is nothing missing.
   */
  | 'per-row';

export interface RelationshipDefinition {
  key: RelationshipKey;
  label: string;
  status: RelationshipStatus;
  /**
   * The answer for this person, from the context the composer already resolved.
   * TRUE / FALSE when the relationship can be answered; NULL when it cannot be answered at all.
   * Null is never a "no": it means the question has no data behind it, and the caller must say so.
   */
  resolve: (ctx: WorkspaceContext) => boolean | null;
  /** What the surface says when this resolves false or null. Written for a person, not a developer. */
  emptyState: string;
  /** The column, table or writer that would have to exist for this to become 'resolved'. */
  needs?: string;
  /** True when the underlying column exists but is filled in for very few rows. */
  sparse?: boolean;
  notes?: string;
}

/**
 * THE RELATIONSHIP REGISTRY.
 *
 * Read the `status` of each one before building anything on it. Two are blocked, and their profiles
 * below are declared-but-unreachable on purpose: shipping a Department Head workspace that is really
 * a role check would put a real screen in front of the wrong people and would be undiscoverable
 * afterwards, whereas an unreachable profile with a named dependency is a one-line change the day the
 * column lands.
 */
export const RELATIONSHIPS: readonly RelationshipDefinition[] = [
  {
    key: 'has-direct-reports',
    label: 'People report to you',
    status: 'resolved',
    sparse: true,
    // countDirectReports() in composer.ts:173 — hr_employees.reporting_manager_id::text = users.id.
    resolve: (c) => c.directReports > 0,
    emptyState:
      'Nobody is recorded as reporting to you. If that is not right, ask HR to set you as the reporting manager on their record.',
    notes:
      'THE ID-SPACE TRAP: reporting_manager_id holds a USERS id, never an hr_employees id. It has ONE ' +
      'writer — the Employment tab at src/pages/admin/hr/employees/[id].astro:329 — so it is filled in ' +
      'only where HR has set it, and a real manager whose reports were never recorded resolves FALSE ' +
      'here. That is why the empty state names the fix. The count itself is 0 both when nobody reports ' +
      'to this person AND when the read failed: composer.ts names the failed read in ' +
      'ComposedWorkspace.contextGaps, and a surface must check that before stating either.',
  },
  {
    key: 'is-manager-of',
    label: 'You are the recorded manager of this person',
    status: 'per-row',
    sparse: true,
    // PER ROW, so it is not answerable from a per-person context at all. Declared here so no profile
    // ever mistakes 'has-direct-reports' (a count) for it.
    resolve: () => null,
    emptyState: 'Whether you manage a particular person is decided on that person\'s record, not on this screen.',
    needs: 'A per-row check: approverRole(user, employeeId) in src/lib/hr-wallet.ts:215. It cannot be a dashboard signal.',
    notes:
      'The same person may decide one employee\'s leave and not another\'s. A dashboard profile is a ' +
      'per-PERSON decision, so this relationship can never gate one — it gates a WRITE, at the write, ' +
      'which is where decideLeave() and decideWithdrawal() already enforce it.',
  },
  {
    key: 'leads-department',
    label: 'You lead a department',
    status: 'proxy',
    // ctx.scopeDepartmentId is set by the composer ONLY from holdsCapability(user, 'department.lead')
    // plus users.assigned_department_id, and only for a non-intern record. This file asks the
    // composer's answer; it never asks who holds which role.
    resolve: (c) => !!c.scopeDepartmentId,
    emptyState:
      'No department is recorded for you, so there is no team view to show. A lead screen shows one department, and yours has not been set.',
    needs: 'departments.head_user_id UUID REFERENCES users(id) — see src/lib/auth/permissions.ts:264-270.',
    notes:
      'HONEST NAMING: this is a PROXY and not the org fact. The only leadership signal in the product ' +
      'is the pair users.role = department_head + users.assigned_department_id, written together by ' +
      '/admin/users, and half of that pair is a role name. The composer converts it to a capability ' +
      '(department.lead) so no role string reaches this file, but a capability that encodes a ' +
      'relationship is still a category error — permissions.ts:235-270 says so at length and records ' +
      'the sequence that removes it without an outage. Until then this is what "leads a department" ' +
      'means here, and it is written down rather than implied.',
  },
  {
    key: 'department-head-of-record',
    label: 'You are the recorded head of this department',
    status: 'blocked',
    resolve: () => null,
    emptyState:
      'Department heads are not recorded in the system yet, so this workspace cannot be resolved for anyone.',
    needs:
      'departments.head_user_id. `departments` is (id, name, icon, ...) in src/lib/db/schema.ts:80-90 ' +
      'and (id, name, code, description, is_active, created_at) in db/hr-schema.sql:31-38. Neither ' +
      'carries a head. Add it via ADD COLUMN IF NOT EXISTS inside an ensureOnce(), backfill from the ' +
      'existing (department_head, assigned_department_id) pairs so nobody loses access on the deploy, ' +
      'then this becomes status: resolved and the department-head profile becomes reachable.',
    notes:
      'DELIBERATELY NOT ANSWERED BY `leads-department`. They are different questions: one is "which ' +
      'department may you query", which the capability proxy answers, and the other is "who is the ' +
      'head of this department", which nothing answers. Collapsing them would make the proxy look ' +
      'like the org fact, and the whole point of declaring both is that the day head_user_id lands, ' +
      'the difference is visible in one file instead of rediscovered across nine.',
  },
  {
    key: 'mentor-of',
    label: 'Your mentor, and the people you mentor',
    status: 'blocked',
    resolve: () => null,
    emptyState:
      'No mentor is recorded for you. Mentors are not tracked in the system yet, so this is not a statement about your programme.',
    needs:
      'A mentor relation. There is NO mentor table, no mentor column and no mentor id anywhere in ' +
      'src/ or db/ (grep-verified: every hit is marketing copy in src/data/intern-catalog-*.ts and ' +
      'src/components/home/EventsTeaser.astro). It needs its own table, e.g. hr_mentorships ' +
      '(mentor_user_id, employee_id, started_on, ended_on), plus a surface that writes it.',
    notes:
      'THE REPORTING MANAGER IS NOT A MENTOR, and manager.card must never be relabelled as one. The ' +
      'intern programme promises mentorship in its published copy, so a screen that renders the ' +
      'reporting manager under a "Your mentor" heading would be making a claim the database cannot ' +
      'support about a relationship the person was promised. The intern profile therefore places ' +
      'manager.card under its own honest title and lists the mentor card as blocked.',
  },
  {
    key: 'decides-approvals',
    label: 'Requests wait on your decision',
    status: 'resolved',
    // ctx.approvesRequests = decidesEveryRequest(user) || directReports > 0 (composer.ts:409-413) —
    // exactly what pendingLeaveForApprover() and pendingWithdrawalsForApprover() return rows for.
    resolve: (c) => c.approvesRequests,
    emptyState: 'Nothing is waiting on your decision.',
    notes:
      'Half capability, half relationship, resolved together in one place so a card and the queue ' +
      'behind it cannot disagree. The card is never the authority: decideLeave() and ' +
      'decideWithdrawal() re-check at the write.',
  },
];

const RELATIONSHIP_BY_KEY = new Map<RelationshipKey, RelationshipDefinition>(
  RELATIONSHIPS.map((r) => [r.key, r]),
);

export function getRelationship(key: RelationshipKey): RelationshipDefinition | null {
  return RELATIONSHIP_BY_KEY.get(key) || null;
}

/**
 * What each blocked or proxied relationship is waiting for, as one list a backlog can be built from.
 * Derived from RELATIONSHIPS so it cannot drift from the registry that decides behaviour.
 *
 * 'per-row' is deliberately EXCLUDED: nothing is missing for it, and putting it on a backlog would
 * send somebody off to build a column that must not exist.
 */
export const BLOCKED_ON_ORG_GRAPH: readonly { key: RelationshipKey; status: RelationshipStatus; needs: string }[] =
  RELATIONSHIPS
    .filter((r) => (r.status === 'blocked' || r.status === 'proxy') && !!r.needs)
    .map((r) => ({ key: r.key, status: r.status, needs: String(r.needs) }));

/**
 * Fields a profile would need on WorkspaceContext that are not there today. Separate from the org
 * graph: these are signals the DATABASE holds and the CONTEXT does not carry, so closing them is a
 * composer change rather than a schema change. Listed so a "why does nobody get the executive
 * workspace" question has a written answer.
 */
export const PENDING_CONTEXT_FIELDS: readonly { field: string; wouldAnswer: string; source: string }[] = [
  {
    field: 'seniority',
    wouldAnswer: 'Executive (C-Level) and Leadership (Lead) profiles, by the structured level rather than by a department slug.',
    source:
      'hr_employees.application_id -> applications.role_id -> roles.level (role_level enum: C-Level, ' +
      'Lead, Senior, Mid, Junior, Intern, Apprentice). Already read for the intern signal by ' +
      'src/lib/auth/workspace-access.ts internSignals(); it is simply not carried on WorkspaceContext. ' +
      'SPARSE: application_id is not written by the manual "Add employee" form, so it is null for ' +
      'anyone HR added by hand — a null seniority must never be read as "not C-Level" for an exclusion.',
  },
  {
    field: 'classification',
    wouldAnswer: 'Volunteer and contractor profiles, and a stronger intern signal than the substring test.',
    source:
      'hr_employees.classification (permanent, fixed_term, intern, contractor, eor, consultant, ' +
      'volunteer), written by /admin/hr/classification. WorkspaceContext.engagement collapses all of ' +
      'them to internship / employment / unknown.',
  },
];

/**
 * Modules the brief asks a profile to show that have NO data source in this codebase. Naming them
 * here is what stops the next person building the card and discovering it three days in.
 */
export const ABSENT_MODULES: readonly { name: string; verdict: string }[] = [
  {
    name: 'projects',
    verdict:
      'No projects table, no project_id, no projectId anywhere in src/ or db/. employee_tasks has no ' +
      'project relation. The Engineer profile therefore shows tasks, not projects.',
  },
  {
    name: 'document library',
    verdict:
      'There is no company document library, policy repository or shared file store. ' +
      'hr_onboarding_documents holds JOINING documents only, as Google Drive links (documents are ' +
      'never uploaded here). onboarding.docs is what "documents" honestly means on these screens.',
  },
  {
    name: 'assigned learning',
    verdict:
      'training_enrollments has one writer — the learner opening a course — and no assigned_by, due_at ' +
      'or required column, and the training_* tables have no CREATE TABLE anywhere in the repo. "What ' +
      'I have started" is answerable; "what is assigned to me" is not. No learning widget is ' +
      'registered, so no profile places one.',
  },
  {
    name: 'invoices and budget',
    verdict:
      'No invoice, budget, ledger or cost-centre table exists. The Finance profile shows payroll runs ' +
      'and the withdrawal queue, which are real, and refuses revenue, runway and burn — a finance ' +
      'dashboard with a fabricated figure on it is worse than one without the tile.',
  },
  {
    name: 'organisation KPIs',
    verdict:
      'Headcount and hiring counts are real and are placed. There is no revenue, retention, or ' +
      'objective/OKR table, so the Executive profile states the organisation it can see and nothing more.',
  },
  {
    name: 'announcements',
    verdict:
      'No announcements table anywhere in src, db or scripts. discussions.is_pinned cannot substitute: ' +
      'nothing writes it. Recorded in widgets.ts UNREGISTERED as announcements.latest.',
  },
  {
    name: 'meetings and calendar',
    verdict:
      'meet_rooms.scheduled_at, duration_min, invitees and recurrence are written by nothing, and the ' +
      'scheduler UI posts to a route that does not exist. huddle.active (who is in a room right now) ' +
      'is the only meeting fact this database can state, and it is never presented as a calendar.',
  },
];

// ---------------------------------------------------------------------------------------------
// SIGNALS. The entire vocabulary a profile may require. Every one is data.
// ---------------------------------------------------------------------------------------------

/**
 * One requirement, as a plain object. There is no predicate function anywhere in a profile: a
 * profile is a record, evaluated by ONE evaluator (matchSignal), so a role test cannot be smuggled
 * into a lambda and there is exactly one place to read to know how matching works.
 */
export type Signal =
  /** An hr_employees row is linked to this account. */
  | { kind: 'employee-record' }
  /** internship | employment | unknown. 'unknown' is never a synonym for 'employment'. */
  | { kind: 'engagement'; value: Engagement }
  /** A permission key, asked through ctx.holds (WILDCARD-AWARE — see the warning below). */
  | { kind: 'capability'; key: string }
  /** Holds every permission there is. The honest way to say "the account that holds everything". */
  | { kind: 'every-permission' }
  /** An admin section grant the composer already resolved for this request. */
  | { kind: 'section'; key: string; action: SectionRequirement['action'] }
  /** The person's OWN department slug (hr_employees.department_id). Display/self-scope signal only. */
  | { kind: 'department'; anyOf: readonly string[] }
  /** An organisational relationship, answered by RELATIONSHIPS above. May answer null. */
  | { kind: 'relationship'; key: RelationshipKey };

/**
 * WARNING THAT DECIDES THE ORDER OF THE REGISTRY BELOW. ctx.holds() is wildcard-aware by design: an
 * account holding '*' answers TRUE to every capability key. So a { kind: 'capability' } signal can
 * never be used to EXCLUDE anybody, and the account that holds everything matches the first
 * capability-shaped profile in the list. That is why 'platform-admin' is ordered above people-ops and
 * finance — not because it outranks them, but because otherwise the founder would land on the HR
 * workspace and nobody would be able to explain why.
 */

/** Answer for one signal: true, false, or null when the question has no data behind it. */
export type SignalAnswer = boolean | null;

const DEPARTMENT_SLUG = (v: string | null): string => String(v || '').trim().toLowerCase();

export function matchSignal(signal: Signal, ctx: WorkspaceContext): SignalAnswer {
  switch (signal.kind) {
    case 'employee-record':
      return ctx.hasEmployeeRecord;
    case 'engagement':
      return ctx.engagement === signal.value;
    case 'capability':
      return ctx.holds(signal.key) === true;
    case 'every-permission':
      return ctx.holds(HOLDS_EVERY_PERMISSION) === true;
    case 'section':
      return ctx.grantedSection(signal.key, signal.action) === true;
    case 'department': {
      const own = DEPARTMENT_SLUG(ctx.departmentId);
      // NULL IS NOT A "NO", and it is also not a match. hr_employees.department_id has exactly one
      // writer (src/lib/hr/sync.ts), so it is null for anyone HR added by hand: a person with no
      // recorded department is not "not in engineering", they are unrecorded. Answering null here
      // makes the profile fall through to the floor rather than assert something untrue.
      if (!own) return null;
      return signal.anyOf.some((slug) => DEPARTMENT_SLUG(slug) === own);
    }
    case 'relationship': {
      const rel = RELATIONSHIP_BY_KEY.get(signal.key);
      if (!rel) return null;
      try {
        return rel.resolve(ctx);
      } catch {
        // A relationship that throws is a broken definition, and a broken definition must not hand
        // somebody a workspace. Unknown, never true.
        return null;
      }
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// SLOTS AND THE UNIVERSAL BASELINE
// ---------------------------------------------------------------------------------------------

export type SlotName = 'attention' | 'primary' | 'secondary' | 'quiet';
export const SLOT_ORDER: readonly SlotName[] = ['attention', 'primary', 'secondary', 'quiet'];

export const SLOT_LABELS: readonly { slot: SlotName; label: string; purpose: string }[] = [
  { slot: 'attention', label: 'Needs you today', purpose: 'Things that go wrong if they are ignored today.' },
  { slot: 'primary', label: 'Your work', purpose: 'The work itself.' },
  { slot: 'secondary', label: 'Your position', purpose: 'Position and context.' },
  { slot: 'quiet', label: 'Reference', purpose: 'Links and rarely-changing facts.' },
];

/**
 * AUTHOR-SIDE caps, enforced at module load. They cap what a PROFILE may declare; after the composer
 * has filtered, a slot is usually shorter. The attention cap is one: a screen with two competing
 * "look here first" cards has none. The rest are the honest ceiling for a 360px phone, which is what
 * roughly nine in ten of these people are holding.
 */
export const SLOT_CAPS: Readonly<Record<SlotName, number>> = {
  attention: 1,
  primary: 3,
  secondary: 4,
  quiet: 4,
};

/**
 * The floor no profile may remove, appended after each profile's own quiet slot. Every one is scoped
 * by users.id alone, so it survives a degraded composition, and together they guarantee a composed
 * page is never blank and never useless.
 *
 * notifications.unread carries href: null on purpose — /portal/notifications redirects every
 * non-applicant to /admin, so there is no portal inbox to link to yet. Render each row against its
 * own notifications.action_url.
 */
export const UNIVERSAL_BASELINE: Readonly<{ attention: readonly string[]; quiet: readonly string[] }> = {
  attention: ['attention.queue'],
  quiet: ['notifications.unread', 'profile.me', 'support.hr'],
};

/**
 * NAVIGATION IS NOT DECIDED HERE, AND THIS FILE CARRIES NO LINKS AT ALL.
 *
 * src/lib/workforce/navigation.ts already projects the composition into a bar and a drawer
 * (buildWorkspaceNav), derived from the widgets the composer kept, capped at four tabs, with every
 * href verified against src/pages and its own backlog of what does not exist yet. A second list of
 * tabs written per profile here would be a second nav authority: the two would disagree within a
 * month, and the more generous one would be the one nobody noticed. Each widget already carries its
 * own `href` in widgets.ts, which is where a door belongs.
 *
 * If a profile ever needs to influence the bar, it should do so by ORDERING the widgets navigation.ts
 * already derives from — never by listing routes here.
 */

// ---------------------------------------------------------------------------------------------
// THE PROFILES
// ---------------------------------------------------------------------------------------------

export type ProfileKey =
  | 'intern'
  | 'platform-admin'
  | 'people-ops'
  | 'finance'
  | 'executive'
  | 'department-head'
  | 'team-lead'
  | 'manager'
  | 'engineering'
  | 'professional'
  | 'signed-in';

export interface ProfileSlots {
  attention: readonly string[];
  primary: readonly string[];
  secondary: readonly string[];
  quiet: readonly string[];
}

export interface DashboardProfile {
  key: ProfileKey;
  /** What this workspace is called on screen. Never a role name from users.role. */
  label: string;
  /** One clause the header renders, and the reason this profile was chosen. Written for a person. */
  because: string;
  /**
   * ALL of `all` must answer true AND at least one of `any` must answer true. An unanswerable signal
   * (null) counts as not-true — fail closed — and is reported separately so the screen can explain.
   * A profile with neither clause matches everybody and must set `isFallback`.
   */
  requires: { all?: readonly Signal[]; any?: readonly Signal[] };
  slots: ProfileSlots;
  /** No signal available today can satisfy `requires`. Declared, never matched, waiting on `blockedOn`. */
  unresolvableToday?: boolean;
  /** The last profile in the list, matching anybody who reached it. Exactly one may set this. */
  isFallback?: boolean;
  /** What has to exist before this profile becomes reachable, or becomes more than a proxy. */
  blockedOn?: readonly string[];
  /** Things a reader might expect on this screen that have no data source. Rendered as an honest note. */
  absent?: readonly string[];
  notes?: string;
}

/**
 * THE REGISTRY. Ordered, first match wins, evaluated top to bottom by resolveProfile().
 *
 * The order is a policy statement and is the only place precedence is written down:
 *   1. ENGAGEMENT BEFORE EVERYTHING. An intern is an intern whatever else the account holds — this
 *      is the whole reason the workforce registry exists, and it is what stops a credit-hours bar
 *      appearing on a founder's screen and what keeps it on an intern's.
 *   2. THE WILDCARD NEXT, because ctx.holds() is wildcard-aware and every capability signal below
 *      would otherwise match the founder first (see the warning above matchSignal).
 *   3. FUNCTION AND CAPABILITY PROFILES, most specific mandate first.
 *   4. RELATIONSHIP PROFILES.
 *   5. THE FLOOR: an individual contributor with an employee record, then a signed-in account with
 *      no record at all — which is the ordinary state for a founder or an HR account, not an error.
 */
export const DASHBOARD_PROFILES: readonly DashboardProfile[] = [
  // ------------------------------------------------------------------ 1. Intern
  {
    key: 'intern',
    label: 'Internship workspace',
    because: 'You are on an internship.',
    requires: { all: [{ kind: 'engagement', value: 'internship' }] },
    slots: {
      attention: ['attention.queue'],
      primary: ['credit.position', 'tasks.mine', 'clock.today'],
      secondary: ['attendance.month', 'credit.weeksLeft', 'timelog.today', 'leave.mine'],
      quiet: ['dailyreport.today', 'manager.card', 'onboarding.docs', 'groups.mine'],
    },
    blockedOn: [
      'mentor-of: no mentor table exists, so the mentor card the brief asks for cannot be built. manager.card is the REPORTING MANAGER and is titled as such.',
      'assigned learning: training_enrollments has no assigned_by, due_at or required column, so no learning widget is registered to place.',
    ],
    absent: ['assigned learning', 'mentor'],
    notes:
      'This is the existing /portal/employee, unchanged in behaviour and now scoped to the people it ' +
      'was designed for. credit.position keeps its honest null — "no credit-hour requirement recorded", ' +
      'never "0% complete" — because zero and unknown are different facts. The brief asks for ' +
      'learning, assigned tasks, mentor, attendance and reports: tasks.mine, attendance.month and ' +
      'dailyreport.today are real; the other two are named above rather than faked.',
  },

  // ------------------------------------------------------------------ 2. Super Admin
  {
    key: 'platform-admin',
    label: 'Platform administration',
    because: 'Your account holds every permission on the platform.',
    requires: { all: [{ kind: 'every-permission' }] },
    slots: {
      attention: ['attention.queue'],
      primary: ['headcount.summary', 'hiring.pipeline', 'approvals.withdrawal'],
      secondary: ['approvals.leave', 'offers.pending', 'payroll.lastRun', 'audit.recent'],
      quiet: ['activity.feed', 'permissions.mine', 'hiring.openRoles', 'onboarding.review'],
    },
    notes:
      'THE CAPABILITY, NOT THE ROLE NAME. "Holds every permission" is how the account that holds ' +
      'everything is said without naming super_admin, and it is the same test activity.feed already ' +
      'requires in widgets.ts. Platform administration itself lives in /admin; these cards are the ' +
      'portal-side view and the doors to it, and every one of them carries its own admin.access ' +
      'requirement in the registry, so nothing here is reachable by a card alone. ' +
      'ORDERED SECOND ON PURPOSE — see the warning above matchSignal.',
  },

  // ------------------------------------------------------------------ 3. HR
  {
    key: 'people-ops',
    label: 'People workspace',
    because: 'You hold permissions over employee records.',
    requires: {
      any: [
        { kind: 'capability', key: 'employee.manage' },
        { kind: 'section', key: 'employees', action: 'edit' },
        { kind: 'department', anyOf: ['hr'] },
      ],
    },
    slots: {
      attention: ['attention.queue'],
      primary: ['approvals.leave', 'approvals.withdrawal', 'onboarding.review'],
      secondary: ['headcount.summary', 'hiring.pipeline', 'offers.pending', 'tasks.mine'],
      quiet: ['payroll.lastRun', 'requisitions.mine', 'hiring.openRoles', 'groups.mine'],
    },
    notes:
      'The brief asks for recruitment, employees, payroll and performance. The first three are placed ' +
      'as counts and queues; PERFORMANCE IS NOT, and that is deliberate — hr_performance_reviews has ' +
      'no exported reader and no aggregate, and the only per-person review surfaces belong to the ' +
      'person being reviewed. A people workspace showing one row per employee\'s review is the screen ' +
      'that must not exist on a dashboard. Every card here still carries its own section grant: an HR ' +
      'account without applications.view does not see hiring.pipeline, and the card is ABSENT rather ' +
      'than locked.',
    absent: ['performance overview'],
  },

  // ------------------------------------------------------------------ 4. Finance
  {
    key: 'finance',
    label: 'Money workspace',
    because: 'You hold permissions over payroll or payouts.',
    requires: {
      any: [
        { kind: 'capability', key: 'payroll.manage' },
        { kind: 'capability', key: 'payouts.pay' },
        { kind: 'capability', key: 'payouts.approve' },
        { kind: 'capability', key: 'payments.view' },
        { kind: 'section', key: 'payroll', action: 'view' },
        { kind: 'section', key: 'payouts', action: 'edit' },
      ],
    },
    slots: {
      attention: ['attention.queue'],
      primary: ['approvals.withdrawal', 'payroll.lastRun', 'wallet.balance'],
      secondary: ['payslips.mine', 'wallet.recent', 'bank.status', 'tasks.mine'],
      quiet: ['approvals.leave', 'groups.mine'],
    },
    absent: ['invoices', 'budget', 'revenue', 'runway'],
    notes:
      'THERE IS NO FINANCE ROLE IN THIS DATABASE. users.role has no such value; "finance" is an admin ' +
      'SECTION key plus the payments/payroll/payouts capabilities, which is exactly what this profile ' +
      'asks for. The brief asks for wallet, payroll, invoices and budget: the first two are real, and ' +
      'the last two have no table of any kind, so they are refused rather than mocked. The withdrawal ' +
      'queue shows counts and names only — the admin reader returns account numbers, IFSC and UPI ids ' +
      'UNMASKED, and none of that may enter a workspace card\'s render context. ' +
      'NO DEPARTMENT SIGNAL, DELIBERATELY: there is no finance department slug. The nearest is `legal` ' +
      '("Legal, Finance and Strategy", scripts/seed.ts:46), which also carries legal and strategy — ' +
      'putting a lawyer on a money workspace because they share a slug with the finance team would be ' +
      'the same guess this file exists to refuse. Money access is asked for as a capability, which is ' +
      'what the writes already enforce.',
  },

  // ------------------------------------------------------------------ 5. Executive
  {
    key: 'executive',
    label: 'Executive workspace',
    because: 'You are recorded in the executive function.',
    requires: { all: [{ kind: 'department', anyOf: ['exec'] }] },
    slots: {
      attention: ['attention.queue'],
      primary: ['headcount.summary', 'hiring.pipeline', 'approvals.withdrawal'],
      secondary: ['hiring.openRoles', 'offers.pending', 'approvals.leave', 'payroll.lastRun'],
      quiet: ['audit.recent', 'groups.mine'],
    },
    blockedOn: [
      'seniority: roles.level = C-Level is the structured executive signal and is not carried on WorkspaceContext — see PENDING_CONTEXT_FIELDS. Until it is, this profile is reachable only through the exec department slug, which has one writer and is null for anyone HR added by hand.',
    ],
    absent: ['revenue', 'runway', 'burn', 'organisation objectives'],
    notes:
      'REFUSED, EXPLICITLY: revenue, runway and burn. No finance table exists, and an executive ' +
      'dashboard with a fabricated revenue tile is worse than one without it. What IS placed is what ' +
      'the organisation can actually state about itself: headcount, the hiring pipeline, offers and ' +
      'the decisions waiting on a signature. ' +
      'DELIBERATELY ABSENT: credit.position and clock.today. An executive being shown a credit-hours ' +
      'progress bar is the reported failure this whole registry exists to fix; the clock controls stay ' +
      'fully available at /portal/employee and simply do not lead this screen. ' +
      'NOTE ON THE SLUG: `founders` is NOT an executive signal — it is the flagship intern programme, ' +
      'and its role catalogue is full of Intern-level roles. Rule 1 above catches those correctly.',
  },

  // ------------------------------------------------------------------ 6. Department Head
  {
    key: 'department-head',
    label: 'Department workspace',
    because: 'You are the recorded head of your department.',
    requires: { all: [{ kind: 'relationship', key: 'department-head-of-record' }] },
    unresolvableToday: true,
    slots: {
      attention: ['attention.queue'],
      primary: ['approvals.leave', 'tasks.team', 'attendance.team'],
      secondary: ['team.roster', 'reports.direct', 'headcount.summary', 'approvals.withdrawal'],
      quiet: ['onboarding.review', 'tasks.signoff', 'groups.mine'],
    },
    blockedOn: [
      'department-head-of-record: departments carries no head column in either schema. Needs departments.head_user_id, added with ADD COLUMN IF NOT EXISTS inside an ensureOnce() and backfilled from the existing (department_head, assigned_department_id) pairs.',
    ],
    notes:
      'DECLARED AND UNREACHABLE, ON PURPOSE. This profile never matches anybody today, because nothing ' +
      'in this database records who heads a department. It is written down so the shape is agreed and ' +
      'so the day head_user_id lands the change is one line — and it is NOT resolved by a role name, ' +
      'which is the only way it could have shipped as "working". Today a department head reaches the ' +
      'team-lead profile below through the capability proxy, which is a narrower and honest subset: ' +
      'one department they may query, rather than a department they are recorded as heading.',
  },

  // ------------------------------------------------------------------ 7. Team Lead
  {
    key: 'team-lead',
    label: 'Team workspace',
    because: 'You lead a department.',
    requires: { all: [{ kind: 'relationship', key: 'leads-department' }] },
    slots: {
      attention: ['attention.queue'],
      primary: ['tasks.team', 'tasks.signoff', 'approvals.leave'],
      secondary: ['team.roster', 'attendance.team', 'approvals.withdrawal', 'tasks.mine'],
      quiet: ['reports.direct', 'manager.card', 'groups.mine', 'onboarding.docs'],
    },
    blockedOn: [
      'leads-department is a PROXY, not the org fact — see RELATIONSHIPS. It becomes the real relationship when departments.head_user_id exists.',
    ],
    notes:
      'team.roster and attendance.team must render DEPARTMENT_COVERAGE_NOTICE ' +
      '(src/lib/auth/workspace-access.ts:166) beneath them, ALWAYS: hr_employees.department_id has ' +
      'exactly one writer, so anyone HR added by hand is invisible to every department list and a ' +
      'short list reads as a complete one. attendance.team reads hr_attendance only — never ' +
      'hr_clock_events for anybody but the signed-in person, which stores GPS, IP, device and a selfie ' +
      'per punch. A lead needs to know who was working, not where they were standing.',
  },

  // ------------------------------------------------------------------ 8. Manager
  {
    key: 'manager',
    label: 'Manager workspace',
    because: 'People report to you.',
    requires: { all: [{ kind: 'relationship', key: 'has-direct-reports' }] },
    slots: {
      attention: ['attention.queue'],
      primary: ['approvals.leave', 'approvals.withdrawal', 'reports.direct'],
      secondary: ['tasks.signoff', 'tasks.assignedByMe', 'tasks.mine', 'requisitions.mine'],
      quiet: ['onboarding.review', 'manager.card', 'groups.mine', 'onboarding.docs'],
    },
    blockedOn: [
      'department view: a manager with no department scope has no team surface. team.roster and attendance.team are NOT placed here, because departmentFilter() narrows on users.assigned_department_id and handing it hr_employees.department_id instead would be a new authorisation decision made by accident.',
    ],
    absent: ['department analytics', 'performance overview of reports'],
    notes:
      'THE MANAGER IS A RELATIONSHIP AND THIS PROFILE IS THE PROOF: it asks who reports to this ' +
      'person, never what they are called. The brief asks for department, approvals, performance and ' +
      'hiring; approvals and hiring are placed, the department is refused above, and PERFORMANCE OF ' +
      'REPORTS is refused for the same reason it is refused on the people workspace — a card that ' +
      'returns one row per person\'s review is not a dashboard card. reports.direct shows names and ' +
      'designations only: never gender, government ids, bank details or salary. ' +
      'AND THE EMPTY STATE MATTERS HERE MORE THAN ANYWHERE: reporting_manager_id is filled in only ' +
      'where HR has set it, so a real manager whose reports were never recorded does not reach this ' +
      'profile at all and lands on the floor. That is the correct failure, and the relationship\'s ' +
      'emptyState is the sentence that explains it.',
  },

  // ------------------------------------------------------------------ 9. Engineer
  {
    key: 'engineering',
    label: 'Engineering workspace',
    because: 'You are recorded in an engineering function.',
    requires: {
      all: [{ kind: 'employee-record' }],
      any: [{ kind: 'department', anyOf: ['ai', 'data', 'infra', 'product', 'dataengine', 'formdb'] }],
    },
    slots: {
      attention: ['attention.queue'],
      primary: ['tasks.mine', 'tasks.blocked', 'tasks.review'],
      secondary: ['tasks.signoff', 'tasks.assignedByMe', 'goals.mine', 'perf.mine'],
      quiet: ['manager.card', 'onboarding.docs', 'groups.mine', 'leave.mine'],
    },
    absent: ['projects', 'document library', 'deploys', 'incidents', 'review queues from a code host'],
    notes:
      'The brief asks for projects, tasks, documents and reviews. TASKS AND REVIEWS ARE REAL and lead ' +
      'the screen. PROJECTS DO NOT EXIST — no table, no column, no relation on employee_tasks — so no ' +
      'project card is placed and none may be invented from task groupings. DOCUMENTS means ' +
      'onboarding.docs, which is joining documents held as links; there is no company document ' +
      'library in this codebase. Deploys, incidents and pull-request queues would each need an ' +
      'outbound connector behind a swappable interface with a self-hostable default, which is a ' +
      'separate build and not a dashboard card. ' +
      'THE SIGNAL IS SPARSE, and that is why the department clause answers NULL rather than false when ' +
      'no department is recorded: an engineer HR added by hand falls through to the professional floor ' +
      'below, which is a correct screen for them, instead of being asserted not to be an engineer.',
  },

  // ------------------------------------------------------------------ 10. The floor, with a record
  {
    key: 'professional',
    label: 'Your workspace',
    because: 'This is your work.',
    requires: { all: [{ kind: 'employee-record' }] },
    slots: {
      attention: ['attention.queue'],
      primary: ['tasks.mine', 'tasks.dueToday', 'tasks.blocked'],
      secondary: ['clock.today', 'leave.mine', 'leave.balance', 'wallet.balance'],
      quiet: ['manager.card', 'goals.mine', 'onboarding.docs', 'groups.mine'],
    },
    notes:
      'THE FLOOR FOR ANYONE WITH AN EMPLOYEE RECORD, and it must stay a good screen rather than a ' +
      'leftover: most people land here, including everyone whose department, seniority or reporting ' +
      'line was never recorded. goals.mine closes a real gap — hr_employee_goals is written by HR and ' +
      'has no portal reader, so an employee cannot currently see their own objectives.',
  },

  // ------------------------------------------------------------------ 11. The floor, without one
  {
    key: 'signed-in',
    label: 'Your account',
    because: 'You are signed in.',
    requires: {},
    isFallback: true,
    slots: {
      attention: ['attention.queue'],
      primary: ['tasks.signoff', 'tasks.review', 'tasks.assignedByMe'],
      secondary: ['onboarding.docs', 'groups.mine', 'discussion.recent', 'huddle.active'],
      quiet: ['permissions.mine', 'legalhold.mine', 'wellness.entry'],
    },
    notes:
      'NOT AN ERROR STATE. This is the ordinary condition for a founder, an HR account or a senior ' +
      'reviewer with no hr_employees row of their own, and every widget here is scoped by users.id ' +
      'alone. A senior reviewer holds approver rights on tasks without an employee record, and those ' +
      'three cards are often the only work widgets they should see. The page must still render the ' +
      'composer\'s "ask HR to link your record" sentence — it is a one-line fix nobody can make if ' +
      'nobody says it.',
  },
];

const PROFILE_BY_KEY = new Map<ProfileKey, DashboardProfile>(DASHBOARD_PROFILES.map((p) => [p.key, p]));

export function getProfile(key: ProfileKey): DashboardProfile | null {
  return PROFILE_BY_KEY.get(key) || null;
}

// ---------------------------------------------------------------------------------------------
// RESOLUTION. Pure, synchronous, no database, no request, no throw.
// ---------------------------------------------------------------------------------------------

export interface ProfileMatch {
  key: ProfileKey;
  matched: boolean;
  /** A short clause naming what decided it. Diagnostics, never rendered to an ordinary reader. */
  why: string;
}

export interface ProfileResolution {
  profile: DashboardProfile;
  /** The clause the header renders. */
  because: string;
  /**
   * Relationships that SHOULD have been answerable and were not — a genuine per-request gap. RENDER
   * THIS: it is the difference between "nobody reports to you" and "we could not read who reports to
   * you", and this project has shipped the wrong sentence twice.
   */
  unresolvedRelationships: readonly RelationshipKey[];
  /**
   * Relationships that answered nothing because nothing in this database can answer them yet
   * (status 'blocked' or 'per-row'). DIAGNOSTICS ONLY — never a message to a reader. Every employee
   * would otherwise be told we cannot tell whether they head a department, which is true of everyone
   * and useful to no one; what it is waiting for is in BLOCKED_ON_ORG_GRAPH and in profile.blockedOn.
   */
  blockedRelationshipsConsulted: readonly RelationshipKey[];
  /** Every profile considered, in order, and why each was kept or dropped. Only when opts.explain. */
  explain?: readonly ProfileMatch[];
}

function describeSignal(s: Signal): string {
  switch (s.kind) {
    case 'employee-record': return 'employee record';
    case 'engagement': return 'engagement is ' + s.value;
    case 'capability': return 'holds ' + s.key;
    case 'every-permission': return 'holds every permission';
    case 'section': return 'section ' + s.key + ':' + s.action;
    case 'department': return 'department in ' + s.anyOf.join(', ');
    case 'relationship': return 'relationship ' + s.key;
    default: return 'unknown signal';
  }
}

/**
 * Which workspace this person gets, and why.
 *
 * FIRST MATCH WINS, top to bottom, and the last profile is the fallback — so this ALWAYS returns a
 * profile. There is no null, no "unknown workspace" and no blank screen: an unresolved context is the
 * composer's problem (it returns the minimal widget set, and layoutFor then arranges only that),
 * never a missing layout.
 */
export function resolveProfile(
  ctx: WorkspaceContext,
  opts: { explain?: boolean } = {},
): ProfileResolution {
  const explain: ProfileMatch[] = [];
  const unresolved = new Set<RelationshipKey>();
  const consultedBlocked = new Set<RelationshipKey>();

  const answer = (s: Signal): SignalAnswer => {
    const a = matchSignal(s, ctx);
    if (a === null && s.kind === 'relationship') {
      const status = RELATIONSHIP_BY_KEY.get(s.key)?.status;
      // A relationship nothing can answer is EXPECTED to answer nothing. Only a relationship that
      // should have worked and did not is a gap worth putting in front of a person.
      if (status === 'blocked' || status === 'per-row') consultedBlocked.add(s.key);
      else unresolved.add(s.key);
    }
    return a;
  };

  const result = (profile: DashboardProfile): ProfileResolution => ({
    profile,
    because: profile.because,
    unresolvedRelationships: [...unresolved],
    blockedRelationshipsConsulted: [...consultedBlocked],
    ...(opts.explain ? { explain } : {}),
  });

  for (const profile of DASHBOARD_PROFILES) {
    if (profile.isFallback) {
      if (opts.explain) explain.push({ key: profile.key, matched: true, why: 'fallback' });
      return result(profile);
    }

    const all = profile.requires.all || [];
    const any = profile.requires.any || [];

    let ok = true;
    let why = '';

    for (const s of all) {
      const a = answer(s);
      if (a !== true) {
        ok = false;
        why = (a === null ? 'cannot answer: ' : 'not: ') + describeSignal(s);
        break;
      }
    }

    if (ok && any.length > 0) {
      const hit = any.find((s) => answer(s) === true);
      if (!hit) {
        ok = false;
        why = 'none of: ' + any.map(describeSignal).join(' / ');
      } else {
        why = describeSignal(hit);
      }
    } else if (ok && all.length > 0) {
      why = all.map(describeSignal).join(' and ');
    }

    if (opts.explain) explain.push({ key: profile.key, matched: ok, why: why || 'no requirements' });
    if (ok) return result(profile);
  }

  // Unreachable while exactly one profile sets isFallback — which validateDashboardConfig() asserts.
  // Returning the last profile rather than throwing: a workspace must never be taken down by this file.
  return result(DASHBOARD_PROFILES[DASHBOARD_PROFILES.length - 1]);
}

export interface ResolvedDashboard {
  profile: DashboardProfile;
  because: string;
  /** Widget keys per slot, in render order, INTERSECTED with what the composer granted. */
  slots: Record<SlotName, string[]>;
  /** Placed by the profile and NOT granted by the composer. Diagnostics — never rendered as a lock. */
  dropped: string[];
  /**
   * Granted by the composer and not placed by this profile. They must still be REACHABLE — render
   * them below the designed slots. A layout silently swallowing something the composer granted is the
   * same defect as a second engine deciding what a person sees.
   */
  unplaced: string[];
  /** Should have been answerable and was not. Say so on screen; do not print an empty result over it. */
  unresolvedRelationships: readonly RelationshipKey[];
  /** Nothing can answer these yet. Diagnostics only — see ProfileResolution. */
  blockedRelationshipsConsulted: readonly RelationshipKey[];
  /** Copied from the profile so a page can render one honest note without importing the registry. */
  blockedOn: readonly string[];
  absent: readonly string[];
}

/**
 * The arranged dashboard: this person's profile, its slots, and NOTHING the composer did not grant.
 *
 * @param eligible the widget keys composeWorkspace() returned — the ONLY source of what may appear.
 *
 * THE INVARIANT, and the reason this function is three lines of set arithmetic rather than a
 * renderer: the output is a subset of `eligible`, always. This file cannot widen a workspace by a
 * typo, by an edit, or by a profile naming a widget somebody was never entitled to. Eligibility is
 * resolved before any loader runs; this runs after both, and it only ever removes and orders.
 */
export function layoutFor(
  ctx: WorkspaceContext,
  eligible: Iterable<string>,
  opts: { explain?: boolean } = {},
): ResolvedDashboard {
  const granted = new Set<string>();
  for (const key of eligible) granted.add(key);

  const resolution = resolveProfile(ctx, opts);
  const profile = resolution.profile;

  const slots: Record<SlotName, string[]> = { attention: [], primary: [], secondary: [], quiet: [] };
  const dropped: string[] = [];
  const placed = new Set<string>();

  const place = (slot: SlotName, keys: readonly string[]): void => {
    for (const key of keys) {
      if (placed.has(key)) continue;      // a widget appears once, whatever two slots claim it
      if (!granted.has(key)) { dropped.push(key); placed.add(key); continue; }
      slots[slot].push(key);
      placed.add(key);
    }
  };

  place('attention', profile.slots.attention);
  place('primary', profile.slots.primary);
  place('secondary', profile.slots.secondary);
  // The profile's own quiet keys first, then the universal baseline — the floor no profile may
  // remove, appended rather than declared so it cannot be forgotten or edited out.
  place('quiet', profile.slots.quiet);
  place('quiet', UNIVERSAL_BASELINE.quiet);

  const unplaced: string[] = [];
  for (const key of granted) if (!placed.has(key)) unplaced.push(key);
  unplaced.sort();
  dropped.sort();

  return {
    profile,
    because: resolution.because,
    slots,
    dropped,
    unplaced,
    unresolvedRelationships: resolution.unresolvedRelationships,
    blockedRelationshipsConsulted: resolution.blockedRelationshipsConsulted,
    blockedOn: profile.blockedOn || [],
    absent: profile.absent || [],
  };
}

/**
 * The honest sentence for a relationship that answered false or could not be answered, so a surface
 * never prints "you manage nobody" over a question this database cannot ask. Returns null when the
 * relationship resolved true, and null for an unknown key.
 */
export function relationshipEmptyState(key: RelationshipKey, ctx: WorkspaceContext): string | null {
  const rel = RELATIONSHIP_BY_KEY.get(key);
  if (!rel) return null;
  let answered: SignalAnswer;
  try {
    answered = rel.resolve(ctx);
  } catch {
    answered = null;
  }
  return answered === true ? null : rel.emptyState;
}

// ---------------------------------------------------------------------------------------------
// SELF-CHECK. Returns problems rather than throwing, exactly as validateRegistry() does in
// widgets.ts: a malformed layout must not be able to take a workspace down, and this is precisely the
// class of mistake that otherwise shows up as one card mysteriously never appearing.
// ---------------------------------------------------------------------------------------------

export function validateDashboardConfig(
  profiles: readonly DashboardProfile[] = DASHBOARD_PROFILES,
): string[] {
  const problems: string[] = [];
  const seenKey = new Set<string>();
  const relKeys = new Set<string>(RELATIONSHIPS.map((r) => r.key));
  let fallbacks = 0;

  for (const key of [...UNIVERSAL_BASELINE.attention, ...UNIVERSAL_BASELINE.quiet]) {
    if (!getWidget(key)) problems.push('universal baseline names unknown widget: ' + key);
  }

  for (const p of profiles) {
    if (!p.key) { problems.push('a profile has no key'); continue; }
    if (seenKey.has(p.key)) problems.push('duplicate profile key: ' + p.key);
    seenKey.add(p.key);

    if (!p.label) problems.push(p.key + ': no label');
    if (!p.because) problems.push(p.key + ': no `because` clause — a workspace must be able to say why it chose itself');

    if (p.isFallback) fallbacks++;

    const all = p.requires.all || [];
    const any = p.requires.any || [];
    if (all.length === 0 && any.length === 0 && !p.isFallback) {
      problems.push(p.key + ': no requirements and not the fallback — it would match everybody');
    }

    // A profile may only require a relationship that is declared, or nothing can explain its empty
    // state and nothing can list what it is waiting for.
    for (const s of [...all, ...any]) {
      if (s.kind === 'relationship' && !relKeys.has(s.key)) {
        problems.push(p.key + ': requires undeclared relationship ' + s.key);
      }
    }

    // An unreachable profile must SAY what it is waiting for, or it reads as a bug rather than a
    // recorded dependency.
    const requiresBlocked = [...all, ...any].some((s) => {
      if (s.kind !== 'relationship') return false;
      const status = RELATIONSHIP_BY_KEY.get(s.key)?.status;
      return status === 'blocked' || status === 'per-row';
    });
    if (requiresBlocked && !p.unresolvableToday) {
      problems.push(p.key + ': requires a blocked relationship but is not marked unresolvableToday');
    }
    if (p.unresolvableToday && (p.blockedOn || []).length === 0) {
      problems.push(p.key + ': marked unresolvableToday with no blockedOn reason');
    }

    // Slots.
    const seenInProfile = new Set<string>();
    for (const slot of SLOT_ORDER) {
      const keys = p.slots[slot] || [];
      if (keys.length > SLOT_CAPS[slot]) {
        problems.push(p.key + ': ' + slot + ' holds ' + keys.length + ', cap is ' + SLOT_CAPS[slot]);
      }
      for (const key of keys) {
        if (!getWidget(key)) problems.push(p.key + ': ' + slot + ' names unknown widget ' + key);
        if (seenInProfile.has(key)) problems.push(p.key + ': names ' + key + ' in more than one slot');
        seenInProfile.add(key);
      }
    }

    // The attention slot is the universal baseline's, exactly: one card, and that card.
    const attention = p.slots.attention || [];
    if (attention.length !== 1 || attention[0] !== UNIVERSAL_BASELINE.attention[0]) {
      problems.push(p.key + ': attention must be exactly [' + UNIVERSAL_BASELINE.attention[0] + ']');
    }

    // NO NAV CHECK, because this file declares no navigation. See the note above ProfileKey:
    // src/lib/workforce/navigation.ts is the one authority for doors, derived from the same
    // composition, and a second list of tabs here is the duplication that must not exist.
  }

  if (fallbacks !== 1) {
    problems.push('exactly one profile must set isFallback; found ' + fallbacks);
  }
  const last = profiles[profiles.length - 1];
  if (last && !last.isFallback) {
    problems.push('the fallback profile must be last, or the profiles after it are unreachable');
  }

  return problems;
}

/**
 * Computed once at module load and LOGGED, never thrown — the same decision composer.ts makes about
 * the widget registry, and for the same reason: a duplicate key or a mistyped widget name must not be
 * able to take a person's workspace down. (The master spec asks for a build failure here. A build
 * failure is the better signal and costs nothing at author time, but it is not worth a 500 for a
 * reader, so the problems are exported for a diagnostics surface and for a test to assert empty.)
 */
export const DASHBOARD_CONFIG_PROBLEMS: readonly string[] = validateDashboardConfig();
if (DASHBOARD_CONFIG_PROBLEMS.length > 0) {
  console.error('[workforce/dashboard-config] problems: ' + DASHBOARD_CONFIG_PROBLEMS.join('; '));
}
