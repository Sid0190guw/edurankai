// src/lib/search-global.ts — ONE SEARCH ACROSS THE WORKPLACE.
//
// =================================================================================================
// THE RULE THIS FILE EXISTS TO ENFORCE
// =================================================================================================
//
// AUTHORIZATION IS PART OF THE QUERY. A result the viewer may not open is NEVER RETURNED AND THEN
// HIDDEN — it is never selected. There is no `visible` flag on a hit, no filter step after the
// fetch, and no CSS anywhere that hides a row.
//
// That is not fussiness. A search box is the one screen in a product where a person can probe for
// things they cannot see: a hit count that changes as you type a colleague's surname tells you the
// colleague exists, and a title in a "you cannot open this" placeholder is the leak itself. So every
// source below narrows in its WHERE clause, and the count a person sees is the count of what they
// may open.
//
// =================================================================================================
// WHY THIS FILE IS NOT src/lib/search-index.ts
// =================================================================================================
//
// search-index.ts is the LEARNER search: published kernel objects, course material, security labels,
// its own edu_search_index table. It answers "what can a student find in the catalogue". This
// answers "where is that thing at work" for a member of staff. Two populations, two authorization
// models, and folding one into the other would mean one set of rules deciding both.
//
// WHAT IS REUSED RATHER THAN REWRITTEN: tokenize(). One definition of what a word is, so the two
// searches agree about punctuation and about the shortest thing worth matching.
//
// THIS MODULE OWNS NO TABLE. It creates nothing and indexes nothing. Every source reads the system
// that already holds those rows, live, so a result is never a stale copy of a row that has since
// been deleted — which is what a hand-maintained search index quietly becomes.
//
// =================================================================================================
// HOW EACH SOURCE IS SCOPED
// =================================================================================================
//
//   People       Through resolveOrgViewerScope() — the SAME function /portal/organization uses, so
//                the org chart and the search agree about who you may see. `employee.manage` sees
//                everyone; a department_head EDGE IN THE GRAPH sees that department; an employee
//                record sees themselves. Never users.role.
//   Departments  Every department for a holder of `employee.manage`; otherwise the viewer's own and
//                any they head on the graph.
//   Tasks        Own tasks, plus tasks they assigned to somebody else. Both are relationships to the
//                row, expressed in the WHERE clause.
//   Documents    Their own joining documents, keyed by users.id, which is how that table is keyed.
//   Policies     Published content pages for anyone signed in; unpublished drafts only for a holder
//                of `content.view`, which is the capability the content console already asks for.
//   Projects     ABSENT. There is no projects table in this database. It returns an honest note.
//   Announcements ABSENT, for the same reason. See the note on each.
//
// NO SOURCE RETURNS AN EMAIL ADDRESS, A PHONE NUMBER, A SALARY, A GOVERNMENT ID OR ANYTHING FROM A
// wellness_* TABLE. A search result is a signpost — a name, what the thing is, and where to open it.
//
// =================================================================================================
// HOUSE RULES
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS; `r.rows[0]` is a bug.
//   - The real Postgres reason is on e.cause.
//   - department ids compared ::text, never ::uuid.
//   - Every source is independently wrapped: one failing source degrades to "this part could not be
//     searched" beside the others rather than blanking the page.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { tokenize } from './search-index';
import { resolveOrgViewerScope, type OrgViewerScope } from './org-chart';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — above every function that reads them.
// -------------------------------------------------------------------------------------------------

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

const logFail = (tag: string, e: any) =>
  console.error('[search-global] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Hits per source. Enough to be useful on a phone, small enough that seven sources stay quick. */
const PER_SOURCE_LIMIT = 8;

/** Longest query we will act on. Everything past this is dropped rather than sent to the database. */
const MAX_QUERY_CHARS = 80;

/** Most tokens we will AND together. Four words is a long workplace search. */
const MAX_TOKENS = 6;

/** Shortest query worth running. One letter matches most of the company and helps nobody. */
export const MIN_QUERY_CHARS = 2;

export const SEARCH_SOURCES = [
  { key: 'people', label: 'People' },
  { key: 'departments', label: 'Departments' },
  { key: 'projects', label: 'Projects' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'documents', label: 'Documents' },
  { key: 'announcements', label: 'Announcements' },
  { key: 'policies', label: 'Policies and pages' },
] as const;

export type SearchSourceKey = (typeof SEARCH_SOURCES)[number]['key'];

export interface SearchHit {
  id: string;
  source: SearchSourceKey;
  title: string;
  /** What kind of thing this is, in words. */
  kind: string;
  /** A second line: a designation, a department, a due date. Never contact details. */
  detail: string | null;
  /** Where it opens. Every one of these is a route that exists. */
  href: string;
}

export interface SearchSourceResult {
  key: SearchSourceKey;
  label: string;
  hits: SearchHit[];
  /** False when the source could not be searched, or does not exist in this product yet. */
  available: boolean;
  /**
   * A sentence: why there is nothing, what could not be read, or what part of the product does not
   * exist. Rendered verbatim — "no results" on its own is what makes a search feel broken.
   */
  note: string | null;
  /** One sentence saying what this viewer was allowed to search here. Rendered under the group. */
  scopeNote: string | null;
}

export interface SearchModel {
  query: string;
  sources: SearchSourceResult[];
  hitCount: number;
  /** True when at least one source could not be searched. */
  degraded: boolean;
  /** True when the query was too short to run. Not an error — the page invites a longer one. */
  tooShort: boolean;
}

/** Everything a search is allowed to know about the reader. `holds` is the composition's own test. */
export interface SearchViewer {
  userId: string;
  employeeId: string | null;
  departmentId: string | null;
  holds: (key: string) => boolean;
}

// -------------------------------------------------------------------------------------------------
// QUERY SHAPING
// -------------------------------------------------------------------------------------------------

/**
 * The tokens a query actually searches for.
 *
 * tokenize() is search-index.ts's, so both searches agree that punctuation is not a word and that a
 * single letter is not worth matching. Capped at MAX_TOKENS so a pasted paragraph cannot build a
 * WHERE clause with two hundred ILIKEs in it.
 */
export function searchTokens(query: string): string[] {
  return [...new Set(tokenize(String(query || '').slice(0, MAX_QUERY_CHARS)))].slice(0, MAX_TOKENS);
}

/**
 * `col ILIKE '%a%' AND col ILIKE '%b%'` over one or more columns, as BOUND PARAMETERS.
 *
 * Every token is a parameter, never interpolated text: the pattern is built with a `%` on each side
 * in TypeScript and passed as a value, so a query containing a quote or a percent sign is matched
 * literally instead of changing the statement. `columns` is a compile-time literal at every call
 * site below and never comes from a request.
 *
 * AND across tokens, OR across columns: "priya design" finds a person named Priya in Design, which
 * is what somebody typing two words means.
 */
function matchAll(columns: ReturnType<typeof sql.raw>[], tokens: string[]) {
  const perToken = tokens.map((t) => {
    const pattern = '%' + t.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
    const perColumn = columns.map((c) => sql`COALESCE(${c}, '') ILIKE ${pattern}`);
    return sql`(${sql.join(perColumn, sql` OR `)})`;
  });
  return sql.join(perToken, sql` AND `);
}

function unavailable(key: SearchSourceKey, note: string, scopeNote: string | null = null): SearchSourceResult {
  const def = SEARCH_SOURCES.find((s) => s.key === key);
  return { key, label: def ? def.label : key, hits: [], available: false, note, scopeNote };
}

function result(
  key: SearchSourceKey,
  hits: SearchHit[],
  scopeNote: string | null,
  emptyNote: string,
): SearchSourceResult {
  const def = SEARCH_SOURCES.find((s) => s.key === key);
  return {
    key,
    label: def ? def.label : key,
    hits,
    available: true,
    note: hits.length ? null : emptyNote,
    scopeNote,
  };
}

// -------------------------------------------------------------------------------------------------
// SOURCES
// -------------------------------------------------------------------------------------------------

/**
 * PEOPLE. The scope is decided before the query and expressed inside it.
 *
 * 'full'        every active employee.
 * 'departments' the departments the GRAPH records this person as heading.
 * 'self'        their own row and nobody else's.
 * 'none'        no query is run at all.
 *
 * The 'self' case still runs a search rather than short-circuiting, because "search for your own
 * name and find yourself" is a sane result and returning nothing would read as a broken index.
 */
async function peopleSource(query: string, tokens: string[], scope: OrgViewerScope): Promise<SearchSourceResult> {
  const scopeNote = scope.explanation;

  if (!scope.initialized && scope.kind !== 'full' && scope.kind !== 'self') {
    return unavailable(
      'people',
      'The organization graph has no relationships recorded yet, so there is no basis for deciding whose records you may search. Your own record is still searchable once HR has linked one to this account.',
      scopeNote,
    );
  }
  if (scope.kind === 'none') {
    return unavailable(
      'people',
      'No employee record is linked to this account, and you do not hold the capability to administer employee records, so there is nobody in scope to search.',
      scopeNote,
    );
  }

  try {
    let where = sql`e.is_active = TRUE`;
    if (scope.kind === 'self') {
      if (!isUuid(scope.employeeId)) {
        return unavailable('people', 'No employee record is linked to this account.', scopeNote);
      }
      where = sql`${where} AND e.id = ${scope.employeeId}::uuid`;
    } else if (scope.kind === 'departments') {
      if (!scope.departmentIds.length) {
        return unavailable('people', 'You do not head a department on the organization graph.', scopeNote);
      }
      where = sql`${where} AND e.department_id::text IN (${sql.join(
        scope.departmentIds.map((d) => sql`${String(d)}::text`),
        sql`, `,
      )})`;
    }

    // Only columns a directory entry needs. No email, no phone, no salary, no government id.
    const r = await db.execute(sql`
      SELECT e.id, e.full_name, e.designation, e.employee_code, d.name AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE ${where}
         AND ${matchAll([sql.raw('e.full_name'), sql.raw('e.designation'), sql.raw('e.employee_code')], tokens)}
       ORDER BY e.full_name ASC
       LIMIT ${PER_SOURCE_LIMIT}`);

    const hits: SearchHit[] = rows(r).map((row: any) => ({
      id: 'p-' + String(row?.id || ''),
      source: 'people' as const,
      title: row?.full_name ? String(row.full_name) : 'Unnamed record',
      kind: 'Person',
      detail: [row?.designation ? String(row.designation) : '', row?.department_name ? String(row.department_name) : '']
        .filter(Boolean)
        .join(' - ') || null,
      // The org chart is the surface that shows one person in their context, and it scopes itself
      // per viewer in its own query — so a link here cannot become a way around that scoping.
      href: '/portal/organization?view=reporting&focus=' + encodeURIComponent(String(row?.id || '')),
    }));

    return result('people', hits, scopeNote, 'Nobody in scope matches "' + query + '".');
  } catch (e: any) {
    logFail('peopleSource', e);
    return unavailable('people', 'People could not be searched just now.', scopeNote);
  }
}

/** DEPARTMENTS. Everything for employee.manage; otherwise the viewer's own plus any they head. */
async function departmentSource(
  query: string,
  tokens: string[],
  viewer: SearchViewer,
  scope: OrgViewerScope,
): Promise<SearchSourceResult> {
  const wide = viewer.holds('employee.manage');
  const allowed = new Set<string>();
  if (viewer.departmentId) allowed.add(String(viewer.departmentId));
  for (const d of scope.departmentIds) allowed.add(String(d));

  const scopeNote = wide
    ? 'You are searching every department, because you hold the capability to administer employee records.'
    : allowed.size
      ? 'You are searching your own department and any the organization graph records you as heading.'
      : 'No department is recorded on your employee record, and the graph does not record you as heading one.';

  if (!wide && allowed.size === 0) {
    return unavailable(
      'departments',
      'There is no department in scope for you to search. Department is recorded on an employee record by HR, and heading one is a relationship on the organization graph.',
      scopeNote,
    );
  }

  try {
    const filter = wide
      ? sql``
      : sql`AND d.id::text IN (${sql.join([...allowed].map((x) => sql`${x}::text`), sql`, `)})`;
    const r = await db.execute(sql`
      SELECT d.id::text AS id, d.name
        FROM departments d
       WHERE ${matchAll([sql.raw('d.name')], tokens)} ${filter}
       ORDER BY d.name ASC
       LIMIT ${PER_SOURCE_LIMIT}`);
    const hits: SearchHit[] = rows(r).map((row: any) => ({
      id: 'd-' + String(row?.id || ''),
      source: 'departments' as const,
      title: String(row?.name || 'Department'),
      kind: 'Department',
      detail: null,
      href: '/portal/organization?view=department&dept=' + encodeURIComponent(String(row?.id || '')),
    }));
    return result('departments', hits, scopeNote, 'No department in scope matches "' + query + '".');
  } catch (e: any) {
    logFail('departmentSource', e);
    return unavailable('departments', 'Departments could not be searched just now.', scopeNote);
  }
}

/**
 * PROJECTS. There is no project system in this database.
 *
 * Stated rather than silently omitted, and stated with the evidence, so the next person does not
 * spend an afternoon rediscovering it: employee_tasks has no project relation, and there is no
 * projects table, project_id column or projectId anywhere in src/ or db/. Inventing a projects
 * source here would mean inventing a table, and a search that quietly drops a whole category is how
 * somebody concludes their project was deleted.
 */
function projectSource(): SearchSourceResult {
  return unavailable(
    'projects',
    'There is no project system in this product yet: no projects table, and tasks do not belong to a project. This is a missing module, not an empty search. Nothing here is hidden from you.',
    null,
  );
}

/** TASKS. Own tasks, and tasks this person assigned. Both are relationships to the row. */
async function taskSource(query: string, tokens: string[], viewer: SearchViewer): Promise<SearchSourceResult> {
  const scopeNote = 'You are searching your own tasks and tasks you assigned to somebody else.';
  if (!isUuid(viewer.userId)) {
    return unavailable('tasks', 'Tasks are searched against your sign-in, which could not be read.', scopeNote);
  }
  try {
    const mine = isUuid(viewer.employeeId)
      ? sql`t.employee_id = ${String(viewer.employeeId)}::uuid OR t.assigned_by_user_id = ${viewer.userId}::uuid`
      : sql`t.assigned_by_user_id = ${viewer.userId}::uuid`;
    const r = await db.execute(sql`
      SELECT t.id, t.title, t.status, t.priority, t.due_on
        FROM employee_tasks t
       WHERE (${mine})
         AND ${matchAll([sql.raw('t.title'), sql.raw('t.description')], tokens)}
       ORDER BY (t.status <> 'done') DESC, t.due_on ASC NULLS LAST
       LIMIT ${PER_SOURCE_LIMIT}`);
    const hits: SearchHit[] = rows(r).map((row: any) => ({
      id: 't-' + String(row?.id || ''),
      source: 'tasks' as const,
      title: String(row?.title || 'Task'),
      kind: 'Task',
      detail: [
        row?.status ? String(row.status).replace(/_/g, ' ') : '',
        row?.due_on ? 'due ' + String(row.due_on).slice(0, 10) : '',
      ]
        .filter(Boolean)
        .join(' - ') || null,
      href: '/portal/tasks',
    }));
    return result('tasks', hits, scopeNote, 'None of your tasks match "' + query + '".');
  } catch (e: any) {
    logFail('taskSource', e);
    return unavailable('tasks', 'Tasks could not be searched just now.', scopeNote);
  }
}

/**
 * DOCUMENTS. The joining documents this person submitted, and only those.
 *
 * hr_onboarding_documents is keyed on users.id as TEXT (src/lib/hr-onboarding.ts:43), so the
 * comparison is ::text on both sides. Documents in this product are Google Drive LINKS by standing
 * rule, never uploads, so a hit is a link somebody recorded — the title and the type are shown and
 * the URL is not, because a search result page is not the place to hand out document links.
 *
 * HONEST LIMIT: the company document library being built alongside this is a separate module with
 * its own store, and its rows are not in this search yet. Saying so is better than a search that
 * looks complete and is not.
 */
async function documentSource(query: string, tokens: string[], viewer: SearchViewer): Promise<SearchSourceResult> {
  const scopeNote = 'You are searching the joining documents recorded against your own account.';
  if (!viewer.userId) {
    return unavailable('documents', 'Documents are searched against your sign-in, which could not be read.', scopeNote);
  }
  try {
    const r = await db.execute(sql`
      SELECT o.id::text AS id, o.title, o.doc_type, o.status
        FROM hr_onboarding_documents o
       WHERE o.user_id::text = ${viewer.userId}::text
         AND ${matchAll([sql.raw('o.title'), sql.raw('o.doc_type')], tokens)}
       ORDER BY o.id DESC
       LIMIT ${PER_SOURCE_LIMIT}`);
    const hits: SearchHit[] = rows(r).map((row: any) => ({
      id: 'doc-' + String(row?.id || ''),
      source: 'documents' as const,
      title: String(row?.title || row?.doc_type || 'Document'),
      kind: 'Joining document',
      detail: row?.status ? String(row.status) : null,
      href: '/portal/onboarding',
    }));
    return result(
      'documents',
      hits,
      scopeNote,
      'None of your joining documents match "' + query + '". The company document library is a separate module and its documents are not in this search yet.',
    );
  } catch (e: any) {
    logFail('documentSource', e);
    return unavailable('documents', 'Documents could not be searched just now.', scopeNote);
  }
}

/**
 * ANNOUNCEMENTS. There is no announcements store in this database.
 *
 * Stated with the evidence, exactly as projects is: src/lib/workforce/widgets.ts records
 * announcements.latest as unregistered for the same reason, and discussions.is_pinned cannot stand
 * in because nothing writes it. An announcements source that quietly returned discussion posts would
 * be inventing an editorial channel that nobody publishes to.
 */
function announcementSource(): SearchSourceResult {
  return unavailable(
    'announcements',
    'There is no announcements store in this product yet, so there is nothing to search. This is a missing module, not an empty search.',
    null,
  );
}

/**
 * POLICIES AND PAGES. Published content pages for anyone; drafts only for `content.view`.
 *
 * These are the real policy and information pages the product publishes at /p/<slug>. Draft pages
 * are somebody's unfinished writing and are gated on the same capability the content console asks
 * for, so search does not become a way to read a policy before it is issued.
 */
async function policySource(query: string, tokens: string[], viewer: SearchViewer): Promise<SearchSourceResult> {
  const seesDrafts = viewer.holds('content.view');
  const scopeNote = seesDrafts
    ? 'You are searching published pages and unpublished drafts, because you hold the capability to view content.'
    : 'You are searching published pages only. Drafts are not searched.';
  try {
    const publishedOnly = seesDrafts ? sql`` : sql`AND c.is_published = TRUE`;
    const r = await db.execute(sql`
      SELECT c.slug, c.title, c.is_published
        FROM content_pages c
       WHERE ${matchAll([sql.raw('c.title'), sql.raw('c.slug'), sql.raw('c.meta_description')], tokens)}
         ${publishedOnly}
       ORDER BY c.is_published DESC, c.title ASC
       LIMIT ${PER_SOURCE_LIMIT}`);
    const hits: SearchHit[] = rows(r).map((row: any) => ({
      id: 'pol-' + String(row?.slug || ''),
      source: 'policies' as const,
      title: String(row?.title || row?.slug || 'Page'),
      kind: row?.is_published ? 'Published page' : 'Draft page',
      detail: row?.is_published ? null : 'Not published yet',
      href: '/p/' + encodeURIComponent(String(row?.slug || '')),
    }));
    return result('policies', hits, scopeNote, 'No page matches "' + query + '".');
  } catch (e: any) {
    logFail('policySource', e);
    return unavailable('policies', 'Pages could not be searched just now.', scopeNote);
  }
}

// -------------------------------------------------------------------------------------------------
// THE SEARCH
// -------------------------------------------------------------------------------------------------

/**
 * Search everything this person may open, and nothing else.
 *
 * The org scope is resolved ONCE and shared by the people and department sources, so a search costs
 * one graph resolution rather than two. Sources run in sequence rather than in parallel on purpose:
 * this runs on a Supabase transaction pooler, and seven simultaneous statements from one request is
 * how a connection pool starts refusing other people's page loads.
 */
export async function globalSearch(query: string, viewer: SearchViewer): Promise<SearchModel> {
  const q = String(query || '').trim().slice(0, MAX_QUERY_CHARS);
  const tokens = searchTokens(q);

  if (q.length < MIN_QUERY_CHARS || tokens.length === 0) {
    return {
      query: q,
      sources: [],
      hitCount: 0,
      degraded: false,
      tooShort: true,
    };
  }

  let scope: OrgViewerScope;
  try {
    scope = await resolveOrgViewerScope(viewer.userId, viewer.holds);
  } catch (e: any) {
    // resolveOrgViewerScope already fails closed; this is the belt for anything it could not catch.
    logFail('resolveOrgViewerScope', e);
    scope = {
      initialized: false,
      kind: 'none',
      employeeId: null,
      departmentIds: [],
      departmentNames: [],
      degraded: true,
      gaps: ['the organization graph'],
      explanation: 'We could not work out what you are entitled to see, so nothing is searched.',
    };
  }

  const sources: SearchSourceResult[] = [
    await peopleSource(q, tokens, scope),
    await departmentSource(q, tokens, viewer, scope),
    projectSource(),
    await taskSource(q, tokens, viewer),
    await documentSource(q, tokens, viewer),
    announcementSource(),
    await policySource(q, tokens, viewer),
  ];

  const hitCount = sources.reduce((n, s) => n + s.hits.length, 0);
  // A source that does not exist in the product (projects, announcements) is not a degraded read —
  // it is a stated absence. Only a source that exists and could not be read counts as degraded, so
  // the page does not permanently warn about something that is simply not built.
  const degraded = sources.some(
    (s) => !s.available && s.key !== 'projects' && s.key !== 'announcements',
  );

  return { query: q, sources, hitCount, degraded, tooShort: false };
}
