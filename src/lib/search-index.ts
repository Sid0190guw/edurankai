// src/lib/search-index.ts — Search & Discovery over PUBLISHED kernel objects (Prompt 12). A
// lightweight server-side index (a plain Postgres table — no heavy dependency) holds courses,
// KnowledgeObjects and concepts; results respect securityLabels + the viewer's access and NEVER
// surface exam-secure content. Ranking is a pure token-overlap function (title-boosted), unit-tested.

export interface IndexDoc {
  id: string; type: string; title: string; body?: string;
  school?: string | null; level?: string | null; language?: string | null;
  labels?: string[];
}
export interface RankedDoc extends IndexDoc { score: number }

export function tokenize(s: string): string[] {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
}

/** Pure relevance ranking: title matches weigh 3x body matches; non-matching docs are excluded. */
export function rankResults(query: string, docs: IndexDoc[]): RankedDoc[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return docs.map((d) => ({ ...d, score: 0 }));   // browse mode: no query, keep order
  const out: RankedDoc[] = [];
  for (const d of docs) {
    const title = new Set(tokenize(d.title));
    const body = new Set(tokenize(d.body || ''));
    let score = 0;
    for (const t of q) { if (title.has(t)) score += 3; else if (body.has(t)) score += 1; }
    if (score > 0) out.push({ ...d, score });
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

/** Discovery visibility: exam-secure is NEVER discoverable; enrolled-only needs enrolment access. Pure. */
export function isDiscoverable(labels: string[] | undefined, viewer: { canEnrolled: boolean }): boolean {
  const l = labels || ['public'];
  if (l.includes('exam-secure')) return false;                    // never surfaces in search
  if (l.includes('enrolled-only')) return viewer.canEnrolled;
  return true;                                                    // public
}

// ============================ DB layer (self-bootstrapping, additive) ============================
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureSearchSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  const { ddlPermitted } = await import('@/lib/schema-bootstrap');
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_search_index (object_id UUID PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', school TEXT, level TEXT, language TEXT, security_labels TEXT[] NOT NULL DEFAULT '{public}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  // search() orders every candidate read by updated_at DESC and indexStatus() reads MAX(updated_at).
  // Also in db/search-index-schema.sql, so a bootstrapped dev database and a hand-created production
  // one end up the same shape.
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_search_index_updated_idx ON edu_search_index (updated_at DESC)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_search_queries (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), query TEXT NOT NULL, user_id UUID, result_count INT NOT NULL DEFAULT 0, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_search_q_idx ON edu_search_queries (at DESC)`));
  // NOT `= true`. A suppressed DDL run must not latch as a completed one.
  //
  // db.execute refuses DDL when schema bootstrap is off (src/lib/schema-bootstrap.ts) and returns
  // the same empty result a real statement would, deliberately, so nothing downstream has to
  // change. The cost of that indistinguishability is exactly here: setting the flag
  // unconditionally recorded "already bootstrapped" for four statements that created nothing. Any
  // earlier request on a warm instance -- a student opening /aquintutor/search, /admin/search
  // rendering its status card -- would latch it, and the operator's allowingDdl() pass from
  // /admin/setup or /api/admin/ops/bootstrap would then return at the guard above and report
  // success having done nothing.
  booted = ddlPermitted();
}

interface IndexRow {
  id: string; type: string; title: string; body: string;
  labels: string[]; school: string | null; level: string | null; language: string | null;
  courseId: string | null;
}

/**
 * Rebuild the index from PUBLISHED kernel objects. Real reindex; returns the row count.
 *
 * THREE THINGS THIS FUNCTION USED TO GET WRONG, ALL OF THEM INVISIBLE FROM ITS RETURN VALUE.
 *
 * 1. IT COULD NEVER WRITE A ROW. `security_labels` is text[], and the insert bound the JS array
 *    straight into the template: `${labels}`. Rendered through this repo's own PgDialect that
 *    becomes a ROW constructor -- `($8, $9)` for two labels, `($8)` for one, `()` for none -- so
 *    Postgres answers 42804 "is of type text[] but expression is of type record", or 22P02
 *    "malformed array literal" for the single-label case that every kernel object defaults to.
 *    src/lib/pg-array.ts exists precisely because this pattern silently broke four other features
 *    for months; textArray() is the fix, and it must NOT carry a ::text[] cast.
 *
 * 2. IT EMPTIED THE INDEX BEFORE IT HAD READ A REPLACEMENT. The DELETE ran first, outside any
 *    transaction, and the kernel read that followed was wrapped in `.catch(() => [])`. A kernel
 *    that could not be read therefore wiped a working index and returned 0 -- which
 *    /api/admin/search-reindex reports as { ok: true, indexed: 0 } and /admin/search paints green.
 *    Everything is read first now, and the swap happens inside one transaction.
 *
 * 3. A FAILED SOURCE READ LOOKED IDENTICAL TO AN EMPTY CATALOGUE. The swallow is gone: if the
 *    kernel cannot be read, this throws and the caller reports why.
 *
 * The per-course enrichment was also one round trip per course inside the write loop. It is one
 * query for all of them now, before the transaction opens.
 */
export async function reindex(): Promise<number> {
  await ensureSearchSchema();
  const { db, sql } = await ctx();
  const { textArray } = await import('@/lib/pg-array');
  const { createPgKernel } = await import('@/lib/kernel');
  const repo = createPgKernel();

  // ---- READ. Nothing below this point mutates anything until every row is in hand. ----
  const docs: IndexRow[] = [];
  for (const type of ['CourseObject', 'KnowledgeObject', 'ConceptObject'] as const) {
    // NO .catch() HERE, DELIBERATELY. kernel_objects is itself a table whose only creator is a
    // suppressed bootstrap (src/lib/kernel/store.ts), so "cannot read the kernel" is a real and
    // likely outcome -- and the one thing it must never look like is a catalogue with nothing in it.
    const objs = await repo.listByType(type);
    for (const o of objs as any[]) {
      if (o.lifecycleState !== 'published' && o.lifecycleState !== 'referenced') continue;
      const d: any = o.data || {};
      const title = d.title || d.name || '';
      if (!title) continue;                                   // an untitled object is not findable
      docs.push({
        id: o.id,
        type,
        title,
        body: type === 'KnowledgeObject' ? (d.body || '') : (d.summary || d.description || ''),
        labels: o.securityLabels || ['public'],
        school: null,
        level: null,
        language: (o.learningMetadata?.languages || [])[0] || null,
        courseId: type === 'CourseObject' && d.trainingCourseId ? String(d.trainingCourseId) : null,
      });
    }
  }

  // ---- ENRICH. One query for every course, not one per course. Optional: a course catalogue this
  // cannot read costs the school/level facets, not the index. ----
  const courseIds = [...new Set(docs.map((r) => r.courseId).filter((x): x is string => !!x))];
  if (courseIds.length) {
    try {
      // Individual placeholders rather than = ANY(${array}): the driver sends a JS array as a plain
      // parameter, and an IN list needs no assumption about whether the id column is uuid or text.
      const idList = sql.join(courseIds.map((i) => sql`${i}`), sql`, `);
      const found = rows(await db.execute(sql`SELECT c.id, c.level, s.name AS school
        FROM training_courses c LEFT JOIN schools s ON c.school_id = s.id
        WHERE c.id IN (${idList})`));
      const byId = new Map(found.map((c: any) => [String(c.id), c]));
      for (const r of docs) {
        const c = r.courseId ? byId.get(r.courseId) : null;
        if (c) { r.level = c.level || null; r.school = c.school || null; }
      }
    } catch (e: any) {
      // Not fatal, but not silent either. The real Postgres reason is on e.cause.
      console.warn('[search-index] course enrichment skipped:', e?.cause?.message || e?.message || 'unknown');
    }
  }

  // ---- SWAP. One transaction, so a failure leaves the previous index in place. ----
  const CHUNK = 200;
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`DELETE FROM edu_search_index`);
    for (let i = 0; i < docs.length; i += CHUNK) {
      const chunk = docs.slice(i, i + CHUNK);
      const values = chunk.map((r) => sql`(${r.id}, ${r.type}, ${r.title}, ${r.body}, ${r.school}, ${r.level}, ${r.language}, ${textArray(r.labels)})`);
      await tx.execute(sql`INSERT INTO edu_search_index
        (object_id, type, title, body, school, level, language, security_labels)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (object_id) DO UPDATE SET
          type = EXCLUDED.type, title = EXCLUDED.title, body = EXCLUDED.body,
          school = EXCLUDED.school, level = EXCLUDED.level, language = EXCLUDED.language,
          security_labels = EXCLUDED.security_labels, updated_at = NOW()`);
    }
  });
  return docs.length;
}

export interface SearchFilters { school?: string; level?: string; language?: string }
/** Search the index: only permitted, published, non-exam-secure docs, ranked by relevance. */
export async function search(query: string, filters: SearchFilters, viewer: { canEnrolled: boolean }, limit = 40): Promise<RankedDoc[]> {
  await ensureSearchSchema(); const { db, sql } = await ctx();
  const conds: any[] = [sql`NOT ('exam-secure' = ANY(security_labels))`];
  if (query.trim()) conds.push(sql`(title ILIKE ${'%' + query.trim() + '%'} OR body ILIKE ${'%' + query.trim() + '%'})`);
  if (filters.school) conds.push(sql`school = ${filters.school}`);
  if (filters.level) conds.push(sql`level = ${filters.level}`);
  if (filters.language) conds.push(sql`language = ${filters.language}`);
  const where = sql`WHERE ${sql.join(conds, sql` AND `)}`;
  const candidates = rows(await db.execute(sql`SELECT object_id AS id, type, title, body, school, level, language, security_labels AS labels FROM edu_search_index ${where} ORDER BY updated_at DESC LIMIT 300`));
  const permitted = candidates.filter((c: any) => isDiscoverable(c.labels, viewer));
  const ranked = query.trim() ? rankResults(query, permitted) : permitted.map((d: any) => ({ ...d, score: 0 }));
  return ranked.slice(0, limit);
}
export async function logQuery(query: string, userId: string | null, count: number): Promise<void> {
  if (!query.trim()) return;
  try { await ensureSearchSchema(); const { db, sql } = await ctx(); await db.execute(sql`INSERT INTO edu_search_queries (query, user_id, result_count) VALUES (${query.trim().slice(0, 200)}, ${userId}, ${count})`); } catch { /* best-effort */ }
}
export async function indexStatus(): Promise<{ count: number; lastUpdated: any }> {
  await ensureSearchSchema(); const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`SELECT COUNT(*)::int AS c, MAX(updated_at) AS m FROM edu_search_index`))[0];
  return { count: r?.c || 0, lastUpdated: r?.m || null };
}
export async function topQueries(limit = 20): Promise<any[]> {
  await ensureSearchSchema(); const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT query, COUNT(*)::int AS n, MAX(at) AS last_at, ROUND(AVG(result_count))::int AS avg_results FROM edu_search_queries GROUP BY query ORDER BY COUNT(*) DESC LIMIT ${limit}`));
}
export async function facetValues(): Promise<{ schools: string[]; levels: string[]; languages: string[] }> {
  await ensureSearchSchema(); const { db, sql } = await ctx();
  const distinct = async (col: 'school' | 'level' | 'language') =>
    rows(await db.execute(sql.raw(`SELECT DISTINCT ${col} AS v FROM edu_search_index WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY 1`))).map((r: any) => r.v);
  return { schools: await distinct('school'), levels: await distinct('level'), languages: await distinct('language') };
}
