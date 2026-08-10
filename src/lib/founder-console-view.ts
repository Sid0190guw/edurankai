// src/lib/founder-console-view.ts — the geometry, the ordering and the sentences behind
// /founder/console.
//
// =================================================================================================
// WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
// =================================================================================================
//
// It is the arithmetic the founder console needs and NOTHING ELSE. It owns no definition of who
// reports to whom, no definition of a late task, no second idea of what is waiting on somebody.
// Every one of those already has exactly one home:
//
//   who reports to whom      -> src/lib/org-graph.ts, read through src/lib/org-chart.ts
//   what is routed to whom   -> src/lib/workflow.ts, read through src/lib/workforce/loaders.ts
//   what is open and overdue -> src/lib/employee-tasks.ts (taskLoadFor, beside CANON / IS_OVERDUE)
//   who is over-committed    -> src/lib/projects.ts allocationFor()
//   how much of the graph
//   has actually been drawn  -> src/lib/org-assignment.ts reportingLineCoverage()
//   one person's nameplate   -> src/lib/founder-console.ts personIdentity()
//
// This project has already paid for two chat tables, three XP systems and two progress writers. A
// fifth independent idea of the organization would be the most expensive one yet, so the rule here
// is absolute: COMPOSE, DO NOT RE-QUERY. The only SQL below is the pair of statements that MIRROR
// createTask()'s own authority clause — and they exist precisely so the console cannot offer a name
// the engine will refuse, which is a different failure and is argued at length where they live.
//
// =================================================================================================
// THE HELPERS ARE PURE ON PURPOSE
// =================================================================================================
//
// Layout, ages, sorting and the sentences are plain functions over plain data, so
// src/lib/founder-console-view.test.ts asserts on them with no database and no browser. Everything
// asserted is synchronous: the house test shim's it() never awaits an async body, so an async test
// written against it would pass while asserting nothing.
import { sql, type SQL } from 'drizzle-orm';

/**
 * THE DATABASE HANDLE IS IMPORTED LAZILY, INSIDE THE TWO FUNCTIONS THAT QUERY.
 *
 * src/lib/db runs dotenv.config() at module scope, so a top-level import would make merely importing
 * this file read an .env from disk — and would drag a connection story into a suite whose whole point
 * is that the layout, the ages, the ordering and the sentences are pure. The connection itself is
 * already deferred behind a Proxy; this defers the module too.
 */
const database = async () => (await import('@/lib/db')).db;

/** postgres-js hands back a plain array. Never r.rows[0]. */
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
const logFail = (where: string, e: any): void => {
  console.error('[founder-console-view] ' + where, e?.cause?.message || e?.message);
};

// =================================================================================================
// THE ORGANIZATION, DRAWN. Geometry only — the shape comes from buildOrgView().
// =================================================================================================

/**
 * The minimum a node needs to be drawn. A STRUCTURAL subset of org-chart.ts's OrgTreeNode, not a
 * parallel type: this file accepts what that file produces and invents no field of its own. A person
 * absent from the graph is absent from this input, because they are absent from the graph.
 */
export interface ChartNodeInput {
  employeeId: string | null;
  fullName: string | null;
  designation: string | null;
  depth: number;
  isViewer: boolean;
  tags: readonly string[];
  children: readonly ChartNodeInput[];
}

export interface ChartGroupInput {
  roots: readonly ChartNodeInput[];
}

/** One drawn box. Coordinates are SVG user units, which are CSS pixels at scale 1. */
export interface ChartNode {
  id: string;
  /** hr_employees.id, or '' when the graph handed back a node with no record to link to. */
  employeeId: string;
  name: string;
  sub: string;
  tag: string;
  isViewer: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One elbow connector, as an SVG path d. Straight segments only: M, H, V. No curve, no arrowhead. */
export interface ChartLink {
  id: string;
  d: string;
}

export interface ChartLayout {
  nodes: ChartNode[];
  links: ChartLink[];
  width: number;
  height: number;
  /** How many boxes were drawn. */
  drawn: number;
  /** How many the ceiling cut. NEVER silent: the console prints this beside the chart. */
  omitted: number;
}

/** Box and gutter sizes. 168px shows a full name at 360px without the box overflowing its column. */
export const CHART_NODE_W = 168;
export const CHART_NODE_H = 46;
export const CHART_COL_GAP = 38;
export const CHART_ROW_GAP = 8;

/**
 * How many boxes one page may draw.
 *
 * Not a performance guess. Each row is 54px, so 140 boxes is already a 7,500px-tall drawing, and past
 * that a phone is scrolling a document rather than reading a chart. org-chart.ts already cut the
 * RESULT at MAX_CHART_NODES; this is the second, smaller ceiling on what is DRAWN, and like the first
 * it is reported rather than applied quietly.
 */
export const CHART_MAX_NODES = 140;

/**
 * A left-to-right hierarchical layout: depth runs across, siblings run down.
 *
 * WHY NOT TOP-DOWN. A classic top-down chart is as wide as its widest generation, so a company of
 * forty-two with one wide layer is a 6,000px-wide drawing a phone can only ever show a fragment of.
 * Left-to-right is as wide as the chart is DEEP — a dozen columns at most, capped by the graph's own
 * depth ceiling — and grows downward, which is the direction a phone already scrolls. The founder
 * opens this in a taxi.
 *
 * Rows are assigned by a pre-order walk, so a manager sits on the row above their first report and
 * every subtree is contiguous. There is no crossing to resolve, because buildOrgView() hands back a
 * tree and a tree drawn this way cannot produce one.
 *
 * THE CEILING COUNTS WHAT IT DROPS. Past the limit the walk keeps descending purely to count, so
 * `omitted` is the true number of people not drawn rather than the number of roots abandoned. A
 * chart that quietly stopped would look like a smaller company.
 */
export function layoutChart(
  groups: readonly ChartGroupInput[],
  max: number = CHART_MAX_NODES,
): ChartLayout {
  const limit = Math.max(1, Math.min(Number(max) || CHART_MAX_NODES, 600));
  const nodes: ChartNode[] = [];
  const links: ChartLink[] = [];
  const byId = new Map<string, ChartNode>();
  let row = 0;
  let maxDepth = 0;
  let omitted = 0;

  const countOnly = (n: ChartNodeInput): void => {
    omitted++;
    for (const c of (n.children || [])) countOnly(c);
  };

  const place = (n: ChartNodeInput, parentKey: string | null): void => {
    if (nodes.length >= limit) { countOnly(n); return; }
    const depth = Math.max(0, Number(n.depth) || 0);
    if (depth > maxDepth) maxDepth = depth;
    const key = 'n' + nodes.length;
    const x = depth * (CHART_NODE_W + CHART_COL_GAP);
    const y = row * (CHART_NODE_H + CHART_ROW_GAP);
    row++;
    const node: ChartNode = {
      id: key,
      employeeId: String(n.employeeId || ''),
      // A missing name is not an error, and it must never render as a bare uuid.
      name: String(n.fullName || '').trim() || 'Name not recorded',
      sub: String(n.designation || '').trim(),
      // One tag, the first the graph gave. Two badges on a 168px box is a wrapped line.
      tag: (n.tags && n.tags.length ? String(n.tags[0] || '').trim() : ''),
      isViewer: n.isViewer === true,
      x, y, w: CHART_NODE_W, h: CHART_NODE_H,
    };
    nodes.push(node);
    byId.set(key, node);

    if (parentKey) {
      const p = byId.get(parentKey);
      if (p) {
        const x1 = p.x + p.w;
        const y1 = p.y + p.h / 2;
        const y2 = y + CHART_NODE_H / 2;
        const mid = x1 + CHART_COL_GAP / 2;
        links.push({ id: key + '-l', d: 'M ' + x1 + ' ' + y1 + ' H ' + mid + ' V ' + y2 + ' H ' + x });
      }
    }
    for (const c of (n.children || [])) place(c, key);
  };

  for (const g of (groups || [])) {
    for (const r of (g.roots || [])) place(r, null);
  }

  return {
    nodes,
    links,
    width: maxDepth * (CHART_NODE_W + CHART_COL_GAP) + CHART_NODE_W,
    height: Math.max(row * (CHART_NODE_H + CHART_ROW_GAP) - CHART_ROW_GAP, CHART_NODE_H),
    drawn: nodes.length,
    omitted,
  };
}

// =================================================================================================
// AGE. The whole ordering rule of the "blocked on me" panel.
// =================================================================================================

/**
 * Whole days a thing has been waiting, or null when it never said when it arrived.
 *
 * NULL IS NOT ZERO. A step with no timestamp has not been waiting no time; its age is unknown, and
 * sorting it as brand new buries it at the bottom of a queue ordered oldest-first. sortByWaiting()
 * puts unknowns at the TOP for exactly that reason.
 */
export function waitingDays(sinceIso: string | null | undefined, nowMs: number = Date.now()): number | null {
  const s = String(sinceIso || '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86400000));
}

/** "waiting 19 days". A sentence fragment, never a countdown to a deadline nobody set. */
export function waitingLabel(days: number | null): string {
  if (days === null) return 'waiting since a date we could not read';
  if (days <= 0) return 'waiting since today';
  if (days === 1) return 'waiting 1 day';
  return 'waiting ' + days + ' days';
}

/**
 * How loud a waiting item should be. AGE, NOT COUNT.
 *
 * One approval sitting for three weeks is a worse fact than nine from this morning, and a queue
 * sorted by arrival says the opposite. 'stale' is the band that earns a colour.
 */
export function waitingBand(days: number | null): 'unknown' | 'fresh' | 'ageing' | 'stale' {
  if (days === null) return 'unknown';
  if (days >= 14) return 'stale';
  if (days >= 4) return 'ageing';
  return 'fresh';
}

/** Oldest first; unknown ages first of all, because an unknown age is the one nobody chases. */
export function sortByWaiting<T extends { waited: number | null }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.waited === null && b.waited === null) return 0;
    if (a.waited === null) return -1;
    if (b.waited === null) return 1;
    return b.waited - a.waited;
  });
}

/**
 * The headline for the queue. It leads with AGE, because a count leads with the wrong fact.
 *
 * `readable` is false when the queue could not be read at all — and then this says so instead of
 * printing a calm zero. pendingForApprover() fails closed to an empty list, so from outside, an
 * unreadable queue and an empty one are the same value unless the caller carries the flag.
 */
export function queueHeadline(count: number, oldestDays: number | null, readable: boolean): string {
  if (!readable) return 'This queue could not be read just now, so nothing here is a clear desk.';
  if (count <= 0) return 'Nothing is routed to you right now. That is what the queue returned, not a promise that nothing exists elsewhere.';
  const item = count === 1 ? '1 decision' : count + ' decisions';
  if (oldestDays === null) return item + ' waiting on you. The oldest carries no readable date.';
  if (oldestDays <= 0) return item + ' waiting on you, all of them from today.';
  if (oldestDays === 1) return item + ' waiting on you. The oldest has been there a day.';
  return item + ' waiting on you. The oldest has been there ' + oldestDays + ' days.';
}

// =================================================================================================
// LOAD. What one person is carrying, said in words rather than implied by an empty cell.
// =================================================================================================

export interface LoadRow {
  employeeId: string;
  name: string;
  designation: string;
  /** Null when the task read did not happen. NEVER coerced to 0 — see loadSentence(). */
  active: number | null;
  overdue: number | null;
  /** Percent committed across active projects, or null when the allocation read did not happen. */
  allocationPct: number | null;
  overAllocated: boolean;
}

/**
 * The sentence for one person's plate.
 *
 * "NOTHING ASSIGNED" IS SAID AS PLAINLY AS A FULL PLATE, and both as plainly as "we could not tell".
 * An idle person rendered as a blank cell reads as a rendering bug; an unreadable count rendered as a
 * blank cell reads as an idle person. Three states, three sentences, no dashes standing in for either.
 */
export function loadSentence(r: Pick<LoadRow, 'active' | 'overdue'>): string {
  if (r.active === null) return 'Their work could not be read just now.';
  if (r.active === 0) return 'Nothing assigned.';
  const late = r.overdue === null
    ? ', and whether any of it is late could not be read'
    : (r.overdue > 0 ? ', ' + r.overdue + ' of it overdue' : ', none of it overdue');
  return (r.active === 1 ? '1 task open' : r.active + ' tasks open') + late + '.';
}

export type LoadSort = 'load' | 'overdue' | 'name' | 'allocation';

export function parseLoadSort(raw: unknown): LoadSort {
  const v = String(raw || '').trim().toLowerCase();
  return (v === 'overdue' || v === 'name' || v === 'allocation') ? v : 'load';
}

/**
 * Sort the roster. Nulls sink on every numeric sort — an unreadable count must never top a chart of
 * who is busiest, because "we do not know" is not "the most". Name is the stable tiebreak throughout,
 * so two people with the same load do not swap places between renders.
 */
export function sortRoster(list: readonly LoadRow[], key: LoadSort): LoadRow[] {
  const num = (v: number | null): number => (v === null ? -1 : v);
  const byName = (a: LoadRow, b: LoadRow) => a.name.localeCompare(b.name);
  const out = [...list];
  if (key === 'name') return out.sort(byName);
  if (key === 'overdue') return out.sort((a, b) => (num(b.overdue) - num(a.overdue)) || byName(a, b));
  if (key === 'allocation') return out.sort((a, b) => (num(b.allocationPct) - num(a.allocationPct)) || byName(a, b));
  return out.sort((a, b) =>
    (num(b.active) - num(a.active)) || (num(b.overdue) - num(a.overdue)) || byName(a, b));
}

// =================================================================================================
// THE EMPTY GRAPH. The most useful sentence on this screen today.
// =================================================================================================

export interface GraphStateFacts {
  /** org-graph isInitialized(), as carried on OrgViewerScope. True if ANY edge of ANY type exists. */
  initialized: boolean;
  /** reportingLineCoverage(): active employees with an OPEN reporting edge in the graph. */
  withEdge: number | null;
  /** reportingLineCoverage(): active employees whose manager is on the old column only. */
  columnOnly: number | null;
  /** False when reportingLineCoverage() could not run at all. */
  coverageOk: boolean;
}

/**
 * What to say about the organization graph, in one paragraph, without ever guessing.
 *
 * THE DISTINCTION THIS EXISTS FOR: "nobody reports to you" is a claim about the company and it is
 * false; "the organization has not been described yet" is the truth, and it comes with a fix. A
 * reassuring zero on a CEO dashboard is the worst possible lie, because it is the one nobody thinks
 * to check.
 *
 * IT ALSO RECONCILES THE TWO QUESTIONS THAT DISAGREE. isInitialized() is true as soon as ANY edge of
 * ANY type exists, so one project-manager edge switches the chart on while reporting coverage is
 * still zero. Showing either number without the other is how this screen would contradict itself.
 */
export function graphStateSentence(f: GraphStateFacts): string {
  if (!f.coverageOk) {
    return f.initialized
      ? 'The Organization Graph has relationships recorded, but how many people have a reporting line '
        + 'in it could not be counted just now. The chart below shows what could be read, and it is '
        + 'not a complete company until that count answers.'
      : 'The Organization Graph has no relationships recorded, and how many people have a reporting '
        + 'manager on their employee record could not be counted just now — so how much work the '
        + 'backfill has left is unknown rather than none.';
  }
  const withEdge = Math.max(0, Number(f.withEdge) || 0);
  const columnOnly = Math.max(0, Number(f.columnOnly) || 0);

  if (!f.initialized) {
    if (columnOnly > 0) {
      return 'The organization has not been described yet. There are no relationships in the '
        + 'Organization Graph at all, which is why there is no chart to draw — nothing here is guessed '
        + 'from job titles or account settings. It is not a blank company, though: '
        + columnOnly + ' active employee ' + (columnOnly === 1 ? 'record already has' : 'records already have')
        + ' a reporting manager recorded on the older employee field, and the backfill reads exactly '
        + 'that column and writes the graph from it.';
    }
    return 'The organization has not been described yet. There are no relationships in the '
      + 'Organization Graph, and no active employee record carries a reporting manager on the older '
      + 'employee field either — so there is nothing for the backfill to read yet. Reporting lines are '
      + 'set one person at a time on their employee record, and the graph follows from there.';
  }
  if (columnOnly > 0) {
    return 'The Organization Graph is partly drawn. ' + withEdge + ' active '
      + (withEdge === 1 ? 'employee has' : 'employees have') + ' a reporting line in it, and '
      + columnOnly + ' more ' + (columnOnly === 1 ? 'has' : 'have')
      + ' a manager recorded only on the older employee field. Those approvals still resolve through '
      + 'the compatibility layer until the backfill is run, and those people are missing from the '
      + 'chart below.';
  }
  return 'Every active employee with a recorded manager has a reporting line in the Organization '
    + 'Graph. The chart below is drawn from those relationships and from nothing else.';
}

/**
 * The one line that has to sit between a full headcount tile and an empty chart.
 *
 * "People on record: 42" beside "Organization Graph not yet initialized" reads as a broken page. Both
 * are true; the juxtaposition is what lies, and this is the sentence that stops it.
 */
export function twoSourcesSentence(headcount: number | null): string {
  const who = headcount === null ? 'The people counted above' : 'The ' + headcount + ' people counted above';
  return who + ' come from the employee register. The chart comes from the Organization Graph, which '
    + 'is a separate table of recorded relationships. A full register and an empty chart is exactly '
    + 'what an organization that has been hired but not yet described looks like.';
}

// =================================================================================================
// ASSIGNING. The one place this file touches the database, and it is here to PREVENT a lie.
// =================================================================================================

/**
 * WHY THIS QUERY EXISTS AT ALL, WHEN THE RULE OF THIS FILE IS "DO NOT RE-QUERY".
 *
 * createTask() authorises an assignment inside its own INSERT ... SELECT, against the TARGET's row,
 * and it accepts exactly three routes:
 *
 *     e.user_id             = the assigner       -- yourself
 *  OR e.reporting_manager_id = the assigner      -- your own reports (this column holds a USERS id)
 *  OR e.department_id       = scopeDepartmentId  -- present ONLY when the caller passes that scope
 *
 * scopeDepartmentId comes from workspace-access.ts, which populates it only for a holder of
 * 'department.lead' — and permissions.ts grants that to department_head AND TO NOBODY ELSE, NOT EVEN
 * super_admin, because it is a scope and not a rank. So on this data today the founder's scope is
 * null, and the only people createTask() will accept from them are themselves and anyone HR recorded
 * as reporting to them on hr_employees.reporting_manager_id.
 *
 * A DROPDOWN OF EVERYBODY WOULD THEREFORE FAIL ON CLICK ONE, IN GENERIC WORDS. That is not
 * hypothetical: src/pages/portal/tasks/index.astro widened its OWN options query to
 * `OR e.is_active = true` for holders of 'employee.manage', and createTask() never gained the
 * matching arm — so an employee.manage holder there can pick any colleague and receive "Could not
 * create that task" with nothing said about why. This console will not repeat that. It offers exactly
 * the names the engine will accept and says, in words, why the list is that short.
 *
 * WIDENING WHO MAY ASSIGN IS A POLICY DECISION AND IT IS NOT TAKEN HERE. If assigning across the
 * company without a reporting line is wanted, it belongs in employee-tasks.ts beside the other three
 * routes — which is what /portal/tasks's own header says — and it needs the founder's approval, not
 * an agent's. Until then this mirrors the engine and nothing more.
 */
const assignableClause = (viewerUserId: string, scopeDepartmentId: string | null): SQL => {
  // Every comparison is ::text. reporting_manager_id holds a USERS id, and department_id is a
  // varchar(50) slug in src/lib/db/schema.ts and a UUID in db/hr-schema.sql — a ::uuid cast would
  // throw on half the estate rather than return no rows.
  const scope = String(scopeDepartmentId || '').trim();
  const leadClause = scope ? sql`OR e.department_id::text = ${scope}` : sql``;
  return sql`(e.user_id::text = ${viewerUserId}
      OR e.reporting_manager_id::text = ${viewerUserId}
      ${leadClause})`;
};

export interface AssignablePerson {
  employeeId: string;
  name: string;
  designation: string;
  /** The relationship that lets the engine accept them. Named on the option, so the list explains itself. */
  route: 'self' | 'report' | 'department';
}

export interface AssignableRoster {
  /** False means the read did not happen. An empty list with ok:true means the engine truly accepts
   *  nobody — a fact that earns a sentence, not a silent empty select. */
  ok: boolean;
  people: AssignablePerson[];
}

/** The names createTask() will actually accept from this person, drawn from its own clause. */
export async function assignableRoster(
  viewerUserId: string,
  scopeDepartmentId: string | null = null,
  limit = 200,
): Promise<AssignableRoster> {
  const uid = String(viewerUserId || '').trim();
  if (!UUID_RE.test(uid)) return { ok: true, people: [] };
  try {
    // NAMES reporting_manager_id, which is ALTERed in by employee-tasks' ensure block and by two admin
    // pages. A query that names an absent column throws where a SELECT * would not, so the ensure runs
    // first. Its RETURN proves nothing — ensure-once swallows DDL failures — but running it is still
    // the difference between a column that exists and one that does not.
    const { ensureTaskSchema } = await import('@/lib/employee-tasks');
    await ensureTaskSchema();
    const db = await database();
    const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const list = rowsOf(await db.execute(sql`
      SELECT e.id::text AS id, e.full_name, e.designation,
             (e.user_id::text = ${uid}) AS is_me,
             (e.reporting_manager_id::text = ${uid}) AS is_report
        FROM hr_employees e
       WHERE e.is_active = true
         AND ${assignableClause(uid, scopeDepartmentId)}
       ORDER BY e.full_name ASC
       LIMIT ${lim}`));

    const people: AssignablePerson[] = [];
    for (const r of list) {
      const id = String(r.id || '').trim();
      if (!id) continue;
      // is_me / is_report come back NULL when the underlying column is NULL, so each is tested for an
      // explicit true. Listed once, under the closest relationship.
      const route: AssignablePerson['route'] =
        r.is_me === true ? 'self' : (r.is_report === true ? 'report' : 'department');
      people.push({
        employeeId: id,
        name: String(r.full_name || '').trim() || 'Name not recorded',
        designation: String(r.designation || '').trim(),
        route,
      });
    }
    return { ok: true, people };
  } catch (e: any) {
    logFail('assignableRoster', e);
    return { ok: false, people: [] };
  }
}

/**
 * May this actor put work on this employee, and what is that person called?
 *
 * THE OPTIONS ARE NOT THE CHECK. The dropdown was drawn from a query whose result is now seconds or
 * hours old, and the id in the body is whatever the browser sent. This asks the database again, over
 * the SAME clause, before anything is written — and createTask() then re-derives it a third time
 * inside its own INSERT.
 *
 * Returns null when the QUESTION COULD NOT BE ASKED, which is a different fact from "no" and earns a
 * different sentence on screen. Treating a failed check as a refusal is tolerable; treating it as
 * permission is not, and a bare boolean is how the second one eventually happens.
 */
export async function mayAssignTo(
  viewerUserId: string,
  employeeId: string,
  scopeDepartmentId: string | null = null,
): Promise<{ ok: boolean; name: string } | null> {
  const uid = String(viewerUserId || '').trim();
  const id = String(employeeId || '').trim();
  if (!UUID_RE.test(uid) || !id) return { ok: false, name: '' };
  try {
    const { ensureTaskSchema } = await import('@/lib/employee-tasks');
    await ensureTaskSchema();
    const db = await database();
    const r = rowsOf(await db.execute(sql`
      SELECT e.full_name
        FROM hr_employees e
       WHERE e.id::text = ${id}
         AND e.is_active = true
         AND ${assignableClause(uid, scopeDepartmentId)}
       LIMIT 1`))[0];
    if (!r) return { ok: false, name: '' };
    return { ok: true, name: String(r.full_name || '').trim() };
  } catch (e: any) {
    logFail('mayAssignTo', e);
    return null;
  }
}

/**
 * The sentence shown when the engine has nobody for this person to assign to.
 *
 * It names the fix and where the fix lives, because "you cannot assign work to anybody" with no next
 * step is exactly the dead end this console exists to remove.
 */
export function noAssigneesSentence(coverageColumnOnly: number | null): string {
  const base = 'The task engine accepts an assignment only for yourself, or for somebody HR has '
    + 'recorded as reporting to you — and no active employee record names you as their reporting '
    + 'manager. ';
  if (coverageColumnOnly === null) {
    return base + 'Set a reporting line on an employee record and they will appear here.';
  }
  if (coverageColumnOnly > 0) {
    return base + coverageColumnOnly + ' active employee '
      + (coverageColumnOnly === 1 ? 'record carries' : 'records carry')
      + ' a reporting manager on that field already, just not you. Set a reporting line on an employee '
      + 'record and they will appear here.';
  }
  return base + 'No active employee record carries a reporting manager at all yet. Set one and they '
    + 'will appear here.';
}
