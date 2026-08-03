// src/lib/org-chart.ts — PHASE 5. THE READ MODEL BEHIND THE ORGANIZATION VISUALIZATION.
//
// =================================================================================================
// WHAT THIS FILE IS
// =================================================================================================
//
// It turns Layer 1 (the Organization Graph) into something a person can LOOK AT: a chart, a
// hierarchy, a department tree, a team tree, and three edge lists (delegation, approval ownership,
// mentorship). It assembles SETS for rendering. It decides nothing.
//
//   Layer 1  ORGANIZATION   who is responsible for whom  -> src/lib/org-graph.ts. The authority.
//   Layer 2  AUTHORIZATION  what a user may do           -> src/lib/auth/permissions.ts, reached
//                                                           here only through the composed
//                                                           workspace's ctx.holds().
//   Layer 3  WORKFLOW       how work moves               -> elsewhere. Not here.
//
// THERE IS NO NEW AUTHORIZATION SYSTEM IN THIS FILE. It holds no capability, grants nothing and
// denies nothing. It asks two questions of two existing engines — "does this account hold
// employee.manage" (Layer 2, via the composition the page already built) and "which departments does
// this employee head, according to the graph" (Layer 1) — and then it narrows a query. Two engines
// deciding access is the defect; this is one engine deciding and one query obeying.
//
// =================================================================================================
// NO ROLE NAME IS READ, COMPARED OR ACCEPTED ANYWHERE BELOW
// =================================================================================================
//
// Not `users.role`, not 'department_head', not 'hr', not 'super_admin'. A department head's subtree
// is resolved from `org_relationships` rows of type 'department_head' — a RELATIONSHIP, per row —
// and never from the role name that happens to be spelled the same way. If the graph has no such
// row, the person is not a department head for the purposes of this page, however their account is
// labelled. That is the whole of Phase 1's work and the easiest thing here to accidentally undo.
//
// AND THERE IS NO FALLBACK. When the graph is empty, every builder returns `initialized: false` and
// the page renders "Organization Graph not yet initialized". It does NOT reach for
// hr_employees.reporting_manager_id, it does not reach for users.assigned_department_id, and it does
// not draw a chart out of role names. A chart built from a fallback looks exactly like a chart built
// from data, which is why the fallback is the dangerous option and not the kind one.
//
// =================================================================================================
// SCOPING IS DONE IN THE QUERY. NEVER IN CSS, NEVER IN THE TEMPLATE.
// =================================================================================================
//
// Every builder takes an OrgViewerScope and pushes it into the WHERE clause. A branch the viewer is
// not entitled to is ABSENT FROM THE RESULT SET — it is never fetched, never serialised into the
// HTML and never hidden with `display:none`. Sending a person data they may not see and hiding it
// client-side is not a scope, it is a delay before View Source.
//
//   'full'         -> the whole graph. Held by accounts with the `employee.manage` capability, which
//                     is the same authority that already opens /admin/hr/employees. No new key was
//                     invented for this page: inventing one would have been a policy change wearing
//                     a mechanism's clothes.
//   'departments'  -> the subtree of the departments THIS EMPLOYEE HEADS ACCORDING TO THE GRAPH.
//   'self'         -> the viewer's own reporting chain, plus the people who report to them.
//   'none'         -> nothing. Rendered as an explanation, never as an empty chart.
//
// =================================================================================================
// WHY THIS FILE CONTAINS SQL AT ALL, when the rule is "consume org-graph.ts, do not reimplement it"
// =================================================================================================
//
// Everything org-graph.ts can already answer is asked of org-graph.ts: isInitialized(),
// employeeIdForUser(), getReportingChain(), getDirectReports(), getManager(), getMentor(),
// getDelegates(), getDepartmentHead(). Not one relationship RULE is restated here.
//
// What org-graph.ts deliberately does not offer is SET assembly — "every open reporting edge under
// these roots", "every department this employee heads", "every delegation in force in this
// department". Its API is per-person by design, and building a chart out of per-person calls is an
// N+1 that grows a query for every employee hired, on a page that renders on a phone. So the
// set-shaped reads live here, and they obey three rules:
//
//   1. THE IN-FORCE PREDICATE IS COPIED EXACTLY from org-graph.ts inForce() — status = 'active',
//      effective_from <= at, (effective_to IS NULL OR effective_to > at). Half-open, same as there.
//      If that rule ever changes, THIS FILE MUST CHANGE WITH IT. That is a real coupling and it is
//      written down rather than assumed.
//   2. NO PREDICATE HERE MAY BE WIDER than the equivalent org-graph.ts answer. Narrower is a bug
//      that under-shows; wider is a leak.
//   3. NOTHING HERE WRITES. No INSERT, no UPDATE, no DDL beyond the shared ensureOrgGraphSchema()
//      bootstrap that org-graph.ts already runs on every call.
//
// =================================================================================================
// FAIL CLOSED, EVERY FUNCTION, NO EXCEPTIONS
// =================================================================================================
//
// A failed read returns the EMPTY answer and sets `degraded`, so the page can say "we could not read
// the organization graph just now" instead of drawing a confident chart with people missing from it.
// An empty result and a failed read are different sentences and this project has shipped the wrong
// one before. The real Postgres reason is logged via `e?.cause?.message || e?.message`; `e.message`
// on a drizzle error is only the failed SQL.
//
// DEPARTMENT IDS ARE TEXT AND ARE NEVER CAST TO ::uuid. `departments.id` is varchar(50) — a slug —
// in src/lib/db/schema.ts and UUID in db/hr-schema.sql. Every comparison below is `::text`.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { ensureOrgGraphSchema } from './org-graph-schema';
import {
  isInitialized,
  employeeIdForUser,
  getReportingChain,
  getDirectReports,
  getManager,
  getMentor,
  getDelegates,
  MAX_CHAIN_DEPTH,
  type OrgPerson,
} from './org-graph';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the functions that read it.
// `const` is not hoisted. A const declared below its first use throws on the first line of the
// function that reads it, and on this project that pattern took down apply step 5 and the
// /admin/roles/diagnose Repair button — both of which reported success while failing every time.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is just the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[org-chart] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guard every id BEFORE it reaches a `::uuid` cast, exactly as org-graph.ts does. */
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * THE CAPABILITY THAT OPENS THE WHOLE GRAPH.
 *
 * `employee.manage` already means "may administer employee records" — it is what requireHr() admits
 * on and what gates /admin/hr/employees, where every one of these people is listed by name anyway.
 * Reusing it means this page introduces NO new authorization vocabulary and changes who may see what
 * by exactly nothing. A brand-new `org.view.all` key would have had to be granted to somebody, and
 * granting it would have been a policy decision made by an agent rather than by the founder.
 *
 * Asked through the composed workspace's ctx.holds(), which is wildcard-aware — so a super_admin
 * holding '*' answers true, and a custom role granted the key answers true. That is Layer 2's
 * answer, resolved by Layer 2, consumed here without being second-guessed.
 */
export const ORG_FULL_VIEW_CAPABILITY = 'employee.manage';

/**
 * How many people one page may render.
 *
 * NOT a performance guess: at 360px each node is a ~56px row, so 400 nodes is already a 22,000px
 * page. Past that the honest thing is to say the chart was cut and offer a filter, rather than to
 * ship a document a phone cannot lay out. Truncation is REPORTED on the model, never silent.
 */
export const MAX_CHART_NODES = 400;

/** Edge lists (delegation / approval ownership / mentorship) get their own, smaller ceiling. */
export const MAX_EDGE_ROWS = 300;

/** Depth ceiling for the downward walk. The same hang guard org-graph.ts applies going upward. */
export const MAX_TREE_DEPTH = MAX_CHAIN_DEPTH;

/**
 * THE SEVEN VIEWS. `key` is what arrives in the query string; nothing else is accepted.
 *
 * Each `blurb` is the sentence the page prints under the heading. They are written as claims about
 * DATA — "recorded", "in force" — never as claims about authority, because none of these views say
 * what anybody may DO. Approval ownership names who a request routes TO; whether that person may
 * decide it is Layer 2's answer and this page must never be read as granting it.
 */
export const ORG_VIEWS = [
  {
    key: 'chart',
    label: 'Organization chart',
    blurb: 'Everyone in view, arranged by the reporting lines recorded in the graph.',
  },
  {
    key: 'reporting',
    label: 'Reporting hierarchy',
    blurb: 'One person’s line: who they report to, all the way up, and who reports to them.',
  },
  {
    key: 'department',
    label: 'Department tree',
    blurb: 'Departments, their recorded head, and the people whose record names that department.',
  },
  {
    key: 'team',
    label: 'Team tree',
    blurb: 'Teams and their recorded members, from the org structure tables.',
  },
  {
    key: 'delegation',
    label: 'Delegation',
    blurb: 'Who is standing in for whom right now. A delegation ends by its dates, not by a switch.',
  },
  {
    key: 'approval',
    label: 'Approval ownership',
    blurb: 'Where an approval routes, by domain. It does not say who may decide it.',
  },
  {
    key: 'mentorship',
    label: 'Mentorship',
    blurb: 'Recorded mentors. Mentorship is support, and confers no authority over anyone.',
  },
] as const;

export type OrgViewKey = (typeof ORG_VIEWS)[number]['key'];

const VIEW_KEYS: readonly string[] = ORG_VIEWS.map((v) => v.key);

/** Parse the `view` query parameter. Anything unrecognised falls back to the chart. */
export function parseOrgView(raw: unknown): OrgViewKey {
  const v = String(raw || '').trim().toLowerCase();
  return (VIEW_KEYS.includes(v) ? v : 'chart') as OrgViewKey;
}

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export type OrgScopeKind = 'full' | 'departments' | 'self' | 'none';

/** Who is looking, and therefore what the queries below are allowed to return. */
export interface OrgViewerScope {
  /** Does the graph contain ANY active relationship? The whole page branches on this first. */
  initialized: boolean;
  kind: OrgScopeKind;
  /** hr_employees.id for the signed-in account, or null when no employee record is linked. */
  employeeId: string | null;
  /** Departments this employee HEADS, per the graph. Empty for every other kind. */
  departmentIds: readonly string[];
  /** Human names for those departments, when they could be read. Display only. */
  departmentNames: readonly string[];
  /** Something did not answer. The page must not print a confident "there is nothing" over this. */
  degraded: boolean;
  /** Named sources that did not answer, in words a person can read. */
  gaps: readonly string[];
  /** One sentence saying what this person is seeing and why. Rendered verbatim. */
  explanation: string;
}

/** A person, as a node of a rendered tree. Extends the graph's own person shape. */
export interface OrgTreeNode extends OrgPerson {
  depth: number;
  parentEmployeeId: string | null;
  /** Department name, resolved for display only. Never used to decide anything. */
  departmentName: string | null;
  /** True when this row is the signed-in person — the "you are here" marker. */
  isViewer: boolean;
  /** True when a search term was given and this row matched it. */
  matched: boolean;
  /** Short factual labels, e.g. 'Department head'. Never a role name, never a capability. */
  tags: readonly string[];
  children: OrgTreeNode[];
}

/** One titled tree. The chart view returns one group per root; the department view one per department. */
export interface OrgTreeGroup {
  key: string;
  title: string;
  /** A fact about the group — a head's name, a member count. Optional. */
  subtitle: string | null;
  roots: OrgTreeNode[];
  /** People in the group, counting every depth. */
  people: number;
}

/** One relationship row, for the three edge views. */
export interface OrgEdgeRow {
  id: string;
  type: string;
  subject: OrgPerson;
  object: OrgPerson | null;
  scopeType: string | null;
  scopeId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface OrgViewModel {
  view: OrgViewKey;
  label: string;
  blurb: string;
  scope: OrgViewerScope;
  /** Tree-shaped views fill this. Edge views leave it empty. */
  groups: readonly OrgTreeGroup[];
  /** Edge views fill this. Tree views leave it empty. */
  edges: readonly OrgEdgeRow[];
  /** Total people across every group. */
  people: number;
  /** The result hit MAX_CHART_NODES / MAX_EDGE_ROWS and was cut. Say so on screen. */
  truncated: boolean;
  /**
   * Active employees with no reporting edge in either direction. Null when it was not asked or could
   * not be read. This is the number that makes an org chart honest: without it, a half-backfilled
   * graph looks like a complete company.
   */
  unattached: number | null;
  /** A calm sentence about a limit of THIS result, or null. Rendered above the tree. */
  notice: string | null;
  /** What to say when there is nothing to draw. Never "no data" on its own. */
  emptyTitle: string;
  emptyBody: string;
}

export interface OrgViewOptions {
  /** Free-text search. Applied INSIDE the scoped query; it can never widen the scope. */
  q?: string | null;
  /** Restrict to one department, chosen from the ones already in scope. */
  departmentId?: string | null;
  /** The person the reporting-hierarchy view is centred on. Ignored when out of scope. */
  focusEmployeeId?: string | null;
  /**
   * The signed-in person's display name, from the session.
   *
   * USED FOR ONE THING ONLY: labelling the viewer's OWN node when the graph could not hand back
   * their employee row. The org-graph API is per-relationship, so a person with a manager but no
   * reports can be resolved (they appear in their manager's direct reports) and a person with
   * neither cannot — and "Unnamed record" where a reader expects their own name reads as a broken
   * page. It is never applied to anybody else's node.
   */
  viewerName?: string | null;
}

// -------------------------------------------------------------------------------------------------
// INTERNAL SQL HELPERS
// -------------------------------------------------------------------------------------------------

/**
 * "This edge was in force at <iso>", for a table aliased <alias>.
 *
 * COPIED, DELIBERATELY AND VISIBLY, from inForce() in src/lib/org-graph.ts. That function is not
 * exported and must not be — it is an implementation detail of the authority — so the choice was
 * between duplicating four lines with a comment saying so, or exporting the internals of Layer 1 to
 * a view module. Four lines and a stated coupling is the smaller debt. IF THE RULE THERE CHANGES,
 * CHANGE IT HERE.
 *
 * `alias` is a compile-time literal at every call site in this file and is never derived from caller
 * input, which is the only reason sql.raw() is acceptable. The instant is a bound parameter.
 *
 * The boundary is half-open — `effective_from <= at` and `effective_to > at` — so a closed edge and
 * its replacement, opened at the same instant, leave no gap and no overlap.
 */
function inForce(alias: string, iso: string) {
  const a = sql.raw(alias);
  return sql`${a}.status = 'active'
    AND ${a}.effective_from <= ${iso}::timestamptz
    AND (${a}.effective_to IS NULL OR ${a}.effective_to > ${iso}::timestamptz)`;
}

/** `IN (...)` over a list of TEXT values, as bound parameters rather than interpolated text. */
function textList(values: readonly string[]) {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/**
 * The scope predicate, for an `hr_employees` aliased <alias>.
 *
 * THIS IS THE ONE FUNCTION THAT KEEPS AN UNENTITLED BRANCH OUT OF THE RESULT SET. Every people query
 * below AND-s it in. `FALSE` is the fail-closed answer and it is what an unresolvable scope gets:
 * an empty chart, never a full one.
 */
function inScope(alias: string, scope: OrgViewerScope) {
  const a = sql.raw(alias);
  if (scope.kind === 'full') return sql`TRUE`;
  if (scope.kind === 'departments' && scope.departmentIds.length > 0) {
    // The head's own record does not always carry the department they head, so they are admitted by
    // id as well. Without this a head can be missing from their own department's chart.
    const self = isUuid(scope.employeeId) ? scope.employeeId : null;
    const byId = self ? sql` OR ${a}.id = ${self}::uuid` : sql``;
    return sql`(${a}.department_id::text IN (${textList(scope.departmentIds)})${byId})`;
  }
  if (scope.kind === 'self' && isUuid(scope.employeeId)) {
    // 'self' never uses a set query — the chain is assembled from the org-graph API — so this exists
    // only so no query can accidentally widen if one is added later.
    return sql`${a}.id = ${scope.employeeId}::uuid`;
  }
  return sql`FALSE`;
}

/** ILIKE pattern for a search term, or null when there is nothing to search for. */
function likeOf(q: string | null | undefined): string | null {
  const t = String(q || '').trim();
  if (t.length < 2) return null; // one character matches everybody and is not a search
  return '%' + t.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
}

function mapPersonRow(row: any, prefix: string): OrgPerson {
  return {
    employeeId: row?.[prefix + 'id'] ? String(row[prefix + 'id']) : null,
    userId: row?.[prefix + 'user_id'] ? String(row[prefix + 'user_id']) : null,
    fullName: row?.[prefix + 'full_name'] ? String(row[prefix + 'full_name']) : null,
    designation: row?.[prefix + 'designation'] ? String(row[prefix + 'designation']) : null,
    departmentId: row?.[prefix + 'department_id'] ? String(row[prefix + 'department_id']) : null,
  };
}

// -------------------------------------------------------------------------------------------------
// SCOPE RESOLUTION — WHO IS LOOKING
// -------------------------------------------------------------------------------------------------

/**
 * Which departments does this EMPLOYEE head, according to the graph?
 *
 * A GRAPH READ, NOT A ROLE READ. It returns the scope_id of every in-force 'department_head' edge
 * whose subject is this employee. `users.role` is not consulted, and neither is
 * `users.assigned_department_id` — the pair that used to be the only leadership signal in the
 * product. If an account is labelled department_head and the graph has no row for them, they are not
 * a department head here. That is the point.
 *
 * Empty array on any error: no departments means the viewer falls back to their own chain, which is
 * the narrower answer.
 */
async function headedDepartments(employeeId: string): Promise<string[]> {
  if (!isUuid(employeeId)) return [];
  const at = new Date().toISOString();
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT DISTINCT r.scope_id::text AS dept
        FROM org_relationships r
       WHERE r.type = 'department_head'
         AND r.scope_type = 'department'
         AND r.scope_id IS NOT NULL
         AND r.subject_employee_id = ${employeeId}::uuid
         AND ${inForce('r', at)}`);
    return rows(r)
      .map((row: any) => (row?.dept ? String(row.dept) : ''))
      .filter((d: string) => d.length > 0);
  } catch (e: any) {
    logFail('headedDepartments', e);
    return [];
  }
}

/** Department names for display. Never used to decide anything; failure costs a label, not a scope. */
async function departmentNames(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = ids.filter((d) => typeof d === 'string' && d.trim().length > 0);
  if (list.length === 0) return out;
  try {
    // ::text on both sides. departments.id is a uuid in one schema file and a varchar slug in the
    // other; a ::uuid cast throws the first time a slug arrives.
    const r = await db.execute(sql`
      SELECT d.id::text AS id, d.name AS name
        FROM departments d
       WHERE d.id::text IN (${textList(list)})`);
    for (const row of rows(r)) {
      if (row?.id) out.set(String(row.id), row?.name ? String(row.name) : String(row.id));
    }
  } catch (e: any) {
    logFail('departmentNames', e);
  }
  return out;
}

/**
 * WHO IS LOOKING, AND THEREFORE WHAT MAY BE QUERIED. Call this once per request, before anything
 * else — every builder takes its result and none of them re-derive it.
 *
 * `holds` is the composed workspace's ctx.holds: wildcard-aware, resolved by Layer 2, consumed here
 * without being re-litigated. Passing it in rather than calling the registry keeps this module free
 * of a second permission resolution and guarantees the page's nav, its widgets and its chart were
 * all decided from ONE composition.
 *
 * ORDER MATTERS AND IS DELIBERATE:
 *   1. isInitialized() first. An empty graph is not a permission problem and must not be dressed as
 *      one; everyone gets the same "not yet initialized" screen regardless of what they hold.
 *   2. The capability. Whole graph.
 *   3. The graph's own department_head rows. Their departments.
 *   4. An employee record. Their own chain.
 *   5. Nothing.
 */
export async function resolveOrgViewerScope(
  userId: string,
  holds: (key: string) => boolean,
): Promise<OrgViewerScope> {
  const gaps: string[] = [];
  let degraded = false;

  let initialized = false;
  try {
    initialized = await isInitialized();
  } catch (e: any) {
    // isInitialized() already fails closed; this is the belt for anything it could not catch.
    logFail('isInitialized', e);
    degraded = true;
    gaps.push('the organization graph');
  }

  const canSeeEverything = (() => {
    try {
      return holds(ORG_FULL_VIEW_CAPABILITY) === true;
    } catch (e: any) {
      // A capability test that throws is a denied capability. Never an assumed one.
      logFail('holds', e);
      return false;
    }
  })();

  let employeeId: string | null = null;
  try {
    employeeId = await employeeIdForUser(userId);
  } catch (e: any) {
    logFail('employeeIdForUser', e);
    degraded = true;
    gaps.push('your employee record');
  }

  if (!initialized) {
    return {
      initialized: false,
      kind: canSeeEverything ? 'full' : employeeId ? 'self' : 'none',
      employeeId,
      departmentIds: [],
      departmentNames: [],
      degraded,
      gaps,
      explanation:
        'The Organization Graph has no relationships recorded yet, so there is nothing to draw.',
    };
  }

  if (canSeeEverything) {
    return {
      initialized: true,
      kind: 'full',
      employeeId,
      departmentIds: [],
      departmentNames: [],
      degraded,
      gaps,
      explanation: 'You are seeing every relationship recorded in the organization graph.',
    };
  }

  const headed = employeeId ? await headedDepartments(employeeId) : [];
  if (headed.length > 0) {
    const names = await departmentNames(headed);
    const labels = headed.map((d) => names.get(d) || d);
    return {
      initialized: true,
      kind: 'departments',
      employeeId,
      departmentIds: headed,
      departmentNames: labels,
      degraded,
      gaps,
      explanation:
        labels.length === 1
          ? 'You are seeing ' + labels[0] + ', because the graph records you as its head.'
          : 'You are seeing ' +
            labels.length +
            ' departments, because the graph records you as their head.',
    };
  }

  if (employeeId) {
    return {
      initialized: true,
      kind: 'self',
      employeeId,
      departmentIds: [],
      departmentNames: [],
      degraded,
      gaps,
      explanation: 'You are seeing your own reporting line and the people who report to you.',
    };
  }

  return {
    initialized: true,
    kind: 'none',
    employeeId: null,
    departmentIds: [],
    departmentNames: [],
    degraded,
    gaps,
    explanation:
      'Your account has no employee record on the organization graph, so there is no line to show.',
  };
}

// -------------------------------------------------------------------------------------------------
// TREE ASSEMBLY
// -------------------------------------------------------------------------------------------------

interface RawNode {
  person: OrgPerson;
  depth: number;
  parentEmployeeId: string | null;
}

/**
 * Turn a depth-ordered flat list into trees.
 *
 * ORPHAN-SAFE BY CONSTRUCTION: the query orders by depth ASC and truncates the tail, so a node whose
 * parent was cut is cut too. Anything that still arrives without a known parent becomes a root
 * rather than disappearing — a person silently missing from an org chart is the failure this page
 * exists to prevent.
 */
function buildTrees(
  raw: readonly RawNode[],
  opts: {
    viewerEmployeeId: string | null;
    like: string | null;
    deptNames: Map<string, string>;
    tagsBy?: Map<string, string[]>;
    /** Only ever used for the viewer's own node. See OrgViewOptions.viewerName. */
    viewerName?: string | null;
  },
): OrgTreeNode[] {
  const byId = new Map<string, OrgTreeNode>();
  const order: OrgTreeNode[] = [];
  const term = (opts.like || '').replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();

  for (const r of raw) {
    const id = r.person.employeeId;
    if (!id || byId.has(id)) continue;
    const isViewer = !!opts.viewerEmployeeId && id === opts.viewerEmployeeId;
    // The session name stands in ONLY for the reader's own unnamed node, never for anybody else's.
    const fullName = r.person.fullName || (isViewer ? opts.viewerName || null : null);
    const haystack = [fullName, r.person.designation].filter(Boolean).join(' ').toLowerCase();
    const node: OrgTreeNode = {
      ...r.person,
      fullName,
      depth: r.depth,
      parentEmployeeId: r.parentEmployeeId,
      departmentName: r.person.departmentId ? opts.deptNames.get(r.person.departmentId) || null : null,
      isViewer,
      matched: term.length > 0 && haystack.indexOf(term) >= 0,
      tags: opts.tagsBy?.get(id) || [],
      children: [],
    };
    byId.set(id, node);
    order.push(node);
  }

  const roots: OrgTreeNode[] = [];
  for (const node of order) {
    const parent = node.parentEmployeeId ? byId.get(node.parentEmployeeId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Everyone in these trees, counted once. */
function countTree(nodes: readonly OrgTreeNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countTree(node.children);
  return n;
}

/**
 * Keep only branches containing a search hit, plus the ancestors that lead to one.
 *
 * NOT A SCOPE. Everything handed to this function was already fetched under the scope predicate, so
 * dropping rows here can only ever narrow what is shown. It is applied after assembly because an
 * ancestor is what makes a hit legible: "Priya" on her own says nothing, "Priya, under Anil, under
 * Meera" is an answer.
 */
function pruneToMatches(nodes: readonly OrgTreeNode[]): OrgTreeNode[] {
  const out: OrgTreeNode[] = [];
  for (const node of nodes) {
    const kept = pruneToMatches(node.children);
    if (node.matched || kept.length > 0) out.push({ ...node, children: kept });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// THE REPORTING FOREST — the query behind the chart and the department trees
// -------------------------------------------------------------------------------------------------

/**
 * Every person in scope who takes part in a reporting relationship, arranged as a forest.
 *
 * ONE RECURSIVE QUERY, NOT ONE PER LEVEL. A loop of getDirectReports() calls would be an N+1 that
 * gains a query for every employee hired.
 *
 * ROOTS are the people in scope with no in-force manager WHO IS ALSO IN SCOPE. That second clause is
 * what makes a department subtree render as a tree rather than as a flat list: a department member
 * whose manager sits outside the department becomes a root of the department's own chart, and the
 * manager themselves is NOT fetched — an unentitled person is absent from the query, exactly as
 * required, rather than fetched and hidden.
 *
 * CYCLE SAFETY, TWICE: the recursive term carries the path walked so far and refuses to re-enter it,
 * and `depth < MAX_TREE_DEPTH` caps the walk regardless. Corrupt org data is exactly what a first
 * backfill produces, and a cycle here is a request that never comes back.
 */
async function reportingForest(
  scope: OrgViewerScope,
  opts: { departmentId?: string | null } = {},
): Promise<{ nodes: RawNode[]; truncated: boolean; degraded: boolean }> {
  const at = new Date().toISOString();
  const dept = String(opts.departmentId || '').trim();
  // A department filter may only ever NARROW what the scope already allows: it is AND-ed with
  // inScope(), never substituted for it. A filter that replaced the scope would be a scope chosen by
  // the person browsing, which is not a scope at all.
  const deptFilter = dept ? sql` AND e.department_id::text = ${dept}` : sql``;
  const deptFilterChild = dept ? sql` AND c.department_id::text = ${dept}` : sql``;
  const deptFilterMgr = dept ? sql` AND mgr.department_id::text = ${dept}` : sql``;

  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      WITH RECURSIVE roots AS (
        SELECT e.id AS employee_id
          FROM hr_employees e
         WHERE ${inScope('e', scope)}${deptFilter}
           AND EXISTS (
             SELECT 1 FROM org_relationships p
              WHERE p.type = 'reporting_manager'
                AND (p.subject_employee_id = e.id OR p.object_employee_id = e.id)
                AND ${inForce('p', at)}
           )
           AND NOT EXISTS (
             SELECT 1 FROM org_relationships m
               JOIN hr_employees mgr ON mgr.id = m.subject_employee_id
              WHERE m.type = 'reporting_manager'
                AND m.object_employee_id = e.id
                AND ${inForce('m', at)}
                AND ${inScope('mgr', scope)}${deptFilterMgr}
           )
      ),
      walk AS (
        SELECT r.employee_id AS employee_id,
               0 AS depth,
               ARRAY[r.employee_id] AS path
          FROM roots r
        UNION ALL
        SELECT rel.object_employee_id,
               w.depth + 1,
               w.path || rel.object_employee_id
          FROM walk w
          JOIN org_relationships rel
            ON rel.subject_employee_id = w.employee_id
          JOIN hr_employees c
            ON c.id = rel.object_employee_id
         WHERE rel.type = 'reporting_manager'
           AND ${inForce('rel', at)}
           AND w.depth < ${MAX_TREE_DEPTH}
           AND NOT (rel.object_employee_id = ANY(w.path))
           AND ${inScope('c', scope)}${deptFilterChild}
      )
      SELECT w.depth AS depth,
             CASE WHEN array_length(w.path, 1) > 1
                  THEN w.path[array_length(w.path, 1) - 1]::text
                  ELSE NULL END AS parent_id,
             e.id AS n_id,
             e.user_id AS n_user_id,
             e.full_name AS n_full_name,
             e.designation AS n_designation,
             e.department_id::text AS n_department_id
        FROM walk w
        JOIN hr_employees e ON e.id = w.employee_id
       ORDER BY w.depth ASC, e.full_name ASC
       LIMIT ${MAX_CHART_NODES + 1}`);

    const list = rows(r);
    const truncated = list.length > MAX_CHART_NODES;
    const nodes: RawNode[] = list.slice(0, MAX_CHART_NODES).map((row: any) => ({
      person: mapPersonRow(row, 'n_'),
      depth: Number(row?.depth) || 0,
      parentEmployeeId: row?.parent_id ? String(row.parent_id) : null,
    }));
    return { nodes, truncated, degraded: false };
  } catch (e: any) {
    logFail('reportingForest', e);
    return { nodes: [], truncated: false, degraded: true };
  }
}

/**
 * Active employees in scope with no reporting edge at all, in either direction.
 *
 * THE NUMBER THAT KEEPS THE CHART HONEST. A backfill that mapped 40 of 120 people produces a chart
 * that looks complete and is not; printing "62 people have no reporting relationship recorded" is
 * the difference between a picture and a lie. Null when it could not be read — never zero.
 */
async function unattachedCount(scope: OrgViewerScope): Promise<number | null> {
  const at = new Date().toISOString();
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM hr_employees e
       WHERE e.is_active = TRUE
         AND ${inScope('e', scope)}
         AND NOT EXISTS (
           SELECT 1 FROM org_relationships p
            WHERE p.type = 'reporting_manager'
              AND (p.subject_employee_id = e.id OR p.object_employee_id = e.id)
              AND ${inForce('p', at)}
         )`);
    const n = Number(rows(r)[0]?.n);
    return Number.isFinite(n) ? n : null;
  } catch (e: any) {
    logFail('unattachedCount', e);
    return null;
  }
}

/**
 * The viewer's own line, assembled ENTIRELY from the org-graph API.
 *
 * No SQL here on purpose: getReportingChain() and getDirectReports() already answer exactly this,
 * cycle-safely, and re-asking it in a query would be the reimplementation the phase forbids. Two
 * calls, constant cost, regardless of how many people work here.
 */
async function selfLine(
  employeeId: string,
): Promise<{ nodes: RawNode[]; degraded: boolean }> {
  try {
    const [chain, reports] = await Promise.all([
      getReportingChain(employeeId),
      getDirectReports(employeeId),
    ]);

    // NEITHER A MANAGER NOR A REPORT IS NOT A LINE, IT IS A GAP. Returning a single node here would
    // draw a one-person "hierarchy" that looks like an answer; returning nothing lets the caller
    // print "no reporting relationship recorded", which is the true sentence.
    if (chain.length === 0 && reports.length === 0) return { nodes: [], degraded: false };

    // The chain arrives closest-first (depth 1 is the direct manager). Rendered top-down, so it is
    // reversed: the most senior person recorded becomes depth 0.
    const upward = [...chain].reverse();
    const nodes: RawNode[] = [];
    let parent: string | null = null;
    upward.forEach((link, i) => {
      nodes.push({ person: link, depth: i, parentEmployeeId: parent });
      parent = link.employeeId;
    });

    const selfDepth = upward.length;
    // THE PERSON'S OWN ROW, WITHOUT ADDING A QUERY OR A NEW RULE. The org-graph API is per
    // relationship, so it never returns "this person"; it returns the people around them. Both
    // recoveries below are therefore reads of an EXISTING relationship, and both fail closed to a
    // minimal row that the caller labels from the session:
    //   - with reports:   they are the manager of their first report.
    //   - with a manager: they are among that manager's direct reports.
    let me: OrgPerson | null = null;
    if (reports.length > 0) {
      me = await getManager(String(reports[0].employeeId || ''));
    } else if (chain.length > 0 && chain[0].employeeId) {
      const siblings = await getDirectReports(String(chain[0].employeeId));
      me = siblings.find((p) => p.employeeId === employeeId) || null;
    }
    nodes.push({
      person: me && me.employeeId === employeeId
        ? me
        : { employeeId, userId: null, fullName: null, designation: null, departmentId: null },
      depth: selfDepth,
      parentEmployeeId: parent,
    });

    for (const rep of reports) {
      nodes.push({ person: rep, depth: selfDepth + 1, parentEmployeeId: employeeId });
    }
    return { nodes, degraded: false };
  } catch (e: any) {
    logFail('selfLine', e);
    return { nodes: [], degraded: true };
  }
}

// -------------------------------------------------------------------------------------------------
// EDGE LISTS — delegation, approval ownership, mentorship
// -------------------------------------------------------------------------------------------------

/**
 * Every in-force edge of one type that this viewer is entitled to, newest lines first.
 *
 * SCOPED IN THE WHERE CLAUSE, like everything else here. At 'departments' the edge is admitted when
 * EITHER end sits in a headed department — a delegation only half of which is visible is still a
 * fact the head needs, and both people are named on it, so there is no half-row to hide. At 'self'
 * only edges naming the viewer are fetched.
 */
async function edgeList(
  type: string,
  scope: OrgViewerScope,
  opts: OrgViewOptions,
): Promise<{ edges: OrgEdgeRow[]; truncated: boolean; degraded: boolean }> {
  const at = new Date().toISOString();
  const like = likeOf(opts.q);

  let where;
  if (scope.kind === 'full') {
    where = sql`TRUE`;
  } else if (scope.kind === 'departments' && scope.departmentIds.length > 0) {
    where = sql`(s.department_id::text IN (${textList(scope.departmentIds)})
      OR o.department_id::text IN (${textList(scope.departmentIds)}))`;
  } else if (scope.kind === 'self' && isUuid(scope.employeeId)) {
    where = sql`(r.subject_employee_id = ${scope.employeeId}::uuid
      OR r.object_employee_id = ${scope.employeeId}::uuid)`;
  } else {
    where = sql`FALSE`;
  }

  const search = like
    ? sql` AND (s.full_name ILIKE ${like} OR o.full_name ILIKE ${like} OR r.scope_id ILIKE ${like})`
    : sql``;
  const deptFilter = String(opts.departmentId || '').trim()
    ? sql` AND (s.department_id::text = ${String(opts.departmentId).trim()}
        OR o.department_id::text = ${String(opts.departmentId).trim()})`
    : sql``;

  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT r.id AS id, r.type AS type, r.scope_type AS scope_type, r.scope_id AS scope_id,
             r.effective_from AS effective_from, r.effective_to AS effective_to,
             s.id AS s_id, s.user_id AS s_user_id, s.full_name AS s_full_name,
             s.designation AS s_designation, s.department_id::text AS s_department_id,
             o.id AS o_id, o.user_id AS o_user_id, o.full_name AS o_full_name,
             o.designation AS o_designation, o.department_id::text AS o_department_id
        FROM org_relationships r
        JOIN hr_employees s ON s.id = r.subject_employee_id
        LEFT JOIN hr_employees o ON o.id = r.object_employee_id
       WHERE r.type = ${type}
         AND ${inForce('r', at)}
         AND ${where}${search}${deptFilter}
       ORDER BY s.full_name ASC, r.effective_from DESC
       LIMIT ${MAX_EDGE_ROWS + 1}`);

    const list = rows(r);
    const truncated = list.length > MAX_EDGE_ROWS;
    const edges: OrgEdgeRow[] = list.slice(0, MAX_EDGE_ROWS).map((row: any) => ({
      id: String(row?.id ?? ''),
      type: String(row?.type ?? type),
      subject: mapPersonRow(row, 's_'),
      object: row?.o_id ? mapPersonRow(row, 'o_') : null,
      scopeType: row?.scope_type ? String(row.scope_type) : null,
      scopeId: row?.scope_id ? String(row.scope_id) : null,
      effectiveFrom: row?.effective_from ? new Date(row.effective_from).toISOString() : null,
      effectiveTo: row?.effective_to ? new Date(row.effective_to).toISOString() : null,
    }));
    return { edges, truncated, degraded: false };
  } catch (e: any) {
    logFail('edgeList ' + type, e);
    return { edges: [], truncated: false, degraded: true };
  }
}

// -------------------------------------------------------------------------------------------------
// DEPARTMENT AND TEAM VIEWS
// -------------------------------------------------------------------------------------------------

/**
 * Departments in scope, each with the head the GRAPH records and the people whose own record names
 * that department.
 *
 * TWO SOURCES, KEPT APART ON PURPOSE. The head comes from org_relationships (Layer 1). Membership
 * comes from hr_employees.department_id, which is a fact on the employee's own row and is NOT a
 * relationship — it is labelled "on record" on screen for exactly that reason. Nothing here infers a
 * head from a membership or a membership from a head.
 */
async function departmentGroups(
  scope: OrgViewerScope,
  opts: OrgViewOptions,
): Promise<{ groups: OrgTreeGroup[]; truncated: boolean; degraded: boolean }> {
  const at = new Date().toISOString();
  const like = likeOf(opts.q);
  const only = String(opts.departmentId || '').trim();

  // WHICH DEPARTMENTS. 'full' sees every department that has a head recorded or a member on record;
  // 'departments' sees the ones it heads; 'self' sees its own; 'none' sees nothing.
  let deptWhere;
  if (scope.kind === 'full') {
    deptWhere = sql`TRUE`;
  } else if (scope.kind === 'departments' && scope.departmentIds.length > 0) {
    deptWhere = sql`d.id::text IN (${textList(scope.departmentIds)})`;
  } else if (scope.kind === 'self' && isUuid(scope.employeeId)) {
    deptWhere = sql`d.id::text = (
      SELECT me.department_id::text FROM hr_employees me WHERE me.id = ${scope.employeeId}::uuid LIMIT 1
    )`;
  } else {
    deptWhere = sql`FALSE`;
  }
  const onlyFilter = only ? sql` AND d.id::text = ${only}` : sql``;

  try {
    await ensureOrgGraphSchema();
    const dr = await db.execute(sql`
      SELECT d.id::text AS dept_id,
             d.name AS dept_name,
             h.id AS h_id, h.user_id AS h_user_id, h.full_name AS h_full_name,
             h.designation AS h_designation, h.department_id::text AS h_department_id
        FROM departments d
        LEFT JOIN LATERAL (
          SELECT e.id, e.user_id, e.full_name, e.designation, e.department_id
            FROM org_relationships r
            JOIN hr_employees e ON e.id = r.subject_employee_id
           WHERE r.type = 'department_head'
             AND r.scope_type = 'department'
             AND r.scope_id = d.id::text
             AND ${inForce('r', at)}
           ORDER BY r.effective_from DESC
           LIMIT 1
        ) h ON TRUE
       WHERE ${deptWhere}${onlyFilter}
       ORDER BY d.name ASC
       LIMIT 200`);

    const deptRows = rows(dr);
    if (deptRows.length === 0) return { groups: [], truncated: false, degraded: false };

    const ids = deptRows.map((row: any) => String(row.dept_id));
    const search = like ? sql` AND (e.full_name ILIKE ${like} OR e.designation ILIKE ${like})` : sql``;
    const mr = await db.execute(sql`
      SELECT e.department_id::text AS dept_id,
             e.id AS n_id, e.user_id AS n_user_id, e.full_name AS n_full_name,
             e.designation AS n_designation, e.department_id::text AS n_department_id
        FROM hr_employees e
       WHERE e.is_active = TRUE
         AND e.department_id IS NOT NULL
         AND e.department_id::text IN (${textList(ids)})
         AND ${inScope('e', scope)}${search}
       ORDER BY e.full_name ASC
       LIMIT ${MAX_CHART_NODES + 1}`);

    const memberRows = rows(mr);
    const truncated = memberRows.length > MAX_CHART_NODES;
    const byDept = new Map<string, RawNode[]>();
    for (const row of memberRows.slice(0, MAX_CHART_NODES)) {
      const key = String(row.dept_id);
      const bucket = byDept.get(key) || [];
      bucket.push({ person: mapPersonRow(row, 'n_'), depth: 0, parentEmployeeId: null });
      byDept.set(key, bucket);
    }

    const names = new Map<string, string>();
    for (const row of deptRows) names.set(String(row.dept_id), row?.dept_name ? String(row.dept_name) : String(row.dept_id));

    const groups: OrgTreeGroup[] = [];
    for (const row of deptRows) {
      const id = String(row.dept_id);
      const head = row?.h_id ? mapPersonRow(row, 'h_') : null;
      const members = byDept.get(id) || [];
      // The head is pinned to the top of their own department, and de-duplicated out of the member
      // list so nobody is drawn twice.
      const headId = head?.employeeId || null;
      const tagsBy = new Map<string, string[]>();
      if (headId) tagsBy.set(headId, ['Department head']);
      const raw: RawNode[] = headId
        ? [
            { person: head as OrgPerson, depth: 0, parentEmployeeId: null },
            ...members
              .filter((m) => m.person.employeeId !== headId)
              .map((m) => ({ ...m, depth: 1, parentEmployeeId: headId })),
          ]
        : members;
      let roots = buildTrees(raw, {
        viewerEmployeeId: scope.employeeId,
        like,
        deptNames: names,
        tagsBy,
      });
      if (like) roots = pruneToMatches(roots);
      if (like && roots.length === 0) continue;
      groups.push({
        key: id,
        title: names.get(id) || id,
        subtitle: head
          ? 'Head on the graph: ' + (head.fullName || 'recorded, name unavailable')
          : 'No head recorded on the graph',
        roots,
        people: countTree(roots),
      });
    }
    return { groups, truncated, degraded: false };
  } catch (e: any) {
    logFail('departmentGroups', e);
    return { groups: [], truncated: false, degraded: true };
  }
}

/**
 * Teams and their recorded members.
 *
 * ITS OWN try/catch, and a distinct empty message, because org_teams is created in the SECOND,
 * NON-FATAL pass of ensureOrgGraphSchema(). On a database where that pass logged and stopped, the
 * table is genuinely absent — and "we could not read the team structure" is a different sentence
 * from "no teams have been created", which is in turn different from "the graph is not initialized".
 * Three states, three sentences.
 */
async function teamGroups(
  scope: OrgViewerScope,
  opts: OrgViewOptions,
): Promise<{ groups: OrgTreeGroup[]; truncated: boolean; degraded: boolean }> {
  const at = new Date().toISOString();
  const like = likeOf(opts.q);
  const only = String(opts.departmentId || '').trim();

  let teamWhere;
  if (scope.kind === 'full') {
    teamWhere = sql`TRUE`;
  } else if (scope.kind === 'departments' && scope.departmentIds.length > 0) {
    teamWhere = sql`t.department_id::text IN (${textList(scope.departmentIds)})`;
  } else if (scope.kind === 'self' && isUuid(scope.employeeId)) {
    teamWhere = sql`EXISTS (
      SELECT 1 FROM org_employee_assignments a
       WHERE a.team_id = t.id
         AND a.employee_id = ${scope.employeeId}::uuid
         AND ${inForce('a', at)}
    )`;
  } else {
    teamWhere = sql`FALSE`;
  }
  const onlyFilter = only ? sql` AND t.department_id::text = ${only}` : sql``;

  try {
    await ensureOrgGraphSchema();
    const tr = await db.execute(sql`
      SELECT t.id::text AS team_id, t.name AS team_name, t.department_id::text AS dept_id
        FROM org_teams t
       WHERE t.is_active = TRUE
         AND ${teamWhere}${onlyFilter}
       ORDER BY t.name ASC
       LIMIT 200`);
    const teamRows = rows(tr);
    if (teamRows.length === 0) return { groups: [], truncated: false, degraded: false };

    const ids = teamRows.map((row: any) => String(row.team_id));
    const search = like ? sql` AND (e.full_name ILIKE ${like} OR e.designation ILIKE ${like})` : sql``;
    const mr = await db.execute(sql`
      SELECT a.team_id::text AS team_id,
             e.id AS n_id, e.user_id AS n_user_id, e.full_name AS n_full_name,
             e.designation AS n_designation, e.department_id::text AS n_department_id
        FROM org_employee_assignments a
        JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.team_id::text IN (${textList(ids)})
         AND ${inForce('a', at)}
         AND ${inScope('e', scope)}${search}
       ORDER BY e.full_name ASC
       LIMIT ${MAX_CHART_NODES + 1}`);
    const memberRows = rows(mr);
    const truncated = memberRows.length > MAX_CHART_NODES;

    const deptIds = teamRows
      .map((row: any) => (row?.dept_id ? String(row.dept_id) : ''))
      .filter((d: string) => d.length > 0);
    const names = await departmentNames(deptIds);

    const byTeam = new Map<string, RawNode[]>();
    for (const row of memberRows.slice(0, MAX_CHART_NODES)) {
      const key = String(row.team_id);
      const bucket = byTeam.get(key) || [];
      bucket.push({ person: mapPersonRow(row, 'n_'), depth: 0, parentEmployeeId: null });
      byTeam.set(key, bucket);
    }

    const groups: OrgTreeGroup[] = [];
    for (const row of teamRows) {
      const id = String(row.team_id);
      const members = byTeam.get(id) || [];
      let roots = buildTrees(members, {
        viewerEmployeeId: scope.employeeId,
        like,
        deptNames: names,
      });
      if (like) roots = pruneToMatches(roots);
      if (like && roots.length === 0) continue;
      const dept = row?.dept_id ? names.get(String(row.dept_id)) || String(row.dept_id) : null;
      groups.push({
        key: id,
        title: row?.team_name ? String(row.team_name) : 'Team',
        subtitle: dept ? 'In ' + dept : null,
        roots,
        people: countTree(roots),
      });
    }
    return { groups, truncated, degraded: false };
  } catch (e: any) {
    logFail('teamGroups', e);
    return { groups: [], truncated: false, degraded: true };
  }
}

// -------------------------------------------------------------------------------------------------
// THE PUBLIC BUILDER
// -------------------------------------------------------------------------------------------------

const VIEW_META = new Map<string, { label: string; blurb: string }>(
  ORG_VIEWS.map((v) => [v.key as string, { label: v.label, blurb: v.blurb }]),
);

function baseModel(view: OrgViewKey, scope: OrgViewerScope): OrgViewModel {
  const meta = VIEW_META.get(view) || { label: 'Organization', blurb: '' };
  return {
    view,
    label: meta.label,
    blurb: meta.blurb,
    scope,
    groups: [],
    edges: [],
    people: 0,
    truncated: false,
    unattached: null,
    notice: null,
    emptyTitle: 'Nothing recorded here yet',
    emptyBody: 'When this kind of relationship is recorded in the graph, it will appear here.',
  };
}

/**
 * Build one view, for one viewer.
 *
 * THE FIRST BRANCH IS THE EMPTY GRAPH, and that is not defensive coding — it is the DEFAULT PATH.
 * Until the founder runs db/org-graph-backfill.sql there are no relationships at all, so "not yet
 * initialized" is what the first person to open this page will see, and it has to be a real screen
 * rather than an afterthought. It is deliberately NOT the same as "you have no relationships": one
 * says the system has no data, the other says this person has none, and a chart that confuses them
 * tells every employee they report to nobody.
 */
export async function buildOrgView(
  view: OrgViewKey,
  scope: OrgViewerScope,
  opts: OrgViewOptions = {},
): Promise<OrgViewModel> {
  const model = baseModel(view, scope);

  // 1. THE GRAPH IS EMPTY. One answer for everybody, regardless of what they hold.
  if (!scope.initialized) {
    return {
      ...model,
      emptyTitle: 'Organization Graph not yet initialized',
      emptyBody:
        'No reporting lines, department heads, mentors or delegations have been recorded yet. ' +
        'The graph is filled by a one-time backfill an administrator runs against the database; ' +
        'until then there is nothing to draw, and nothing here is guessed from job titles or ' +
        'account settings.',
      notice: scope.degraded ? 'Some of this could not be read just now: ' + scope.gaps.join(', ') + '.' : null,
    };
  }

  // 2. THE VIEWER HAS NO PLACE IN THE GRAPH. Distinct sentence, distinct cause.
  if (scope.kind === 'none') {
    return {
      ...model,
      emptyTitle: 'You are not on the organization graph',
      emptyBody:
        'The graph has relationships recorded, but none of them name you and your account has no ' +
        'employee record linked to it. Ask HR to link your record if that looks wrong.',
    };
  }

  const like = likeOf(opts.q);

  // 3. THE THREE EDGE VIEWS.
  if (view === 'delegation' || view === 'approval' || view === 'mentorship') {
    const type =
      view === 'delegation' ? 'temporary_delegate' : view === 'approval' ? 'approval_owner' : 'mentor';
    const res = await edgeList(type, scope, opts);
    const emptyTitle =
      view === 'delegation'
        ? 'Nobody is standing in for anybody'
        : view === 'approval'
          ? 'No approval ownership recorded'
          : 'No mentorships recorded';
    const emptyBody =
      view === 'delegation'
        ? 'A delegation appears here only while its dates are in force, so an empty list means everyone is covering their own work today.'
        : view === 'approval'
          ? 'Approval ownership says where a request routes. With none recorded, routing falls to the reporting line and to whoever holds the approval capability.'
          : 'Mentorship is recorded separately from the reporting line, and confers no authority over anyone.';
    return {
      ...model,
      edges: res.edges,
      truncated: res.truncated,
      notice: res.degraded
        ? 'The organization graph could not be read just now, so this list may be incomplete.'
        : res.truncated
          ? 'Showing the first ' + MAX_EDGE_ROWS + ' rows. Narrow the search to see the rest.'
          : null,
      emptyTitle: like ? 'Nothing matched that search' : emptyTitle,
      emptyBody: like
        ? 'The search ran inside what you are entitled to see, so a name outside your view will never match here.'
        : emptyBody,
    };
  }

  // 4. THE DEPARTMENT TREE.
  if (view === 'department') {
    const res = await departmentGroups(scope, opts);
    return {
      ...model,
      groups: res.groups,
      people: res.groups.reduce((n, g) => n + g.people, 0),
      truncated: res.truncated,
      notice: res.degraded
        ? 'Departments could not be read just now, so this tree may be incomplete.'
        : res.truncated
          ? 'Showing the first ' + MAX_CHART_NODES + ' people. Filter by department to see the rest.'
          : null,
      emptyTitle: like ? 'Nothing matched that search' : 'No departments in view',
      emptyBody: like
        ? 'The search ran inside what you are entitled to see.'
        : 'A department appears here once it exists and someone is recorded in it. The head comes from the graph; membership comes from each person’s own record.',
    };
  }

  // 5. THE TEAM TREE.
  if (view === 'team') {
    const res = await teamGroups(scope, opts);
    return {
      ...model,
      groups: res.groups,
      people: res.groups.reduce((n, g) => n + g.people, 0),
      truncated: res.truncated,
      notice: res.degraded
        ? 'The team structure could not be read just now. It is stored in a separate set of tables from the relationships themselves.'
        : res.truncated
          ? 'Showing the first ' + MAX_CHART_NODES + ' people.'
          : null,
      emptyTitle: like ? 'Nothing matched that search' : 'No teams recorded',
      emptyBody: like
        ? 'The search ran inside what you are entitled to see.'
        : 'Teams live in their own table and are separate from departments. None have been created yet, so there is no team tree to draw — this is not the same as the graph being empty.',
    };
  }

  // 6. THE REPORTING HIERARCHY — one person's line, top to bottom.
  if (view === 'reporting') {
    // The focus is the viewer unless a valid in-scope employee id was asked for. An out-of-scope id
    // is IGNORED rather than refused with a message: telling somebody "that person exists but is not
    // yours to see" is itself a disclosure.
    const asked = String(opts.focusEmployeeId || '').trim();
    let focus = scope.employeeId;
    if (isUuid(asked) && scope.kind !== 'self' && (await employeeIsInScope(asked, scope))) focus = asked;
    if (!focus) {
      return {
        ...model,
        emptyTitle: 'No line to show',
        emptyBody: 'Your account has no employee record, so there is no reporting line to centre this on.',
      };
    }
    const res = await selfLine(focus);
    const deptIds = res.nodes
      .map((n) => n.person.departmentId || '')
      .filter((d) => d.length > 0);
    const names = await departmentNames(deptIds);
    let roots = buildTrees(res.nodes, {
      viewerEmployeeId: scope.employeeId,
      like,
      deptNames: names,
      viewerName: opts.viewerName || null,
    });
    if (like) roots = pruneToMatches(roots);
    const people = countTree(roots);
    return {
      ...model,
      groups: people > 0 ? [{ key: 'line', title: 'Reporting line', subtitle: null, roots, people }] : [],
      people,
      notice: res.degraded
        ? 'The reporting line could not be read just now.'
        : scope.kind === 'self'
          ? 'This is your own line. Everyone else’s is outside what you are entitled to see, so they are not fetched at all.'
          : null,
      emptyTitle: 'No reporting relationship recorded',
      emptyBody:
        'The graph has data, and none of it names this person as a manager or a report. That is a ' +
        'gap in the records rather than a statement about the work — ask HR to record the line.',
    };
  }

  // 7. THE ORGANIZATION CHART.
  if (scope.kind === 'self') {
    // A person entitled only to their own line gets exactly that here too, assembled from the API.
    // Two views showing the same thing is honest for this viewer; pretending there is a company-wide
    // chart behind a tab they cannot open would not be.
    const res = await selfLine(scope.employeeId as string);
    const deptIds = res.nodes.map((n) => n.person.departmentId || '').filter((d) => d.length > 0);
    const names = await departmentNames(deptIds);
    let roots = buildTrees(res.nodes, {
      viewerEmployeeId: scope.employeeId,
      like,
      deptNames: names,
      viewerName: opts.viewerName || null,
    });
    if (like) roots = pruneToMatches(roots);
    const people = countTree(roots);
    return {
      ...model,
      groups: people > 0 ? [{ key: 'line', title: 'Your reporting line', subtitle: null, roots, people }] : [],
      people,
      notice: res.degraded
        ? 'Your reporting line could not be read just now.'
        : 'You are entitled to your own line, so that is what is queried — the rest of the chart is never fetched.',
      emptyTitle: 'No reporting relationship recorded for you',
      emptyBody:
        'The graph has data, and none of it names you as a manager or a report. Ask HR to record ' +
        'your reporting line.',
    };
  }

  const forest = await reportingForest(scope, { departmentId: opts.departmentId });
  const deptIds = forest.nodes.map((n) => n.person.departmentId || '').filter((d) => d.length > 0);
  const names = await departmentNames(deptIds);
  let roots = buildTrees(forest.nodes, {
    viewerEmployeeId: scope.employeeId,
    like,
    deptNames: names,
  });
  if (like) roots = pruneToMatches(roots);
  const people = countTree(roots);
  const unattached = await unattachedCount(scope);

  return {
    ...model,
    groups: roots.map((root, i) => ({
      key: root.employeeId || 'root-' + i,
      title: root.fullName || 'Unnamed record',
      subtitle: root.designation || null,
      roots: [root],
      people: countTree([root]),
    })),
    people,
    truncated: forest.truncated,
    unattached,
    notice: forest.degraded
      ? 'The organization graph could not be read just now, so this chart may be incomplete.'
      : forest.truncated
        ? 'Showing the first ' + MAX_CHART_NODES + ' people, closest to the top first. Search or filter to reach the rest.'
        : null,
    emptyTitle: like ? 'Nothing matched that search' : 'No reporting lines in view',
    emptyBody: like
      ? 'The search ran inside what you are entitled to see, so a name outside your view will never match here.'
      : 'The graph has relationships recorded, and none of them are reporting lines inside what you can see.',
  };
}

/**
 * Is this employee inside the viewer's scope?
 *
 * Used ONLY to validate a focus id that arrived in a query string. It answers from the same
 * predicate every other query uses, so a focus can never reach outside the scope — and it answers
 * FALSE on any error, which lands the reader on their own line rather than on somebody else's.
 */
async function employeeIsInScope(employeeId: string, scope: OrgViewerScope): Promise<boolean> {
  if (!isUuid(employeeId)) return false;
  if (scope.kind === 'none') return false;
  if (scope.kind === 'self') return employeeId === scope.employeeId;
  try {
    const r = await db.execute(sql`
      SELECT 1 AS ok
        FROM hr_employees e
       WHERE e.id = ${employeeId}::uuid
         AND ${inScope('e', scope)}
       LIMIT 1`);
    return rows(r).length > 0;
  } catch (e: any) {
    logFail('employeeIsInScope', e);
    return false;
  }
}

/**
 * The departments offered in the filter control.
 *
 * ONLY the ones already inside the scope, so the control itself cannot suggest a place the person
 * may not look. For a 'full' viewer that is every department; for a head, the ones they head; for
 * everyone else, none — and the control is not rendered at all.
 */
export async function scopeDepartmentOptions(
  scope: OrgViewerScope,
): Promise<{ id: string; name: string }[]> {
  if (!scope.initialized) return [];
  try {
    if (scope.kind === 'departments') {
      const names = await departmentNames(scope.departmentIds);
      return scope.departmentIds.map((id) => ({ id, name: names.get(id) || id }));
    }
    if (scope.kind !== 'full') return [];
    const r = await db.execute(sql`
      SELECT d.id::text AS id, d.name AS name
        FROM departments d
       ORDER BY d.name ASC
       LIMIT 200`);
    return rows(r)
      .filter((row: any) => !!row?.id)
      .map((row: any) => ({ id: String(row.id), name: row?.name ? String(row.name) : String(row.id) }));
  } catch (e: any) {
    logFail('scopeDepartmentOptions', e);
    return [];
  }
}

/**
 * People matching a search term, INSIDE the viewer's scope.
 *
 * This is what makes the reporting-hierarchy view usable for someone entitled to more than their own
 * line: type a name, get the people you may look at, open that person's line. A name outside the
 * scope produces no row — not a greyed-out row, not a "you may not see this person" message, which
 * would itself confirm that the person exists.
 *
 * Never called for a 'self' viewer: there is exactly one person in that scope and they are already
 * looking at them.
 */
export async function searchPeople(
  scope: OrgViewerScope,
  q: string | null | undefined,
  limit = 20,
): Promise<OrgPerson[]> {
  const like = likeOf(q);
  if (!like || !scope.initialized) return [];
  if (scope.kind === 'none' || scope.kind === 'self') return [];
  const cap = Number.isFinite(limit) && limit > 0 && limit <= 50 ? Math.floor(limit) : 20;
  try {
    const r = await db.execute(sql`
      SELECT e.id AS n_id, e.user_id AS n_user_id, e.full_name AS n_full_name,
             e.designation AS n_designation, e.department_id::text AS n_department_id
        FROM hr_employees e
       WHERE e.is_active = TRUE
         AND ${inScope('e', scope)}
         AND (e.full_name ILIKE ${like} OR e.designation ILIKE ${like} OR e.employee_code ILIKE ${like})
       ORDER BY e.full_name ASC
       LIMIT ${cap}`);
    return rows(r).map((row: any) => mapPersonRow(row, 'n_'));
  } catch (e: any) {
    logFail('searchPeople', e);
    return [];
  }
}

/**
 * A one-line factual summary of a person's other recorded relationships, for the detail strip under
 * a focused node. Asked ONLY through the org-graph API — no new query, no new rule.
 *
 * Returns empty strings rather than throwing: a missing detail line is a cosmetic loss, and this
 * must never be the reason a chart fails to render.
 */
export async function personDetail(
  employeeId: string,
): Promise<{ managerName: string | null; mentorName: string | null; delegateNames: string[] }> {
  if (!isUuid(employeeId)) return { managerName: null, mentorName: null, delegateNames: [] };
  try {
    const [manager, mentor, delegates] = await Promise.all([
      getManager(employeeId),
      getMentor(employeeId),
      getDelegates(employeeId),
    ]);
    return {
      managerName: manager?.fullName || null,
      mentorName: mentor?.fullName || null,
      delegateNames: delegates.map((d) => d.fullName || '').filter((n) => n.length > 0),
    };
  } catch (e: any) {
    logFail('personDetail', e);
    return { managerName: null, mentorName: null, delegateNames: [] };
  }
}
