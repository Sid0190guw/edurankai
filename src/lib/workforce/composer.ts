// src/lib/workforce/composer.ts — decides WHICH widgets a person gets, once per request.
//
// THE ONE JOB. src/lib/workforce/widgets.ts says what each widget needs. This file resolves what
// this person HAS — their engagement, their department, their permissions, whether anybody reports
// to them, whether they can decide an approval — and returns the widgets whose conditions are met,
// in order. No page decides this again, and no page is allowed to: the moment two surfaces answer
// "what should this person see", they answer it differently within a month, and the one that answers
// it too generously is the one nobody notices.
//
// FIVE THINGS THIS FILE IS RESPONSIBLE FOR, AND THE REASON FOR EACH.
//
//   1. IT RESOLVES THE CONTEXT ONCE. Three reads, at most: the employee record (requireEmployee),
//      the permission set (resolvePermissions) and a count of direct reports. Widgets receive facts,
//      never a database handle, so fifty widget definitions cost no queries at all.
//
//   2. IT ASKS FOR CAPABILITIES, NEVER FOR ROLE NAMES. widgets.ts cannot test a role — the context
//      has no `role` field — and neither can this file any more: `leadsDepartment` and
//      `seesEveryRequest` are resolved through holdsCapability(), the same test the workspace gates
//      enforce with, so a card and the query behind it cannot answer differently. What they replaced
//      was string equality against role names, which was already the careful version;
//      `role.indexOf('hr') >= 0` in the original let any role merely CONTAINING those two letters
//      approve leave and withdrawals. At 1100+ admin-created roles that is a matter of spelling, and
//      approval authority must never depend on spelling.
//
//   3. IT FAILS CLOSED, TOWARD THE MINIMAL SET. An unresolvable context yields MINIMAL_WIDGETS —
//      the widgets scoped by users.id alone — and never the full registry. Every other gate in this
//      codebase fails in the same direction for the same reason: an under-shown workspace costs one
//      message to HR, and an over-shown one hands somebody another person's work, silently, with no
//      way for either of them to notice.
//
//   4. IT REPORTS WHAT DID NOT ANSWER. `contextGaps` names the sources that failed, so a page can
//      say "we could not read who reports to you" instead of rendering a confident empty screen. An
//      empty bucket and a failed read are different sentences. This project has shipped the wrong
//      one twice.
//
//   5. IT CACHES PER REQUEST AND NEVER PER PROCESS. The memo lives on Astro.locals, exactly like
//      resolvePermissions'. A module-scoped cache in a long-lived server is how one person's
//      workspace ends up rendered for another, and it is also how "we changed their role an hour
//      ago" quietly becomes false. It must be true the moment it is said.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { requireEmployee, type Workspace, type WorkspaceUser } from '@/lib/auth/workspace-access';
import { leadsDepartment as holdsDepartmentLead, decidesEveryRequest } from '@/lib/auth/capability';
import { resolvePermissions, holdsPermission, WILDCARD } from '@/lib/auth/registry';
import { canAccessSection } from '@/lib/auth/permissions';
import {
  WIDGETS, MINIMAL_WIDGETS, HOLDS_EVERY_PERMISSION, byPriority, validateRegistry,
  type WidgetDefinition, type WorkspaceContext, type Engagement, type SectionRequirement, type WidgetGate,
  type WidgetQuickAction,
} from '@/lib/workforce/widgets';

// postgres-js resolves to a plain array, never a { rows } object. Declared at the top, above
// everything that uses it: `const` is not hoisted, and a handler reaching a later declaration has
// taken pages down in this repo before.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const logFail = (tag: string, e: any) => console.error('[workforce/composer] ' + tag, e?.cause?.message || e?.message);

/**
 * COMPILE-TIME GUARD. widgets.ts declares the wildcard as its own literal so it can stay free of
 * src/lib/auth/registry.ts, which imports the database — a registry of data should be readable and
 * testable without one. This annotation is what keeps the two in step: if WILDCARD is ever renamed
 * or changed, this line fails to compile instead of silently granting nothing to nobody.
 *
 * Exported rather than dropped in as a dead local, so a diagnostics surface can show it and so no
 * tidy-up mistakes the guard for unused code.
 */
export const REGISTRY_WILDCARD: typeof WILDCARD = HOLDS_EVERY_PERMISSION;

/**
 * Structural problems in the registry, computed once at module load. Logged rather than thrown: a
 * duplicate key or a missing title must not be able to take a workspace down, and this is exactly
 * the class of mistake that otherwise shows up as one widget mysteriously never appearing.
 */
const REGISTRY_PROBLEMS = validateRegistry();
if (REGISTRY_PROBLEMS.length > 0) {
  console.error('[workforce/composer] widget registry problems: ' + REGISTRY_PROBLEMS.join('; '));
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

export type ComposeReason =
  /** Everything resolved. */
  | 'ok'
  /** Signed in, and no hr_employees row is linked. NOT an error: the ordinary state for a founder or
   *  an HR account. The composition is still trustworthy — the person simply has no employee-scoped
   *  widgets, which is the correct answer rather than a degraded one. */
  | 'no-employee-record'
  | 'not-signed-in'
  /** The record exists and is closed (offboarded or deactivated). */
  | 'record-closed'
  /** More than one employee record carries this email address. We refuse to guess. */
  | 'ambiguous-record'
  /** The lookup itself did not run. */
  | 'lookup-failed';

export interface ComposedWorkspace {
  /** The widget list can be trusted. True for 'ok' and 'no-employee-record'; false for everything
   *  else, where `widgets` is the minimal set. */
  ok: boolean;
  reason: ComposeReason;
  /** Something did not answer. The page must not print a confident "you have nothing" over this. */
  degraded: boolean;
  /** A heading and a calm sentence a person can act on, straight from the gate that refused. Render
   *  it: a blank workspace with no explanation reads as "you have done no work". */
  denial: { title: string; reason: string; redirect: string | null } | null;
  context: WorkspaceContext;
  /** Ordered by priority. Eligibility only — whether a widget has anything to SAY is the loader's
   *  answer, and `hideWhenEmpty` says which ones should then render nothing at all. */
  widgets: readonly WidgetDefinition[];
  /**
   * WHAT THIS PERSON CAN DO RIGHT NOW — derived from `widgets` above and from nothing else.
   *
   * It is not a second list and it must never become one. Every entry is the `quickAction` declared
   * on a widget that ALREADY PASSED every permission, section, audience and gate check, in the same
   * priority order, so an action can never be offered to somebody the composer did not admit to the
   * widget behind it. That is precisely the defect in the two hand-written arrays this replaces:
   * BottomNav.astro:115 and portal/index.astro:416 are static and test nothing at all.
   *
   * A page renders these; a page does not append to them.
   */
  quickActions: readonly QuickAction[];
  /** Named sources that did not answer, in words a person can read. */
  contextGaps: readonly string[];
  /** The employee record, for a page that needs the name, code or photo. Null when none resolved. */
  workspace: Workspace | null;
  /** Only when opts.explain — every registered widget and why it was kept or dropped. For a
   *  diagnose surface; never rendered to an ordinary reader. */
  explain?: readonly { key: string; kept: boolean; why: string }[];
}

/** A quick action, plus the widget key it came from — so a surface can trace any button back to the
 *  eligibility decision that produced it, and so React-style list keys are stable. */
export interface QuickAction extends WidgetQuickAction {
  key: string;
}

/**
 * Derive the action row from an already-filtered widget list.
 *
 * Deduplicated on href: leave.mine and a future leave widget both pointing at
 * /portal/employee/leave must not produce the same button twice. First one wins, so the priority
 * order decides which label survives.
 */
function quickActionsOf(widgets: readonly WidgetDefinition[]): QuickAction[] {
  const out: QuickAction[] = [];
  const seen = new Set<string>();
  for (const w of widgets) {
    const qa = w.quickAction;
    if (!qa || !qa.href || !qa.label) continue;
    if (seen.has(qa.href)) continue;
    seen.add(qa.href);
    out.push({ key: w.key, label: qa.label, href: qa.href, icon: qa.icon });
  }
  return out;
}

export interface ComposeOptions {
  /** Pass Astro.locals wherever you have it. It carries the per-request memo for this composition
   *  AND for resolvePermissions, so a page that composes twice pays for one. */
  locals?: any;
  /** Where to return after login, for the not-signed-in redirect. */
  next?: string;
  /** Produce the `explain` trail. Off by default: it is diagnostics, not a render input. */
  explain?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Per-request memo. Same shape and the same reasoning as registry.ts memoOf().
// ---------------------------------------------------------------------------------------------

function memoOf(locals: any): Map<string, Promise<ComposedWorkspace>> | null {
  if (!locals || typeof locals !== 'object') return null;
  // Wrapped because this is the one statement here that WRITES to an object it did not create. A
  // frozen or proxied `locals` throws on assignment, and an exception escaping the function that
  // decides a workspace is not a denial — it is a 500 whose meaning the caller has to guess. Losing
  // the memo costs a few queries, not a decision.
  try {
    if (!locals.__workforceComposeMemo) locals.__workforceComposeMemo = new Map<string, Promise<ComposedWorkspace>>();
    const memo = locals.__workforceComposeMemo;
    return memo instanceof Map ? memo : null;
  } catch {
    return null;
  }
}

/** Drop a memoised composition — call after changing a role, a department or a grant mid-request. */
export function invalidateWorkspace(locals: any, userId?: string): void {
  const memo = memoOf(locals);
  if (!memo) return;
  if (userId) memo.delete('u:' + userId); else memo.clear();
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

/**
 * How many active people name this account as their reporting manager.
 *
 * reporting_manager_id holds a USERS id, not an hr_employees id — the same comparison
 * pendingLeaveForApprover() and approverRole() make. Joining it to hr_employees.id matches zero rows
 * and reads as "nobody reports to you" rather than erroring, which is the most likely implementation
 * error in this codebase.
 *
 * Compared as ::text deliberately: the column is UUID where it exists, but it is ALTERed in by only
 * two admin pages at page load, so on a database where neither has been opened it is absent
 * entirely. Returns null — NOT zero — when the read did not happen, so the caller can say so.
 */
/**
 * TODAY, AS THE DATABASE COUNTS IT — plus how many people report to this account, and the pointer to
 * whoever this account reports to.
 *
 * THE ID-SPACE TRAP, and it is the most likely implementation error in this codebase:
 * reporting_manager_id holds a USERS id, not an hr_employees id — the same comparison
 * pendingLeaveForApprover() and approverRole() make. Joining it to hr_employees.id matches zero rows
 * and reads as "nobody reports to you" rather than erroring. Both uses below compare it as ::text
 * deliberately: the column is UUID where it exists, and this schema also carries slug keys that
 * ::uuid would throw on.
 *
 * ONE ROUND TRIP FOR ALL THREE, and they are together for a reason rather than by accident. This
 * replaces countDirectReports(), which was its own query, and it absorbs two more that
 * /portal/employee was already paying for separately (employee.astro:384 for the date, :505 for the
 * pointer). So the request makes FEWER queries than before, not more — and the page can no longer
 * disagree with the composer about what day it is.
 *
 * NULL MEANS "DID NOT ANSWER", NEVER "IS NOT SET" for the date: a guessed today is an off-by-one on
 * every "due today" claim on the screen. The manager pointer legitimately IS null for most people,
 * so a failed read and an unset column are the same value there — which is safe, because
 * manager.card's empty branch and its failure branch say the same actionable sentence ("ask HR to
 * set your reporting manager").
 *
 * reporting_manager_id is ALTERed in by only two admin pages at page load, so on a database where
 * neither has been opened the column does not exist and this statement throws as a whole. The
 * fallback re-asks for the date alone, so a missing column costs the manager pointer and the report
 * count — never the date, and never the page.
 */
async function readDayAndManager(
  userId: string,
  employeeId: string | null,
): Promise<{ today: string | null; reports: number | null; managerUserId: string | null }> {
  const empId = String(employeeId || '').trim();
  try {
    const r = await db.execute(sql`
      SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
             (SELECT COUNT(*)::int FROM hr_employees
               WHERE reporting_manager_id::text = ${userId} AND is_active = true) AS reports,
             ${empId
               ? sql`(SELECT m.reporting_manager_id::text FROM hr_employees m WHERE m.id::text = ${empId} LIMIT 1)`
               : sql`NULL::text`} AS manager_user_id`);
    const row = rows(r)[0] || {};
    const n = Number(row.reports);
    return {
      today: row.today ? String(row.today) : null,
      reports: Number.isFinite(n) ? n : 0,
      managerUserId: row.manager_user_id ? String(row.manager_user_id) : null,
    };
  } catch (e: any) {
    logFail('day + manager', e);
    let today: string | null = null;
    try {
      const d = await db.execute(sql`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
      today = rows(d)[0]?.today ? String(rows(d)[0].today) : null;
    } catch (e2: any) {
      logFail('current date', e2);
    }
    return { today, reports: null, managerUserId: null };
  }
}

function emptyContext(userId: string): WorkspaceContext {
  const permissions: ReadonlySet<string> = new Set<string>();
  const sections: ReadonlySet<string> = new Set<string>();
  return {
    userId,
    employeeId: null,
    hasEmployeeRecord: false,
    engagement: 'unknown',
    departmentId: null,
    departmentName: null,
    scopeDepartmentId: null,
    directReports: 0,
    managesPeople: false,
    approvesRequests: false,
    holds: () => false,
    permissions,
    sections,
    grantedSection: () => false,
    today: null,
    reportingManagerUserId: null,
  };
}

// ---------------------------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------------------------

/**
 * Everything this person should see on their workspace, and the context it was decided from.
 *
 * Call it once, as the first await of the frontmatter, above the POST handler — `const` is not
 * hoisted, and a handler reaching a later declaration throws on its first line while the page still
 * reports success. That is what broke apply step 5 and the /admin/roles/diagnose Repair button.
 */
export async function composeWorkspace(
  user: WorkspaceUser | null | undefined,
  opts: ComposeOptions = {},
): Promise<ComposedWorkspace> {
  const userId = String(user?.id || '').trim();

  if (!userId) {
    const next = opts.next || '/portal/employee';
    return {
      ok: false,
      reason: 'not-signed-in',
      degraded: false,
      denial: {
        title: 'Please sign in',
        reason: 'Your workspace shows your own record, so it needs you signed in.',
        redirect: '/portal/login?next=' + encodeURIComponent(next),
      },
      context: emptyContext(''),
      // Not the minimal set. Nobody is signed in, so there is no "own rows" to scope even that to.
      widgets: [],
      quickActions: [],
      contextGaps: [],
      workspace: null,
    };
  }

  const memo = memoOf(opts.locals);
  const memoKey = 'u:' + userId + (opts.explain ? ':x' : '');
  const cached = memo?.get(memoKey);
  if (cached) return cached;

  const work = compose(user as WorkspaceUser, userId, opts);
  memo?.set(memoKey, work);
  return work;
}

async function compose(
  user: WorkspaceUser,
  userId: string,
  opts: ComposeOptions,
): Promise<ComposedWorkspace> {
  const contextGaps: string[] = [];
  let degraded = false;

  // ---- 1. The employee record ----------------------------------------------------------------
  //
  // requireEmployee() rather than resolveWorkspace(): resolveWorkspace collapses "there is genuinely
  // no record" and "the query did not run" into the same null, and those two must lead to different
  // screens. One is a founder with no HR row, who should still get their permissioned widgets. The
  // other is a database that blinked, where showing anything scoped is a guess.
  let gate: Awaited<ReturnType<typeof requireEmployee>>;
  try {
    gate = await requireEmployee(user, opts.next || '/portal/employee');
  } catch (e: any) {
    // requireEmployee already fails closed on its own errors; this catches anything it could not.
    logFail('requireEmployee', e);
    gate = {
      ok: false, workspace: null, scopeDepartmentId: null, code: 'lookup-failed',
      title: 'We could not load your workspace just now',
      reason: 'Something went wrong reading your record. Nothing you have logged is lost. Try again in a moment, and tell HR if it keeps happening.',
      redirect: null,
    };
  }

  const workspace: Workspace | null = gate.ok ? gate.workspace : null;
  const denial = gate.ok ? null : { title: gate.title, reason: gate.reason, redirect: gate.redirect };

  let reason: ComposeReason = 'ok';
  let trustworthy = true;
  if (!gate.ok) {
    switch (gate.code) {
      case 'no-employee-record':
        // NOT a failure. The person is signed in and has no HR row; every widget that needs an
        // employeeId simply does not apply to them, and the permissioned ones still do.
        reason = 'no-employee-record';
        break;
      case 'inactive':
        reason = 'record-closed';
        trustworthy = false;
        break;
      case 'ambiguous-record':
        reason = 'ambiguous-record';
        trustworthy = false;
        break;
      case 'lookup-failed':
        reason = 'lookup-failed';
        trustworthy = false;
        degraded = true;
        contextGaps.push('your employee record');
        break;
      default:
        // requireEmployee returns no other code today. An unrecognised denial is still a denial.
        reason = 'lookup-failed';
        trustworthy = false;
        degraded = true;
        contextGaps.push('your employee record');
        break;
    }
  }

  // ---- 2. Permissions -------------------------------------------------------------------------
  //
  // resolvePermissions fails closed by contract: an empty set with degraded=true. An empty set and a
  // failed lookup produce the same widget list here (permissioned widgets drop out), which is
  // correct — but they must NOT produce the same sentence on screen, so the gap is named.
  let permissions: ReadonlySet<string> = new Set<string>();
  let holds = (_key: string): boolean => false;
  try {
    const resolved = await resolvePermissions(userId, { locals: opts.locals });
    if (resolved.degraded) {
      degraded = true;
      contextGaps.push('what you are allowed to do');
    } else {
      permissions = resolved.permissions;
    }
    // Wildcard-aware, always. A super_admin holds '*' and answers false to a bare .has('users.edit').
    holds = (key: string) => holdsPermission(resolved, key);
  } catch (e: any) {
    logFail('resolvePermissions', e);
    degraded = true;
    contextGaps.push('what you are allowed to do');
  }

  // ---- 3. Capabilities. NO ROLE NAME IS COMPARED IN THIS FILE ANY MORE. -------------------------
  //
  // These were `role === 'department_head'` and `role === 'super_admin' || 'admin' || 'hr'`, written
  // out here rather than read off the Workspace object for one reason that still holds: the
  // Workspace is null precisely for the people these flags exist to serve — an HR account or a
  // founder with no hr_employees row of their own — so reading isHr off a null object would hand
  // them the narrowest screen in the product. What has changed is WHAT is written out: the same
  // holdsCapability() the gates enforce with, so the card shown here and the query behind it cannot
  // answer differently.
  //
  // `role` survives for exactly one use, at step 8: canAccessSection() takes an actor and resolves
  // the legacy section matrix itself. It is not compared to anything here.
  const role = String(user.role || '').trim().toLowerCase();

  // The team-lead signal, and the whole of it: 'department.lead' — held by department_head and by
  // nobody else — plus users.assigned_department_id, written together by /admin/users.
  // hr_employees.reporting_manager_id is a different question (below) and answers "who approves for
  // whom", not "who leads what".
  const engagement: Engagement = workspace
    ? (workspace.isIntern ? 'internship' : 'employment')
    : 'unknown';
  // An intern is never a team lead, whatever else the account says — the same refusal
  // requireTeamLead() makes, and a per-PERSON condition the capability neither carries nor replaces.
  //
  // THE RULE IS NO LONGER WRITTEN HERE. It was
  // `holdsCapability(user, 'department.lead') && engagement !== 'internship'` — a second, separately
  // written copy of what requireTeamLead() enforces. Both call leadsDepartment() in
  // src/lib/auth/capability.ts now. `engagement !== 'internship'` is exactly
  // `!(workspace && workspace.isIntern)`, which is what passing `workspace` gives: null and
  // undefined both mean "not resolved" and are treated as NOT an internship, as they were here.
  const leadsDepartment = holdsDepartmentLead(user, workspace);
  const scopeDepartmentId = leadsDepartment
    ? (workspace?.scopeDepartmentId || String(user.assignedDepartmentId || '').trim() || null)
    : null;

  // ---- 4. The day, the reporting line, and who reports to this account --------------------------
  //
  // Not run at all when the context is untrustworthy: the fail-closed return below hands back the
  // minimal set regardless, and reading on behalf of somebody whose own record could not be resolved
  // is a read that should never have happened.
  const day = trustworthy
    ? await readDayAndManager(userId, workspace?.employeeId ?? null)
    : { today: null, reports: null, managerUserId: null };
  if (trustworthy && day.reports === null) {
    degraded = true;
    contextGaps.push('who reports to you');
  }
  // NOT added to contextGaps as a failure sentence people read: "we could not read today's date" is
  // not something a person can act on, and every widget that partitions on the day withholds its
  // day-partitioned rows on its own when ctx.today is null. It is still logged, above.
  const directReports = day.reports ?? 0;

  // ---- 4b. THE SAME QUESTION, ASKED OF THE LAYER THAT OWNS IT ---------------------------------
  //
  // directReports above is hr_employees.reporting_manager_id — a COLUMN. The Organization Graph is
  // the layer that answers who reports to whom, and a manager whose team exists only as graph edges
  // counted as ZERO here: no direct-reports card, and nothing anywhere on their workspace admitted
  // that people report to them. That is the reverse of the fault manager.card was fixed for.
  //
  // ASKED ONLY WHEN THE COLUMN SAID NOTHING, so this costs one indexed query for the people it can
  // change the answer for and none at all for a manager the column already names. getDirectReports()
  // is the sanctioned reader (relationships come from src/lib/org-graph.ts and from nowhere else) and
  // it fails closed to an empty array, so a graph that will not answer leaves the column's answer
  // standing rather than replacing it with a worse one.
  //
  // A FAILED GRAPH READ IS NAMED, and this is the half that was missing. The catch below logged and
  // moved on, so a manager whose graph read threw got graphReports = 0, managesPeople = false, no
  // reports.direct widget — and a workspace that said nothing at all about it. Silently withholding a
  // card is the same class of mistake as silently showing one: the person cannot tell "you lead
  // nobody" from "we could not find out", and only the first of those is a statement about them.
  //
  // WORDED AS THE GRAPH, NOT AS THE PERSON. contextGaps sentences are read aloud on the workspace, so
  // this one names the layer that did not answer rather than implying anything about who reports to
  // whom. loaders.ts keeps the same distinction one level down: 'graph-empty' means the Organization
  // Graph is not initialized and says NOTHING about this person, and only 'none' is a fact about them.
  let graphReports = 0;
  if (trustworthy && directReports === 0 && workspace?.employeeId) {
    try {
      const { getDirectReports } = await import('@/lib/org-graph');
      const list = await getDirectReports(String(workspace.employeeId));
      graphReports = Array.isArray(list) ? list.length : 0;
    } catch (e: any) {
      logFail('org-graph direct reports', e);
      degraded = true;
      contextGaps.push('the Organization Graph, which holds who reports to whom');
    }
  }

  // Can decide a leave request or a withdrawal. This is EXACTLY what pendingLeaveForApprover() and
  // pendingWithdrawalsForApprover() will return rows for, so a widget shown here always has a queue
  // behind it and an approver is never told about work they cannot reach.
  //
  // BOTH KEYS, because one flag gates two widgets — approvals.leave and approvals.withdrawal — and
  // they are two powers, not one. They are held by the same two roles today, so the answer is
  // unchanged; asking for both means that if a future grant separates them, the flag widens with
  // whichever power a person actually holds instead of quietly following leave alone.
  //
  // THE 'admin' ARM IS GONE. It was kept here to mirror the two readers, but 'admin' is not a value
  // of userRoleEnum (src/lib/db/schema.ts:10-16), so no account can hold it and the arm could never
  // have been true. Dropping a dead comparison removes nothing from anybody — the arms still sitting
  // in hr-leave.ts and hr-wallet.ts are equally dead and are a separate conversion.
  //
  // THE DUPLICATION HAZARD THIS COMMENT USED TO NAME IS CLOSED. It said: "this decides whether a
  // CARD is shown, while hr-leave.ts pendingLeaveForApprover() and hr-wallet.ts approverRole() are
  // the enforcement... a role change made there and not here presents as 'the approvals widget
  // stopped working'." All four call sites — this one, both queues, and the enforcement — now ask
  // decidesEveryRequest() in src/lib/auth/capability.ts. There is one expression of the rule, so
  // there is nothing left to change in one place and not the other.
  //
  // Called with no capability argument on purpose: one flag gates two widgets (approvals.leave and
  // approvals.withdrawal), so the question here is "either power". Both queues name their own.
  // The card is still not the authority: decideLeave() and decideWithdrawal() re-check at the write.
  const seesEveryRequest = decidesEveryRequest(user);
  // The reporting line, kept as the row-level fact it is. It is a RELATIONSHIP to particular
  // employees, not a role grant, and no capability may stand in for it: granting a key to "cover
  // managers" would hand every manager authority over every employee.
  //
  // THE GRAPH COUNT IS DELIBERATELY NOT IN THIS EXPRESSION, and the asymmetry is the whole point.
  // approvesRequests gates approvals.leave and approvals.withdrawal, whose queues —
  // pendingLeaveForApprover() and pendingWithdrawalsForApprover() — resolve the approver from
  // hr_employees.reporting_manager_id. Widening the CARD on a graph edge those two readers do not
  // consult would offer somebody a queue that is empty by construction. So eligibility for an
  // approvals card tracks exactly the authority that fills it, and the graph count widens only
  // managesPeople, which decides whether a person is shown who reports to them — a display question,
  // answered by the layer that owns the relationship.
  const approvesRequests = seesEveryRequest || directReports > 0;

  // ---- 5. The context ---------------------------------------------------------------------------
  //
  // sectionGrants is created empty and FILLED at step 8, by reference. That is deliberate and it is
  // safe in one direction only: audience predicates run at step 7 and cannot see sections (the
  // registry answers section requirements declaratively, not inside a predicate), so nothing reads
  // this set before it is complete. What it buys is that the context handed back to the page carries
  // the same grants the filter used, rather than a second copy that could disagree with it.
  const sectionGrants = new Set<string>();
  const context: WorkspaceContext = {
    userId,
    employeeId: workspace?.employeeId ?? null,
    hasEmployeeRecord: !!workspace,
    engagement,
    departmentId: workspace?.department?.id ?? null,
    departmentName: workspace?.department?.name ?? null,
    scopeDepartmentId,
    directReports,
    // The column, the graph, or a department to lead. Any one of the three means this person is
    // responsible for somebody else's work and should be shown who.
    managesPeople: directReports > 0 || graphReports > 0 || !!scopeDepartmentId,
    approvesRequests,
    holds,
    permissions,
    sections: sectionGrants,
    grantedSection: (key, action) => sectionGrants.has(key + ':' + action),
    today: day.today,
    reportingManagerUserId: day.managerUserId,
  };

  // ---- 6. Fail closed ----------------------------------------------------------------------------
  if (!trustworthy) {
    const minimal = [...MINIMAL_WIDGETS].sort(byPriority);
    return {
      ok: false,
      reason,
      degraded,
      denial,
      context,
      widgets: minimal,
      // Derived from the MINIMAL set, so a degraded workspace offers only the doors that need
      // nothing but a session. It is not emptied: a screen with an explanation and no way out is
      // how somebody ends up stuck on a page they cannot leave.
      quickActions: quickActionsOf(minimal),
      contextGaps,
      workspace,
      ...(opts.explain
        ? { explain: WIDGETS.map((w) => ({
            key: w.key,
            kept: minimal.indexOf(w) >= 0,
            why: minimal.indexOf(w) >= 0 ? 'minimal set' : 'context not resolved (' + reason + ')',
          })) }
        : {}),
    };
  }

  // ---- 7. Filter: permissions, then audience ------------------------------------------------------
  const explain: { key: string; kept: boolean; why: string }[] = [];
  const candidates: WidgetDefinition[] = [];

  for (const w of WIDGETS) {
    const missing = w.requires.filter((key) => !holds(key));
    if (missing.length > 0) {
      if (opts.explain) explain.push({ key: w.key, kept: false, why: 'missing permission: ' + missing.join(', ') });
      continue;
    }
    let allowed = false;
    try {
      allowed = w.audience(context) === true;
    } catch (e: any) {
      // A predicate that throws is a broken widget, and a broken widget must not be shown to
      // everybody. Fail closed and say which one.
      logFail('audience threw for ' + w.key, e);
      allowed = false;
    }
    if (!allowed) {
      if (opts.explain) explain.push({ key: w.key, kept: false, why: 'audience' });
      continue;
    }
    candidates.push(w);
  }

  // ---- 8. Section grants, resolved once per distinct pair -------------------------------------------
  //
  // canAccessSection() is a query per pair, so the distinct set is resolved together and only for
  // widgets that already passed everything above. Nothing is read on behalf of a person who was
  // never going to see the widget.
  const neededSections = new Map<string, SectionRequirement>();
  for (const w of candidates) {
    for (const s of w.requiresSection || []) neededSections.set(s.key + ':' + s.action, s);
  }
  if (neededSections.size > 0) {
    const actor = { id: userId, role };
    const pairs = [...neededSections.entries()];
    const answers = await Promise.all(pairs.map(async ([id, s]) => {
      try {
        return { id, granted: await canAccessSection(actor, s.key, s.action) === true };
      } catch (e: any) {
        // canAccessSection already denies on its own errors; this is the belt for anything it could
        // not catch. A section that cannot be answered is a section that is not granted.
        logFail('canAccessSection ' + id, e);
        return { id, granted: false };
      }
    }));
    for (const a of answers) if (a.granted) sectionGrants.add(a.id);
  }

  const afterSections = candidates.filter((w) => {
    const ok = (w.requiresSection || []).every((s) => sectionGrants.has(s.key + ':' + s.action));
    if (!ok && opts.explain) explain.push({ key: w.key, kept: false, why: 'section not granted' });
    return ok;
  });

  // ---- 9. Asynchronous gates, resolved once each ----------------------------------------------------
  const neededGates = new Set<WidgetGate>();
  for (const w of afterSections) if (w.gate) neededGates.add(w.gate);

  const gateAnswers = new Map<WidgetGate, boolean>();
  if (neededGates.size > 0) {
    const list = [...neededGates];
    const answers = await Promise.all(list.map((g) => runGate(g, context, user)));
    list.forEach((g, i) => gateAnswers.set(g, answers[i]));
  }

  const kept = afterSections.filter((w) => {
    if (!w.gate) return true;
    const passed = gateAnswers.get(w.gate) === true;
    if (!passed && opts.explain) explain.push({ key: w.key, kept: false, why: 'gate: ' + w.gate });
    return passed;
  });

  if (opts.explain) for (const w of kept) explain.push({ key: w.key, kept: true, why: 'eligible' });

  // ---- 10. Order ---------------------------------------------------------------------------------
  const widgets = [...kept].sort(byPriority);

  return {
    ok: true,
    reason,
    degraded,
    denial,
    context,
    widgets,
    quickActions: quickActionsOf(widgets),
    contextGaps,
    workspace,
    ...(opts.explain ? { explain } : {}),
  };
}

/**
 * Run one asynchronous gate. Fails closed: anything that throws, or any answer that is not an
 * explicit yes, drops the widget.
 *
 * Both gates are dynamically imported so their modules are not pulled into the graph of a page that
 * never needs them — and, for wellness, so nothing about eligibility is even loaded on behalf of
 * somebody the widget was never going to be offered to.
 *
 * The signed-in user is passed separately from the context and is used by ONE gate, for one reason,
 * stated below. It is not added to WorkspaceContext: a context that carries an email address is a
 * context somebody eventually logs.
 */
async function runGate(gate: WidgetGate, ctx: WorkspaceContext, user: WorkspaceUser): Promise<boolean> {
  try {
    if (gate === 'wellness-eligible') {
      // THE ONLY SANCTIONED TEST, and it returns a boolean and a reason — never a health record and
      // never a value read off the row. Nothing about the answer is stored on the context, logged,
      // counted or passed on: the composed result carries a widget, not a fact about a person.
      //
      // THE EMAIL IS PASSED ON PURPOSE. canAccessWellness matches on user_id OR any of the three
      // email columns, deliberately, because the users-to-employees link is not guaranteed to be
      // filled in — and wellness.ts:297 is explicit that a woman whose record was never linked must
      // not be locked out of something she is entitled to. Handing it the id alone would narrow it
      // to the user_id path and quietly re-create exactly that exclusion.
      const { canAccessWellness } = await import('@/lib/wellness');
      const access = await canAccessWellness({ id: ctx.userId, email: user.email ?? null });
      return access.allowed === true;
    }

    if (gate === 'engagement-terms') {
      // A recorded requirement, not an inferred one. This is what stops a credit-hours progress bar
      // rendering against a target nobody agreed to — including for a designation that merely
      // contains the letters i-n-t-e-r-n.
      //
      // COST, stated rather than hidden: termsFor() calls ensureTermColumns(), which issues four
      // no-op ALTERs. That is the existing behaviour of /portal/employee for EVERY employee; here it
      // runs only for someone whose engagement is already an internship, so it is strictly narrower.
      // The loader for credit.position will read the terms again — share one ledgerFor() call
      // between credit.position and credit.weeksLeft, and do not add a third read.
      if (!ctx.employeeId) return false;
      const { termsFor } = await import('@/lib/credit-ledger');
      const terms = await termsFor(ctx.employeeId);
      const required = Number(terms?.requiredCreditHours);
      return Number.isFinite(required) && required > 0;
    }

    return false;
  } catch (e: any) {
    logFail('gate ' + gate, e);
    return false;
  }
}

/**
 * The composed widgets grouped in render order, for a page that lays out sections rather than one
 * flat list. Groups with nothing in them are absent, not empty — an empty heading is a promise the
 * screen does not keep.
 */
export function groupWidgets(
  widgets: readonly WidgetDefinition[],
): { group: WidgetDefinition['group']; widgets: WidgetDefinition[] }[] {
  const out: { group: WidgetDefinition['group']; widgets: WidgetDefinition[] }[] = [];
  for (const w of [...widgets].sort(byPriority)) {
    const last = out[out.length - 1];
    if (last && last.group === w.group) last.widgets.push(w);
    else out.push({ group: w.group, widgets: [w] });
  }
  return out;
}

/** Does this composition include a given widget? For a page that renders one card conditionally. */
export function hasWidget(composed: ComposedWorkspace, key: string): boolean {
  return composed.widgets.some((w) => w.key === key);
}
