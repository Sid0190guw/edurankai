// src/lib/workforce/loaders.ts — the reads behind the widgets, lifted out of the page.
//
// WHY THIS FILE EXISTS. Every widget loader on /portal/employee was written inline in that page's
// frontmatter. That was fine while there was one workspace surface and fatal the moment there were
// two: the second surface copies the query, the two copies drift, and the one that drifts toward
// showing more is the one nobody reports. Everything here is a function so there is exactly one
// expression of each read, and so a loader can be unit-read without an Astro request.
//
// THE FOUR RULES EVERY LOADER IN THIS FILE OBEYS.
//
//   1. IT DECIDES NOTHING. A loader takes an ALREADY-RESOLVED scope key — an hr_employees id, a
//      users id, a department scope from src/lib/auth/workspace-access.ts — and never a role, never
//      a permission, never a request parameter. composeWorkspace() decides who may call it; calling
//      one is the consequence of that decision, not a second version of it. If a loader ever needs
//      to ask "is this person allowed", it is in the wrong file.
//
//   2. IT REPORTS WHETHER THE READ HAPPENED. Every return carries `ok`. An empty list with ok:true
//      means there is genuinely nothing; ok:false means the query did not run and the card must say
//      so. "Nothing is waiting on you" printed over a query that threw is the same lie as a green
//      flash over a write that never landed, and this project has shipped it twice.
//
//   3. IT NEVER TAKES THE PAGE DOWN. Every read is inside a try/catch that logs
//      e?.cause?.message || e?.message — the real Postgres reason lives on e.cause; e.message is
//      only the failed SQL — and returns ok:false. One broken card is a broken card.
//
//   4. IT SELECTS COLUMNS BY NAME. No SELECT * anywhere in this file. The 2026-08-02 exposure was a
//      SELECT * on hr_employees dragging `gender` into the render context of a page that displayed
//      none of it. Two of the readers below return rows belonging to OTHER people; both are narrowed
//      to a name and a designation, and neither may ever be widened.
//
// postgres-js resolves to a plain array, never a { rows } object.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { departmentFilter, type HasDepartmentScope } from '@/lib/auth/workspace-access';
// THE SCALE PRIMITIVES. Every loader in this file is read on the workspace home page, which is the
// most-rendered authenticated screen in the product — so each one of them is a query that runs on
// every phone, every morning. idEq() replaces the `::text =` casts that made three of them
// unindexable; countUpTo() replaces the `COUNT(*) OVER ()` windows that made two of them count an
// entire department to print eight names. See src/lib/workforce/scale.ts for the reasoning.
import { idEq, countUpTo, probeMore, type BoundedCount } from '@/lib/workforce/scale';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) =>
  console.error('[workforce/loaders] ' + tag, e?.cause?.message || e?.message);

const text = (v: any): string | null => (v === null || v === undefined ? null : String(v));
/** A DATE comes back from postgres-js as a Date at UTC midnight; local getters shift it by a day. */
const isoDay = (v: any): string => {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------------------------
// NOTIFICATIONS
// ---------------------------------------------------------------------------------------------

export interface NotificationRow {
  id: string;
  title: string;
  body: string | null;
  /** notifications.action_url — where THIS row goes. There is no inbox page to fall back to. */
  actionUrl: string | null;
  isRead: boolean;
  at: string | null;
}

export interface NotificationsView {
  ok: boolean;
  items: NotificationRow[];
  unread: number;
}

/**
 * This person's own notifications, newest first.
 *
 * ROWS HAVE ALWAYS BEEN WRITTEN FOR EMPLOYEES; THE SURFACE IS NEW. src/lib/push.ts persists FIRST
 * and pushes second (push.ts:259), so the feed fills even with VAPID unset — what an employee never
 * had was a page. /portal/notifications.astro used to carry
 * `if (user.role !== 'applicant') return Astro.redirect('/admin')`, and middleware bounced anyone
 * without admin.access straight back: the ping-pong shape that took /portal down before. That is why
 * widgets.ts used to set href:null on notifications.unread. The role-name test is gone, the page
 * gates on "signed in" and narrows every read by user_id, and the widget now links to it. Each row
 * still carries its OWN action_url, which is what a row click follows — the widget href is only the
 * "see all" target, so a row never loses the thing it is about.
 *
 * Scoped in the WHERE clause by users.id. No ensure-DDL here on purpose, and the reason is now
 * stronger than "a read is not the place to discover a missing table": src/lib/notifications-schema.ts
 * is the SINGLE owner of that CREATE. push.ts and both notifications-recent endpoints each used to
 * carry their own copy in a NARROWER shape, and CREATE TABLE IF NOT EXISTS is a no-op on an existing
 * table — so whichever ran first decided whether `category` and `priority` existed at all, and every
 * later INSERT naming them threw forever. Adding a fourth CREATE here would put that back.
 * A missing table returns ok:false, which the card can state.
 */
export async function myNotifications(userId: string, limit = 5): Promise<NotificationsView> {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, items: [], unread: 0 };
  const cap = Math.min(Math.max(limit, 1), 20);
  try {
    const r = await db.execute(sql`
      SELECT id, title, body, action_url, is_read, created_at,
             (SELECT COUNT(*)::int FROM notifications u
               WHERE u.user_id = ${uid} AND u.is_read = false) AS unread
        FROM notifications
       WHERE user_id = ${uid}
       ORDER BY is_read ASC, created_at DESC
       LIMIT ${cap}`);
    const list = rows(r);
    // The correlated count rides on every row, so an empty result carries no total. Zero rows and
    // zero unread agree in that case, which is the only case where they can.
    const unread = Number(list[0]?.unread) || 0;
    return {
      ok: true,
      unread,
      items: list.map((n: any) => ({
        id: String(n.id),
        title: String(n.title || 'Notification'),
        body: text(n.body),
        actionUrl: text(n.action_url),
        isRead: n.is_read === true,
        at: n.created_at ? new Date(n.created_at).toISOString() : null,
      })),
    };
  } catch (e: any) {
    logFail('notifications', e);
    return { ok: false, items: [], unread: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// PEOPLE. Both readers below return rows about OTHER PEOPLE and are the narrowest queries in this
// file for that reason. A name and a designation, and nothing else, ever.
// ---------------------------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  name: string;
  designation: string | null;
}

export interface PeopleView {
  ok: boolean;
  people: PersonRow[];
  /** Rows beyond the cap, so a list can say "and N more" instead of quietly truncating. */
  more: number;
  /**
   * True when `more` is a FLOOR rather than a total — the count stopped at its ceiling.
   *
   * This exists because the honest answer changed shape when the counting did. `COUNT(*) OVER ()`
   * gave an exact total and read the whole matching set to get it; countUpTo() reads at most a few
   * hundred rows and therefore cannot promise an exact total past that. A screen rendering `more`
   * should print "and 12 more" when this is false and "and 500+ more" when it is true. Optional so
   * that no existing reader has to change, and every existing reader stays correct: a small team
   * never reaches the ceiling, which is the only case where the two answers could differ.
   */
  moreAtLeast?: boolean;
}

/**
 * The people who report to this account.
 *
 * THE FIRST READER OF THIS RELATION IN THE PRODUCT. ctx.managesPeople has been true for reporting
 * managers all along and the reports.direct widget has been registered all along, but nothing
 * anywhere loaded it — so a manager with direct reports had no way to see who they were.
 *
 * THE ID-SPACE TRAP: reporting_manager_id holds a USERS id. The comparison is against users.id and
 * is made against users.id, exactly as pendingLeaveForApprover() and approverRole() make it.
 * Joining it to hr_employees.id matches zero rows and reads as "nobody reports to you" rather than
 * failing. (It used to be written `reporting_manager_id::text = $1`; idEq() makes the same
 * comparison in a form the index can answer — see src/lib/workforce/scale.ts.)
 *
 * The column is ALTERed in by only two admin pages at page load, so on a database where neither has
 * run it is absent entirely and this returns ok:false rather than an authoritative empty team.
 */
export async function directReportsFor(userId: string, limit = 8): Promise<PeopleView> {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, people: [], more: 0 };
  const cap = Math.min(Math.max(limit, 1), 50);
  // Written ONCE and used by both statements below, so the page and the count can never disagree
  // about who is being counted — which is exactly what happens when a "and N more" is computed from
  // a filter that has drifted from the one that produced the rows.
  const where = sql`${idEq(sql`reporting_manager_id`, uid)} AND is_active = true`;
  try {
    // cap + 1 rows, not cap: the extra row is the cheapest possible answer to "is there more", and
    // it is asked FIRST so that the bounded count below is skipped entirely for the overwhelming
    // majority of managers, who have fewer than eight reports and need no count at all.
    const r = await db.execute(sql`
      SELECT id, full_name, designation
        FROM hr_employees
       WHERE ${where}
       ORDER BY full_name ASC
       LIMIT ${cap + 1}`);
    const { items, hasMore } = probeMore(rows(r), cap);

    // ONLY when there IS more. A second round trip on a manager with 400 reports is worth it; on the
    // 99% case it never happens.
    let more = 0;
    let moreAtLeast = false;
    if (hasMore) {
      const counted: BoundedCount = await countUpTo(sql`FROM hr_employees WHERE ${where}`);
      more = counted.ok ? Math.max(0, counted.count - items.length) : 0;
      moreAtLeast = counted.atLeast;
    }

    return {
      ok: true,
      more,
      moreAtLeast,
      people: items.map((p: any) => ({
        id: String(p.id),
        name: String(p.full_name || 'Unnamed record'),
        designation: text(p.designation),
      })),
    };
  } catch (e: any) {
    logFail('direct reports', e);
    return { ok: false, people: [], more: 0 };
  }
}

/**
 * WHO REPORTS TO THIS PERSON, ASKED OF THE LAYER THAT OWNS THE QUESTION — the mirror image of
 * reportingManagerCard() below, and it exists for the same reason.
 *
 * directReportsFor() above reads hr_employees.reporting_manager_id, and it is kept, because that
 * column is still what pendingLeaveForApprover() and approverRole() route an approval on today. What
 * it must not do is present a column value — or the ABSENCE of one — as though the Organization Graph
 * had answered.
 *
 * THE SENTENCES, AND WHY THEY MUST NOT COLLAPSE INTO ONE. The graph ships EMPTY until the founder
 * runs db/org-graph-backfill.sql, and getDirectReports() then answers [] for absolutely everybody.
 * Rendering that as "nobody is recorded as reporting to you" tells a manager something about the
 * people on their team, on the strength of a table nobody has filled in yet.
 *
 *   'graph'        the graph names them. The authoritative answer.
 *   'graph-empty'  the Organization Graph is not initialized. Says NOTHING about this person.
 *   'column-only'  the graph IS initialized and holds no edge, but the employee records of other
 *                  people point at this account. Both facts are true and they disagree.
 *   'none'         initialized, no edges, and no column pointers either. THIS is the only state in
 *                  which "nobody reports to you" is a fact about the person.
 *   'failed'       neither read answered. Not an absence.
 *
 * Names and designations only, exactly like directReportsFor: this is the second reader in the file
 * that returns rows about other people, and it may never be widened.
 */
export type ReportsSource = 'graph' | 'column-only' | 'graph-empty' | 'none' | 'failed';

export interface DirectReportsView extends PeopleView {
  source: ReportsSource;
}

export async function directReportsView(
  userId: string,
  employeeId: string | null,
  limit = 8,
): Promise<DirectReportsView> {
  const empId = String(employeeId || '').trim();
  const cap = Math.min(Math.max(limit, 1), 50);

  // The graph first: it is the layer that owns the relationship.
  let graphPeople: PersonRow[] | null = null;
  if (empId) {
    try {
      const { getDirectReports } = await import('@/lib/org-graph');
      const list = await getDirectReports(empId);
      if (Array.isArray(list) && list.length > 0) {
        graphPeople = list.map((p: any) => ({
          id: String(p.employeeId || p.id || ''),
          name: String(p.fullName || p.name || 'Unnamed record'),
          designation: text(p.designation),
        }));
      }
    } catch (e: any) {
      logFail('directReportsView.graph', e);
    }
  }
  if (graphPeople) {
    return {
      ok: true,
      source: 'graph',
      people: graphPeople.slice(0, cap),
      more: Math.max(0, graphPeople.length - cap),
    };
  }

  // No edges. Before saying anything about this person's team, find out whether the graph has
  // anything to say about ANYBODY. isInitialized() returns false on its own errors, which lands on
  // the honest sentence rather than on a claim.
  let initialized = false;
  try {
    const { isInitialized } = await import('@/lib/org-graph');
    initialized = await isInitialized();
  } catch (e: any) {
    logFail('directReportsView.isInitialized', e);
  }

  const column = await directReportsFor(userId, cap);

  if (!initialized) {
    // The graph is empty, or it could not be read. The column may still name people — they are who
    // this account decides leave for today — but it is labelled for what it is.
    return { ...column, ok: column.ok, source: 'graph-empty' };
  }
  if (column.people.length > 0) return { ...column, source: 'column-only' };
  if (!column.ok) return { ok: false, source: 'failed', people: [], more: 0 };
  return { ok: true, source: 'none', people: [], more: 0 };
}

/**
 * The department a LEAD may query — narrowed by departmentFilter(), which is the only sanctioned way
 * to scope this table.
 *
 * `scope` must be the resolved gate or Workspace, never anything derived from a query string:
 * departmentFilter reads `scopeDepartmentId`, which comes from users.assigned_department_id on the
 * SESSION, and returns sql`false` rather than sql`true` when nothing resolved — so the worst a
 * mistake here produces is an empty list, never the whole table.
 *
 * ctx.departmentId is NOT an acceptable argument. It is the person's OWN department, documented as
 * display-and-self-scope, and handing it to this function would manufacture a peer list for an
 * ordinary employee — a new authorisation decision smuggled in as a rendering one.
 *
 * Render DEPARTMENT_COVERAGE_NOTICE beside the result: hr_employees.department_id has exactly one
 * writer, so anyone HR added by hand is invisible here and a short list reads as a complete one.
 */
export async function departmentRoster(
  scope: HasDepartmentScope | null | undefined,
  limit = 8,
): Promise<PeopleView> {
  if (!String(scope?.scopeDepartmentId || '').trim()) return { ok: true, people: [], more: 0 };
  const cap = Math.min(Math.max(limit, 1), 60);
  // THE ONE THAT MATTERED MOST. This card draws eight colleagues; it used to carry
  // `COUNT(*) OVER ()`, and a window function is evaluated above the scan and below the LIMIT — so
  // Postgres found and counted every active person in the department before throwing all but eight
  // away. A department of eighty thousand people paid eighty thousand rows for eight names, on
  // every render of the workspace home page.
  const where = sql`${departmentFilter(scope)} AND e.is_active = true`;
  try {
    const r = await db.execute(sql`
      SELECT e.id, e.full_name, e.designation
        FROM hr_employees e
       WHERE ${where}
       ORDER BY e.full_name ASC
       LIMIT ${cap + 1}`);
    const { items, hasMore } = probeMore(rows(r), cap);

    let more = 0;
    let moreAtLeast = false;
    if (hasMore) {
      const counted: BoundedCount = await countUpTo(sql`FROM hr_employees e WHERE ${where}`);
      more = counted.ok ? Math.max(0, counted.count - items.length) : 0;
      moreAtLeast = counted.atLeast;
    }

    return {
      ok: true,
      more,
      moreAtLeast,
      people: items.map((p: any) => ({
        id: String(p.id),
        name: String(p.full_name || 'Unnamed record'),
        designation: text(p.designation),
      })),
    };
  } catch (e: any) {
    logFail('department roster', e);
    return { ok: false, people: [], more: 0 };
  }
}

/**
 * The name of the person this account reports to — ONE ROW, TWO DISPLAY COLUMNS.
 *
 * Reached solely through a pointer stored on the viewer's own record, which the composer has already
 * resolved onto ctx.reportingManagerUserId. That is what makes this the one row belonging to
 * somebody else a personal workspace may read.
 *
 * ORDER BY is load-bearing rather than tidiness: one human can hold several hr_employees rows (a
 * closed internship plus a current contract), so this can match more than one. Their current row is
 * the one to show.
 */
export async function managerNameFor(managerUserId: string | null): Promise<{ ok: boolean; person: PersonRow | null }> {
  const mid = String(managerUserId || '').trim();
  // Not an error and not a failed read: most people simply have no manager recorded. The caller
  // distinguishes this from ok:false, because the two lead to different sentences.
  if (!mid) return { ok: true, person: null };
  try {
    const r = await db.execute(sql`
      SELECT id, full_name, designation
        FROM hr_employees
       WHERE user_id = ${mid}
       ORDER BY is_active DESC, created_at DESC
       LIMIT 1`);
    const row = rows(r)[0];
    if (!row) return { ok: true, person: null };
    return {
      ok: true,
      person: { id: String(row.id), name: String(row.full_name || ''), designation: text(row.designation) },
    };
  } catch (e: any) {
    logFail('manager', e);
    return { ok: false, person: null };
  }
}

/**
 * WHO THIS PERSON REPORTS TO, ASKED OF THE LAYER THAT OWNS THE QUESTION — and the four different
 * things "nobody" can mean, kept apart.
 *
 * THE RULE BEING FOLLOWED. Relationships resolve from src/lib/org-graph.ts and from nowhere else;
 * hr_employees.reporting_manager_id is a COLUMN, and the Organization Graph is the layer that
 * answers who reports to whom. managerNameFor() above reads the column and is kept, because that
 * column is still what hr-leave.ts and hr-wallet.ts route an approval on today — but the card must
 * not present a column value as though the graph had answered it.
 *
 * THE SENTENCES, AND WHY THEY MUST NOT COLLAPSE INTO ONE. Until the founder runs
 * db/org-graph-backfill.sql the graph is EMPTY, and getManager() then returns null for absolutely
 * everybody. Rendering that as "no reporting manager is recorded for you" tells every employee in
 * the company that they report to nobody — a claim about a real person, made on the strength of a
 * table nobody has filled in yet. src/lib/org-graph.ts:339 states the required distinction outright,
 * and this is the loader that honours it:
 *
 *   'graph'        the graph names a manager. The authoritative answer.
 *   'graph-empty'  the Organization Graph is not initialized. Says NOTHING about this person.
 *   'column-only'  the graph IS initialized and holds no edge for them, but their employee record
 *                  carries a pointer. Both facts are true and they disagree; the card says so
 *                  rather than silently preferring one.
 *   'none'         initialized, no edge, and no pointer either. THIS is the only state in which
 *                  "no reporting manager on record" is a fact about the person.
 *   'failed'       neither read answered. Not an absence.
 *
 * Two reads at most, and only for somebody the composer already kept manager.card for.
 */
export type ManagerSource = 'graph' | 'column-only' | 'graph-empty' | 'none' | 'failed';

export interface ManagerCardView {
  ok: boolean;
  source: ManagerSource;
  person: PersonRow | null;
}

export async function reportingManagerCard(
  employeeId: string | null,
  managerUserId: string | null,
): Promise<ManagerCardView> {
  const empId = String(employeeId || '').trim();

  // The graph first: it is the layer that owns the relationship.
  let graphPerson: PersonRow | null = null;
  let graphAnswered = false;
  if (empId) {
    try {
      const { getManager } = await import('@/lib/org-graph');
      const m: any = await getManager(empId);
      graphAnswered = true;
      if (m) {
        graphPerson = {
          id: String(m.employeeId || m.id || ''),
          name: String(m.fullName || m.name || ''),
          designation: text(m.designation),
        };
      }
    } catch (e: any) {
      logFail('reportingManagerCard.graph', e);
    }
  }
  if (graphPerson) return { ok: true, source: 'graph', person: graphPerson };

  // No edge. Before saying anything about this person, find out whether the graph has anything to
  // say about ANYBODY. isInitialized() returns false on its own errors, which lands on the honest
  // sentence rather than on a claim.
  let initialized = false;
  try {
    const { isInitialized } = await import('@/lib/org-graph');
    initialized = await isInitialized();
  } catch (e: any) {
    logFail('reportingManagerCard.isInitialized', e);
  }

  const column = await managerNameFor(managerUserId);

  if (!initialized) {
    // The graph is empty, or it could not be read. The column may still carry a pointer, and it is
    // worth showing — it is who decides this person's leave today — but it is labelled for what it
    // is rather than passed off as the graph's answer.
    return { ok: column.ok || graphAnswered, source: 'graph-empty', person: column.person };
  }
  if (column.person) return { ok: true, source: 'column-only', person: column.person };
  if (!column.ok) return { ok: false, source: 'failed', person: null };
  return { ok: true, source: 'none', person: null };
}

// ---------------------------------------------------------------------------------------------
// APPROVALS ROUTED THROUGH THE WORKFLOW ENGINE
// ---------------------------------------------------------------------------------------------

/** One thing waiting on this person, flattened to what a card and a queue both need. */
export interface RoutedApprovalRow {
  /** workflow_steps.id — what decideStep() takes. */
  stepId: string;
  instanceId: string;
  domain: string;
  /** 'Expense claim', 'Timesheet' — from workflow.ts DOMAINS, never hand-typed here. */
  domainLabel: string;
  /** Who the request is ABOUT. Empty when the instance carries no subject employee. */
  subjectName: string;
  /** The instance's own one-line description, when it wrote one. */
  summary: string;
  amount: number | null;
  currency: string | null;
  /** ISO, or empty. Rendered as "waiting since", never as a countdown to a deadline nobody set. */
  since: string;
  dueAt: string;
}

export interface RoutedApprovalsView {
  ok: boolean;
  rows: RoutedApprovalRow[];
  count: number;
  /** THE ROWS ARE REAL BUT THE LIST IS SHORT. Set when the read half-succeeded — today that means
   *  the delegation resolution inside pendingForApprover() failed, so requests addressed to somebody
   *  this person is standing in for are missing while the directly-routed ones came back. `ok` stays
   *  true so the count and the link to the queue survive; a surface must render the caveat beside
   *  them, because a number that is quietly short is worse than no number at all. */
  partial?: boolean;
}

/**
 * EVERYTHING THE WORKFLOW ENGINE HAS ROUTED TO THIS PERSON, ACROSS EVERY DOMAIN.
 *
 * WHY THIS EXISTS. pendingForApprover() has been correct and callable all along, and seven pages
 * call it — each filtering to a single domain. Nothing aggregated it, so the workspace counted leave
 * requests and wallet withdrawals and presented that total as everything waiting on a manager. A
 * timesheet submitted on Friday, an overtime claim, an attendance correction, an expense claim, a
 * procurement request, a loan, a document, a helpdesk ticket, an appraisal: all routed, none
 * counted, each waiting on somebody who had no way to know it existed.
 *
 * IT WIDENS NOTHING. pendingForApprover() returns ROUTED and DELEGATED steps only — never every
 * pending step a capability holder could theoretically act on — and this function reshapes its
 * answer and adds no clause of its own.
 *
 * LEAVE IS EXCLUDED, AND IT HAS TO BE. A leave request routed through the engine exists twice — as
 * an hr_leave_request row that pendingLeaveForApprover() returns, and as a workflow step — and the
 * surface this feeds already counts the first. src/pages/portal/approvals.astro:137 drops the
 * engine's copy for exactly this reason (the leave card carries the type, the dates, the true cost
 * in day_units and the reason; a step row cannot), so this reader drops it in the same place and by
 * the same rule. Counting both would show a manager two waiting items for one person's Tuesday.
 *
 * `ok` AND ITS HONEST LIMIT. pendingForApprover() fails closed to [] by design, so from out here an
 * unreadable queue and an empty queue are the same value. ok is false only when the call itself
 * threw. A caller must therefore render an empty list as "nothing is routed to you right now" and
 * never as a verified all-clear.
 */
export async function routedApprovals(userId: string | null, limit = 50): Promise<RoutedApprovalsView> {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: true, rows: [], count: 0 };
  // THE READ THAT COULD NEVER REPORT A FAILURE. pendingForApprover() fails closed and returns [] —
  // it does not reject — so this try/catch had nothing to catch and `ok` was true whatever happened
  // downstream. /portal/employee reads `!routed.ok` into `routedFailed` and renders the honest
  // "we could not read this" card from it; that card was therefore unreachable, and a refused read
  // silently rendered as a clear queue. The reader now reports through onError; the returned list is
  // unchanged and still fail-closed.
  let readFailed = false;
  try {
    const { pendingForApprover, domainLabel } = await import('@/lib/workflow');
    const pending = await pendingForApprover(uid, { onError: () => { readFailed = true; } });
    const list = (Array.isArray(pending) ? pending : [])
      .filter((p: any) => String(p?.instance?.domain || '') !== 'leave');
    const out: RoutedApprovalRow[] = list
      .slice(0, limit)
      .map((p: any) => ({
        stepId: String(p?.step?.id || ''),
        instanceId: String(p?.instance?.id || ''),
        domain: String(p?.instance?.domain || ''),
        domainLabel: domainLabel(String(p?.instance?.domain || '')),
        subjectName: String(p?.instance?.subjectName || ''),
        summary: String(p?.instance?.summary || ''),
        amount:
          p?.instance?.amount === null || p?.instance?.amount === undefined
            ? null
            : Number(p.instance.amount),
        currency: text(p?.instance?.currency),
        since: String(p?.step?.createdAt || p?.instance?.createdAt || ''),
        dueAt: String(p?.step?.dueAt || ''),
      }))
      .filter((r) => !!r.stepId);
    // TWO DIFFERENT FAILURES, TWO DIFFERENT ANSWERS. Nothing came back AND something broke: there is
    // no queue to show and no claim to make, so ok:false and the card prints the honest sentence.
    // Rows came back AND something broke: the delegation half failed, the directly-routed rows are
    // genuine and still decidable, and hiding them behind a failure notice would strand real
    // requests. Those stay visible with `partial` set so the surface can say the list is short.
    return { ok: !(readFailed && list.length === 0), rows: out, count: list.length, partial: readFailed && list.length > 0 };
  } catch (e: any) {
    logFail('routedApprovals', e);
    return { ok: false, rows: [], count: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// TIME
// ---------------------------------------------------------------------------------------------

export interface AttendanceMonthView {
  ok: boolean;
  /** Days with a row of each status this calendar month. Statuses are free text on the table, so
   *  this is what is RECORDED, grouped as-is, and never a completeness judgement. */
  present: number;
  leave: number;
  other: number;
  daysRecorded: number;
  /** Sum of hr_attendance.work_hours, rounded. Null when every row carries no hours. */
  hours: number | null;
}

/**
 * This month's attendance, as recorded.
 *
 * DAYS RECORDED, NOT A PERCENTAGE AND NOT A TARGET. The target framing belongs to credit.position,
 * which is internship-only, and putting a completion bar here is exactly the defect the widget
 * registry exists to fix — a founder being measured against an intern's requirement.
 *
 * ABSENCE IS NOT COMPUTED. It would have to be counted against calendar days, and there is no
 * holiday table anywhere in this codebase, so every weekend would land in it. What is not written
 * down is not reported.
 *
 * overtime_hours is deliberately not selected: it has zero writers, so any total is structurally 0
 * and would read as a real figure.
 *
 * The month boundary comes from Postgres (date_trunc on CURRENT_DATE), not from the render process,
 * so it agrees with ctx.today.
 *
 * THE SINGLE WORST READ IN THE PORTAL BEFORE THIS CHANGE, and it did not look like it. The
 * predicate was `employee_id::text = $1`, which hr_attendance_emp_idx (employee_id, date DESC)
 * cannot answer — so this card, on the most-rendered authenticated page in the product, took a
 * sequential scan of a table that grows by one row per person per working day. At the roll size
 * this portal is now written for, that is billions of rows read to show one person how many days
 * they have recorded this month. idEq() emits the plain comparison and the index answers it in a
 * seek. Nothing about the result changed.
 */
export async function attendanceMonth(employeeId: string): Promise<AttendanceMonthView> {
  const empty: AttendanceMonthView = { ok: false, present: 0, leave: 0, other: 0, daysRecorded: 0, hours: null };
  const id = String(employeeId || '').trim();
  if (!id) return empty;
  try {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS days,
             COUNT(*) FILTER (WHERE lower(COALESCE(status,'')) = 'present')::int AS present,
             COUNT(*) FILTER (WHERE lower(COALESCE(status,'')) IN ('leave','on_leave'))::int AS leave,
             COALESCE(SUM(work_hours), 0)::float AS hours
        FROM hr_attendance
       WHERE ${idEq(sql`employee_id`, id)}
         AND date >= date_trunc('month', CURRENT_DATE)
         AND date <= CURRENT_DATE`);
    const row = rows(r)[0] || {};
    const days = Number(row.days) || 0;
    const present = Number(row.present) || 0;
    const leave = Number(row.leave) || 0;
    const hours = Number(row.hours);
    return {
      ok: true,
      daysRecorded: days,
      present,
      leave,
      other: Math.max(0, days - present - leave),
      hours: Number.isFinite(hours) && hours > 0 ? Math.round(hours * 10) / 10 : null,
    };
  } catch (e: any) {
    logFail('attendance month', e);
    return empty;
  }
}

export interface LeaveDayRow {
  type: string;
  start: string;
  end: string;
  status: string;
}

/**
 * Approved leave covering a given day, for this person.
 *
 * Reads through listLeave({ employeeId }) rather than a new query — that function owns the table's
 * ensure-DDL and is already the "my leave" reader. Its NO-ARGUMENT form returns EVERYBODY joined to
 * their names and must never be called from a portal page; the employeeId form is scoped in its own
 * WHERE clause.
 *
 * It swallows its own errors and returns [] either way (hr-leave.ts safe()), so the ok flag here
 * reports only whether the CALL completed — an empty result cannot be distinguished from a failed
 * one inside that module, and this comment is the honest statement of that limit.
 */
export async function leaveCovering(
  employeeId: string,
  dayIso: string | null,
): Promise<{ ok: boolean; days: LeaveDayRow[] }> {
  const id = String(employeeId || '').trim();
  const day = String(dayIso || '').slice(0, 10);
  // No day resolved means no day-partitioned claim. Withheld, never guessed from the process clock.
  if (!id || !day) return { ok: false, days: [] };
  try {
    const { listLeave } = await import('@/lib/hr-leave');
    const all = await listLeave({ employeeId: id });
    const covering = (all as any[]).filter((l: any) => {
      if (String(l.status || '').toLowerCase() !== 'approved') return false;
      const s = isoDay(l.start_date);
      const e = isoDay(l.end_date) || s;
      return !!s && s <= day && day <= e;
    });
    return {
      ok: true,
      days: covering.map((l: any) => ({
        type: String(l.leave_type || 'leave'),
        start: isoDay(l.start_date),
        end: isoDay(l.end_date),
        status: String(l.status || ''),
      })),
    };
  } catch (e: any) {
    logFail('leave covering today', e);
    return { ok: false, days: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// ACTIVITY
// ---------------------------------------------------------------------------------------------

export interface ActivityRow {
  taskId: string;
  taskTitle: string;
  actor: string;
  actorRole: string | null;
  action: string;
  from: string | null;
  to: string | null;
  kind: 'status' | 'text';
  note: string | null;
  at: string;
}

export interface ActivityView {
  ok: boolean;
  entries: ActivityRow[];
  /** True when the trail was assembled from only SOME of the person's tasks — see the cap below. */
  partial: boolean;
}

/**
 * Recent activity on the tasks this person already has open, newest first.
 *
 * THE HARD LIMIT IS THE WHOLE DESIGN. listTaskActivity() is PER TASK — there is no cross-task
 * personal activity reader in this codebase, and inventing one means exporting visibleToSql() from
 * employee-tasks.ts, which is a change to a security-critical query and not something a dashboard
 * card should force. So this calls it for a handful of tasks the caller has ALREADY READ and
 * ALREADY been authorised for, and reports `partial` whenever there were more.
 *
 * Never widen the cap into "read the whole board": that is N queries in a page render, and the
 * honest answer to "what happened everywhere" is that this database cannot say.
 *
 * Visibility is re-derived IN SQL inside listTaskActivity for every row, against the viewer's USERS
 * id — so passing a task id the viewer cannot see returns nothing rather than leaking it.
 */
export async function recentTaskActivity(
  viewerUserId: string,
  tasks: { id: string; title: string }[],
  opts: { taskCap?: number; entryCap?: number } = {},
): Promise<ActivityView> {
  const viewer = String(viewerUserId || '').trim();
  const taskCap = Math.min(Math.max(opts.taskCap ?? 4, 1), 6);
  const entryCap = Math.min(Math.max(opts.entryCap ?? 6, 1), 20);
  const list = (tasks || []).filter((t) => t && t.id).slice(0, taskCap);
  if (!viewer || list.length === 0) return { ok: true, entries: [], partial: false };

  try {
    const { listTaskActivity } = await import('@/lib/employee-tasks');
    const views = await Promise.all(
      list.map(async (t) => {
        const v = await listTaskActivity(String(t.id), viewer, 40);
        return { task: t, view: v };
      }),
    );

    // One task's trail failing does not invalidate the others, but it does mean the list is not the
    // whole story — so it is reported as partial rather than presented as complete.
    let anyFailed = false;
    const merged: ActivityRow[] = [];
    for (const { task, view } of views) {
      if (!view?.ok) { anyFailed = true; continue; }
      for (const e of view.entries || []) {
        merged.push({
          taskId: String(task.id),
          taskTitle: String(task.title || 'Untitled task'),
          actor: String(e.actorName || 'Someone'),
          actorRole: e.actorRole ?? null,
          action: String(e.action || 'made a change'),
          from: e.from ?? null,
          to: e.to ?? null,
          kind: e.kind === 'text' ? 'text' : 'status',
          note: e.note ?? null,
          at: String(e.at || ''),
        });
      }
    }

    merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return {
      ok: !anyFailed || merged.length > 0,
      entries: merged.slice(0, entryCap),
      partial: anyFailed || (tasks || []).length > list.length || merged.length > entryCap,
    };
  } catch (e: any) {
    logFail('task activity', e);
    return { ok: false, entries: [], partial: false };
  }
}
