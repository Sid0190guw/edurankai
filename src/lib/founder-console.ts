// src/lib/founder-console.ts — everything a founder needs to see, assembled once.
//
// THE STANDARD IS ONE CLICK. Four questions, answered on open:
//   1. What does my organization look like, and who reports to whom?
//   2. Who is doing what right now, and who is idle?
//   3. What is blocked on me?
//   4. What is actually wrong today?
//
// COMPOSE, NEVER RE-QUERY. Every figure here comes from the function that owns it — org-chart.ts,
// org-graph.ts, workflow.ts. A number on this console that disagrees with the screen it came from
// is worse than no console, because this is the screen decisions get made from. This project has
// already shipped two chat tables, three XP systems and two progress writers; a fifth independent
// idea of "who reports to whom" would be the most expensive duplication yet.
//
// =================================================================================================
// THE THREE STATES, AND WHY A BARE NUMBER IS NOT ONE OF THEM
// =================================================================================================
//
// The organization graph is EMPTY in production right now. So "how many people report to you" has
// no answer — not the answer zero. Those are completely different facts:
//
//   "nobody reports to you"                     — a claim about the company, and it is FALSE
//   "the organization has not been described"   — the truth, and it comes with a fix
//   "we could not read it"                      — a fault, and it needs a different response
//
// A reassuring zero on a CEO dashboard is the worst lie this product could tell, because it is the
// one nobody thinks to check. So Panel<T> can hold `known`, `unknowable` or `failed`, and there is
// deliberately no way to construct a bare value. The type makes the lie unrepresentable.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST. `const` is not hoisted, and a binding under its first reader has taken pages down.
// -------------------------------------------------------------------------------------------------

/** Where a founder goes to fix an absent prerequisite. Named once. */
export const FIX_ORG_GRAPH = '/admin/org/graph';
export const FIX_EMPLOYEES = '/admin/hr/employees';
export const FIX_SETUP = '/admin/setup';

/**
 * Render a count, or an em-dash when there is no count to render.
 *
 * The whole honesty of this screen in one function. A figure that could not be read must never
 * arrive on a founder's dashboard as `0`, because zero is a claim — "nobody reports to you",
 * "nothing is overdue" — and a wrong claim here is the one nobody thinks to check. A dash is not a
 * claim; it is an absence, and it prompts the question it should.
 *
 * Callers pass null or undefined for "not known". Anything non-finite is treated the same way,
 * because NaN reaching a screen as "NaN" is the other way this goes wrong.
 */
export function countOrDash(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  return Number.isFinite(v) ? String(v) : '—';
}

export type Panel<T> =
  | { state: 'known'; value: T }
  | { state: 'unknowable'; why: string; fix?: { label: string; href: string } }
  | { state: 'failed'; reason: string };

export const known = <T>(value: T): Panel<T> => ({ state: 'known', value });
export const unknowable = <T>(why: string, fix?: { label: string; href: string }): Panel<T> =>
  ({ state: 'unknowable', why, fix });
export const failed = <T>(reason: string): Panel<T> => ({ state: 'failed', reason });

/** Read a query and turn any throw into `failed` carrying the REAL Postgres reason, never a zero. */
async function read<T>(label: string, fn: () => Promise<T>): Promise<Panel<T>> {
  try {
    return known(await fn());
  } catch (e: any) {
    // e.message is only the failed SQL on a drizzle error; the reason lives on e.cause.
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[founder-console] ' + label + ' failed:', why);
    return failed(why);
  }
}

function rowsOf(r: any): any[] {
  // postgres-js returns a plain array. `r.rows[0]` is the mistake this line exists to prevent.
  return Array.isArray(r) ? r : (r?.rows || []);
}

// -------------------------------------------------------------------------------------------------
// SHAPES
// -------------------------------------------------------------------------------------------------

export interface OrgShape {
  /** Active employee records. The denominator for everything else. */
  headcount: number;
  /** How many have a reporting manager recorded ON THEIR RECORD (the column, not the graph). */
  withManagerColumn: number;
  /** How many have an active reporting_manager EDGE in the graph. This is what the product uses. */
  withManagerEdge: number;
  departments: number;
  byEmploymentType: { type: string; n: number }[];
}

export interface PersonLoad {
  employeeId: string;
  name: string;
  designation: string | null;
  departmentName: string | null;
  openTasks: number;
  overdueTasks: number;
  /** True when this person has no work at all. An idle person is a management fact, not an absence
   *  of data, and a dashboard that only lists activity hides the quiet half of a team. */
  idle: boolean;
}

export interface AttentionItem {
  /** Ranked by consequence, never by count. */
  severity: 'blocking' | 'wrong' | 'watch';
  title: string;
  detail: string;
  count: number | null;
  fix?: { label: string; href: string };
}

export interface FounderConsole {
  generatedAt: string;
  shape: Panel<OrgShape>;
  graphInitialized: Panel<boolean>;
  load: Panel<PersonLoad[]>;
  attention: Panel<AttentionItem[]>;
}

// -------------------------------------------------------------------------------------------------
// THE READS
// -------------------------------------------------------------------------------------------------

/**
 * The organization in numbers, and — the important part — the gap between the COLUMN and the GRAPH.
 *
 * `hr_employees.reporting_manager_id` already holds real values that an administrator typed into the
 * Employment tab. `org_relationships` is what every approval, every scope question and every
 * assignee picker actually reads. When the first is populated and the second is empty, the product
 * behaves as though nobody has a manager while the data says otherwise — which is exactly the state
 * this company is in today, and exactly why the task board offers nobody to assign to.
 *
 * Reporting both numbers side by side turns that from a mystery into a sentence.
 */
async function readShape(): Promise<Panel<OrgShape>> {
  return read('shape', async () => {
    const emp = rowsOf(await db.execute(sql`
      SELECT
        COUNT(*)::int AS headcount,
        COUNT(reporting_manager_id)::int AS with_manager_column
      FROM hr_employees
      WHERE is_active = true`))[0] || {};

    const edges = rowsOf(await db.execute(sql`
      SELECT COUNT(DISTINCT subject_employee_id)::int AS n
      FROM org_relationships
      WHERE type = 'reporting_manager'
        AND status = 'active'
        AND (effective_to IS NULL OR effective_to > NOW())`))[0] || {};

    const dept = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM departments`))[0] || {};

    const byType = rowsOf(await db.execute(sql`
      SELECT COALESCE(NULLIF(employment_type, ''), 'unrecorded') AS type, COUNT(*)::int AS n
      FROM hr_employees
      WHERE is_active = true
      GROUP BY 1 ORDER BY 2 DESC`));

    return {
      headcount: Number(emp.headcount || 0),
      withManagerColumn: Number(emp.with_manager_column || 0),
      withManagerEdge: Number(edges.n || 0),
      departments: Number(dept.n || 0),
      byEmploymentType: byType.map((r: any) => ({ type: String(r.type), n: Number(r.n || 0) })),
    };
  });
}

/** Has the graph been described at all? The prerequisite most of this screen depends on. */
async function readGraphInitialized(): Promise<Panel<boolean>> {
  return read('graph', async () => {
    const r = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM org_relationships WHERE status = 'active'`))[0] || {};
    return Number(r.n || 0) > 0;
  });
}

/**
 * Who is doing what — in ONE query for the whole organization, not one per person.
 *
 * A CEO screen that fires forty-two per-person queries takes eight seconds and gets closed. The
 * LEFT JOIN is what includes people with nothing assigned, which is half the value: a manager
 * needs to see the idle as clearly as the overloaded.
 */
async function readLoad(): Promise<Panel<PersonLoad[]>> {
  return read('load', async () => {
    // employee_tasks, keyed on employee_id, with `status` and `due_on`. Checked against
    // src/lib/employee-tasks.ts rather than assumed — the first draft of this query joined a
    // `tasks` table on `assignee_employee_id`, which is a helpdesk column and does not exist here.
    // OPEN means assigned through blocked: work that is somebody's problem right now. draft is not
    // yet given to them, and under_review onward has left their hands.
    const r = await db.execute(sql`
      SELECT e.id, e.full_name, e.designation, d.name AS department_name,
             COUNT(t.id) FILTER (
               WHERE t.status IN ('assigned','accepted','in_progress','blocked'))::int AS open_tasks,
             COUNT(t.id) FILTER (
               WHERE t.status IN ('assigned','accepted','in_progress','blocked')
                 AND t.due_on IS NOT NULL
                 AND t.due_on < CURRENT_DATE)::int AS overdue_tasks
      FROM hr_employees e
      LEFT JOIN departments d ON d.id::text = e.department_id::text
      LEFT JOIN employee_tasks t ON t.employee_id::text = e.id::text
      WHERE e.is_active = true
      GROUP BY e.id, e.full_name, e.designation, d.name
      ORDER BY overdue_tasks DESC, open_tasks DESC, e.full_name ASC`);
    return rowsOf(r).map((x: any) => {
      const open = Number(x.open_tasks || 0);
      return {
        employeeId: String(x.id),
        name: String(x.full_name || 'Unnamed'),
        designation: x.designation ? String(x.designation) : null,
        departmentName: x.department_name ? String(x.department_name) : null,
        openTasks: open,
        overdueTasks: Number(x.overdue_tasks || 0),
        idle: open === 0,
      };
    });
  });
}

/**
 * What is actually wrong, ranked by CONSEQUENCE.
 *
 * Ordering by count would put ninety-one unreviewed documents above an empty organization graph,
 * when the graph is the thing stopping approvals from routing at all. Severity is the judgement
 * this screen exists to make on the founder's behalf.
 */
async function readAttention(shape: Panel<OrgShape>, initialized: Panel<boolean>): Promise<Panel<AttentionItem[]>> {
  const items: AttentionItem[] = [];

  // 1. THE GRAPH. Blocking, and first, because everything routed depends on it.
  if (initialized.state === 'known' && initialized.value === false) {
    const n = shape.state === 'known' ? shape.value.withManagerColumn : null;
    items.push({
      severity: 'blocking',
      title: 'The organization has not been described yet',
      detail: n !== null && n > 0
        ? n + ' employee records already name a reporting manager, but none of it has been written to ' +
          'the organization graph. Until it is, nothing routes: leave has no approver, tasks have ' +
          'nobody to assign to, and every scope question answers no.'
        : 'No reporting relationships exist. Until they do, nothing routes for approval and no ' +
          'assignee picker has anybody in it.',
      count: n,
      fix: { label: 'Fill it from the employee records', href: FIX_ORG_GRAPH },
    });
  }
  if (initialized.state === 'failed') {
    items.push({
      severity: 'wrong',
      title: 'The organization graph could not be read',
      detail: initialized.reason,
      count: null,
    });
  }

  // 2. PEOPLE WITH NO MANAGER ON THEIR RECORD. Not a graph problem — a data problem, fixed elsewhere.
  const noManager = await read('no-manager', async () => {
    const r = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM hr_employees
      WHERE is_active = true AND reporting_manager_id IS NULL`))[0] || {};
    return Number(r.n || 0);
  });
  if (noManager.state === 'known' && noManager.value > 0) {
    items.push({
      severity: 'wrong',
      title: noManager.value + ' people have no reporting manager recorded',
      detail: 'Their leave has nobody to approve it and they cannot be given work through the ' +
        'normal route. This is fixed on each employee record, not in the graph.',
      count: noManager.value,
      fix: { label: 'Open the employee list', href: FIX_EMPLOYEES },
    });
  }

  // 3. CLASSIFICATION NEVER REVIEWED. The register's own copy says at least once a year.
  const neverReviewed = await read('classification', async () => {
    // Classification lives as COLUMNS on hr_employees (classification, classification_reviewed_at,
    // classification_reviewed_by), added by hr-classification.ts. There is no separate table — the
    // first draft of this query invented one, which would have failed on every load.
    const r = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM hr_employees
      WHERE is_active = true AND classification_reviewed_at IS NULL`))[0] || {};
    return Number(r.n || 0);
  });
  if (neverReviewed.state === 'known' && neverReviewed.value > 0) {
    items.push({
      severity: 'watch',
      title: neverReviewed.value + ' people have never had their classification reviewed',
      detail: 'The register says misclassification is the largest compliance exposure here and asks ' +
        'for a review at least once a year. None has been recorded.',
      count: neverReviewed.value,
      fix: { label: 'Open the classification register', href: '/admin/hr/classification' },
    });
  }
  // A failed classification read is NOT reported as zero people needing review — it is reported as
  // a read we could not do. Silence here would read as an all-clear on a compliance surface.
  if (neverReviewed.state === 'failed') {
    items.push({
      severity: 'watch',
      title: 'The classification register could not be read',
      detail: neverReviewed.reason,
      count: null,
    });
  }

  const rank = { blocking: 0, wrong: 1, watch: 2 } as const;
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return known(items);
}

/**
 * Assemble the whole console. NEVER THROWS: every section carries its own state, so one dead source
 * degrades one panel instead of blanking the screen a founder opened to find out what is wrong.
 */
export async function buildFounderConsole(): Promise<FounderConsole> {
  const [shape, graphInitialized, load] = await Promise.all([
    readShape(),
    readGraphInitialized(),
    readLoad(),
  ]);
  const attention = await readAttention(shape, graphInitialized);
  return {
    generatedAt: new Date().toISOString(),
    shape,
    graphInitialized,
    load,
    attention,
  };
}
