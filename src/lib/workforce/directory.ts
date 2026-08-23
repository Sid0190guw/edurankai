/**
 * src/lib/workforce/directory.ts — FINDING A COLLEAGUE WHEN THERE ARE TEN MILLION OF THEM.
 *
 * =================================================================================================
 * WHY THIS EXISTS AND WHAT IT IS NOT
 * =================================================================================================
 *
 * "Who is this person, what do they do, and which department are they in" is the single most
 * frequent question anybody asks of a workforce system, and at a hundred employees you answer it by
 * asking a neighbour. At a large roll there is no neighbour who knows, and the product needs a
 * surface for it.
 *
 * What already existed is /portal/search — one box across seven sources, eight hits per source, no
 * paging. That is the right shape for "I half-remember a name" and the wrong shape for "show me the
 * people in my department, in order, and let me page through them". This module is the second shape,
 * and it deliberately shares the first one's ANSWER to the only question that matters:
 *
 *   IT ADDS NO SCOPE. resolveOrgViewerScope() — the same function /portal/organization and
 *   /portal/search both use — decides who this viewer may see, and this module does not widen it by
 *   a single row. `employee.manage` sees everyone; a department-head EDGE IN THE GRAPH sees that
 *   department; an ordinary employee record sees itself. A directory that quietly showed the whole
 *   company because a directory "obviously should" would be a new authorization decision taken
 *   inside a paging helper, which is exactly how a scope widens without anybody deciding to widen it.
 *
 *   IT ADDS NO COLUMNS. Name, designation, employee code, department. The same set the people search
 *   returns, and its comment — "No email, no phone, no salary, no government id" — governs here too.
 *
 * =================================================================================================
 * WHY IT IS BUILT ON A KEYSET AND A CEILINGED COUNT
 * =================================================================================================
 *
 * `LIMIT 25 OFFSET 22475` reads 22,500 rows to show 25, and page 900 of a large directory is exactly
 * where somebody's surname beginning with S lives. keysetAfter() asks "after this exact row", which
 * the (department_id, full_name) index answers in one seek at any depth.
 *
 * `SELECT COUNT(*)` over the whole scope to print "of 4,318,006" reads four million rows to render a
 * number nobody acts on. countUpTo() answers "500+" and stops. The page says "500+" and means it —
 * which is more honest than an exact total that was true when the query started.
 *
 * The search is a CONTAINS match, and that is a deliberate cost. A prefix match would be free on a
 * btree, but people search for the second half of a double-barrelled surname and for a word in the
 * middle of a job title, and narrowing the behaviour underneath them to make a number look better is
 * the wrong trade. It requires the pg_trgm GIN indexes in db/hr-scale-indexes.sql; without those it
 * is a sequential scan, and `indexed` on the result says which of the two you are getting rather
 * than leaving somebody to wonder why the page is slow.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { resolveOrgViewerScope, type OrgViewerScope } from '@/lib/org-chart';
import {
  idEq, idIn, isUuid, countUpTo, probeMore, keysetAfter, encodeCursor,
  containsPattern, MIN_SEARCH_CHARS, type BoundedCount,
} from '@/lib/workforce/scale';

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) =>
  console.error('[workforce/directory] ' + tag, e?.cause?.message || e?.message || e);

/** One page of names. 25 fits a phone screen twice over and keeps the payload small on a slow link. */
export const PAGE_SIZE = 25;
/** A query longer than this is a paste, not a search. */
export const MAX_QUERY_CHARS = 60;

export interface DirectoryPerson {
  id: string;
  name: string;
  designation: string | null;
  employeeCode: string | null;
  departmentName: string | null;
  /** True for the signed-in person's own row, so the page can mark it rather than hiding it. */
  isSelf: boolean;
}

export interface DirectoryPage {
  /** False when the read did not happen. The page must then not say "nobody matches". */
  ok: boolean;
  people: DirectoryPerson[];
  /** Cursor for the next page, or null at the end. */
  next: string | null;
  /** How many are in scope, counted no further than the ceiling. */
  total: BoundedCount;
  /** The viewer's scope, verbatim, so the page can print its own explanation sentence. */
  scope: OrgViewerScope;
  /**
   * True when this search can use an index. False means the pg_trgm indexes in
   * db/hr-scale-indexes.sql have not been created and a substring search is reading the table.
   * Surfaced rather than hidden: a slow page with no explanation is a bug report nobody can action.
   */
  indexed: boolean;
  /** Set when the query was too short to run. The page says so instead of showing everybody. */
  tooShort: boolean;
}

/**
 * Whether pg_trgm is installed AND the name index exists.
 *
 * Cached for the life of the process, because it is a deployment fact rather than a request fact and
 * asking the catalog on every keystroke would itself be the cost this warns about. A false answer is
 * cached too: creating the index later is a deliberate act by an operator, and an instance recycles
 * within the hour anyway.
 */
let trigramReady: boolean | null = null;
async function hasTrigramIndex(): Promise<boolean> {
  if (trigramReady !== null) return trigramReady;
  try {
    const r = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'i' AND c.relname = 'hr_employees_name_trgm_idx') AS present`);
    trigramReady = rowsOf(r)[0]?.present === true;
  } catch (e: any) {
    // Not knowing is not the same as knowing it is absent, but the honest default for a WARNING is
    // to stay quiet rather than to accuse a correctly configured database of being slow.
    logFail('trigram probe', e);
    trigramReady = true;
  }
  return trigramReady;
}

/**
 * The scope, expressed as a WHERE fragment. This is the security boundary of the whole module, so it
 * is short on purpose and every branch either narrows or refuses.
 *
 * `false` is returned for a scope that admits nobody, and it is returned as a PREDICATE rather than
 * as an early exit so that no caller can forget to check a flag. A predicate that matches no rows
 * cannot be got wrong by the code above it.
 */
function scopeFilter(scope: OrgViewerScope): { where: any; admits: boolean } {
  if (scope.kind === 'full') return { where: sql`TRUE`, admits: true };

  if (scope.kind === 'self') {
    if (!isUuid(scope.employeeId)) return { where: sql`FALSE`, admits: false };
    return { where: idEq(sql`e.id`, scope.employeeId), admits: true };
  }

  if (scope.kind === 'departments') {
    const ids = (scope.departmentIds || []).map((d) => String(d || '').trim()).filter(Boolean);
    if (ids.length === 0) return { where: sql`FALSE`, admits: false };
    // Departments are the one id space in this product that may legitimately be a slug rather than
    // a uuid (db/hr-schema.sql says UUID, src/lib/db/schema.ts says varchar(50), and the live types
    // win). idIn() is index-usable for the uuid case; the text comparison is kept for the other,
    // because a department head whose key is a slug must still see their own department.
    const allUuid = ids.every(isUuid);
    const where = allUuid
      ? idIn(sql`e.department_id`, ids)
      : sql`e.department_id::text IN (${sql.join(ids.map((d) => sql`${d}`), sql`, `)})`;
    return { where, admits: true };
  }

  return { where: sql`FALSE`, admits: false };
}

export interface DirectoryQuery {
  userId: string;
  holds: (key: string) => boolean;
  /** The viewer's own hr_employees id, so their row can be marked. Display only. */
  selfEmployeeId?: string | null;
  q?: string;
  cursor?: string | null;
}

/**
 * One page of the directory, scoped, searched, ordered and paged.
 *
 * ORDERED BY (full_name, id) AND NOTHING ELSE, because that pair is the keyset. Sorting by name
 * alone looks identical and is subtly broken: at this headcount there are thousands of exact
 * duplicate names, and a page boundary that lands in the middle of nine people called Priya Sharma
 * either repeats one of them or skips one on every load. The id is the tie-break that makes the
 * cursor total.
 */
export async function directoryPage(query: DirectoryQuery): Promise<DirectoryPage> {
  const q = String(query.q || '').trim().slice(0, MAX_QUERY_CHARS);
  const self = String(query.selfEmployeeId || '');

  let scope: OrgViewerScope;
  try {
    scope = await resolveOrgViewerScope(String(query.userId || ''), query.holds);
  } catch (e: any) {
    // resolveOrgViewerScope already fails closed; this is the belt for anything it could not catch.
    logFail('resolveOrgViewerScope', e);
    scope = {
      initialized: false, kind: 'none', employeeId: null,
      departmentIds: [], departmentNames: [], degraded: true,
      gaps: ['the organization graph'],
      explanation: 'We could not work out whose records you may see, so nothing is shown.',
    };
  }

  const empty: DirectoryPage = {
    ok: true, people: [], next: null,
    total: { count: 0, atLeast: false, ok: true },
    scope, indexed: true, tooShort: false,
  };

  const { where: scoped, admits } = scopeFilter(scope);
  if (!admits) return empty;

  // A one-character search over a large table selects nothing and costs everything. The page says so
  // rather than silently listing the first twenty-five people alphabetically, which reads as an
  // answer to the question that was asked.
  if (q.length > 0 && q.length < MIN_SEARCH_CHARS) {
    return { ...empty, tooShort: true };
  }

  const indexed = q.length === 0 ? true : await hasTrigramIndex();

  // Name, job title and employee code — the three things somebody actually knows about the person
  // they are looking for. Written as a single OR so the planner can bitmap the three indexes.
  const pattern = containsPattern(q);
  const search = q.length === 0
    ? sql`TRUE`
    : sql`(COALESCE(e.full_name, '') ILIKE ${pattern}
        OR COALESCE(e.designation, '') ILIKE ${pattern}
        OR COALESCE(e.employee_code, '') ILIKE ${pattern})`;

  // Written ONCE and reused by both statements, so the count and the rows can never be counting
  // different things — the classic way a "and 12 more" comes to be a lie.
  const where = sql`e.is_active = TRUE AND ${scoped} AND ${search}`;

  try {
    // The count and the page are independent, so they go out together rather than one after the
    // other. postgres-js pipelines them over the single pooled connection.
    const [pageRows, total] = await Promise.all([
      db.execute(sql`
        SELECT e.id, e.full_name, e.designation, e.employee_code, d.name AS department_name
          FROM hr_employees e
          -- ::text ON BOTH SIDES, AND HERE IT IS THE RIGHT ANSWER. departments.id is UUID in
          -- db/hr-schema.sql and varchar(50) in src/lib/db/schema.ts, so a direct comparison throws
          -- on one of the two shapes. The cast is affordable on THIS join and nowhere else: the
          -- departments table has hundreds of rows, so the planner hashes it once, whereas the same
          -- cast on hr_employees.employee_id was reading billions.
          LEFT JOIN departments d ON d.id::text = e.department_id::text
         WHERE ${where}
           AND ${keysetAfter(sql`e.full_name`, sql`e.id`, query.cursor)}
         ORDER BY e.full_name ASC, e.id ASC
         LIMIT ${PAGE_SIZE + 1}`),
      countUpTo(sql`FROM hr_employees e WHERE ${where}`),
    ]);

    const { items, hasMore } = probeMore(rowsOf(pageRows), PAGE_SIZE);
    const people: DirectoryPerson[] = items.map((p: any) => ({
      id: String(p.id),
      name: String(p.full_name || 'Unnamed record'),
      designation: p.designation ? String(p.designation) : null,
      employeeCode: p.employee_code ? String(p.employee_code) : null,
      departmentName: p.department_name ? String(p.department_name) : null,
      isSelf: !!self && String(p.id) === self,
    }));

    const last = items[items.length - 1];
    return {
      ok: true,
      people,
      next: hasMore && last ? encodeCursor(last.full_name, last.id) : null,
      total,
      scope,
      indexed,
      tooShort: false,
    };
  } catch (e: any) {
    logFail('directoryPage', e);
    // ok:false, NOT an empty list. "Nobody matches that" and "we could not look" are different
    // sentences, and the second one must never be printed as the first.
    return { ...empty, ok: false };
  }
}
