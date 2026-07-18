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
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_search_index (object_id UUID PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', school TEXT, level TEXT, language TEXT, security_labels TEXT[] NOT NULL DEFAULT '{public}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_search_queries (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), query TEXT NOT NULL, user_id UUID, result_count INT NOT NULL DEFAULT 0, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS edu_search_q_idx ON edu_search_queries (at DESC)`));
  booted = true;
}

/** Rebuild the index from PUBLISHED kernel objects. Real reindex; returns the row count. */
export async function reindex(): Promise<number> {
  await ensureSearchSchema(); const { db, sql } = await ctx();
  const { createPgKernel } = await import('@/lib/kernel');
  const repo = createPgKernel();
  await db.execute(sql`DELETE FROM edu_search_index`);
  let n = 0;
  const put = async (id: string, type: string, title: string, body: string, labels: string[], school: string | null, level: string | null, language: string | null) => {
    if (!title) return;
    await db.execute(sql`INSERT INTO edu_search_index (object_id, type, title, body, school, level, language, security_labels)
      VALUES (${id}, ${type}, ${title}, ${body || ''}, ${school}, ${level}, ${language}, ${labels})
      ON CONFLICT (object_id) DO UPDATE SET type=${type}, title=${title}, body=${body || ''}, school=${school}, level=${level}, language=${language}, security_labels=${labels}, updated_at=NOW()`);
    n++;
  };
  for (const type of ['CourseObject', 'KnowledgeObject', 'ConceptObject'] as const) {
    const objs = await repo.listByType(type).catch(() => []);
    for (const o of objs as any[]) {
      if (o.lifecycleState !== 'published' && o.lifecycleState !== 'referenced') continue;
      const d: any = o.data || {};
      const labels: string[] = o.securityLabels || ['public'];
      let school: string | null = null, level: string | null = null, language: string | null = null;
      const body = type === 'KnowledgeObject' ? (d.body || '') : (d.summary || d.description || '');
      language = (o.learningMetadata?.languages || [])[0] || null;
      if (type === 'CourseObject' && d.trainingCourseId) {
        try { const c = rows(await db.execute(sql`SELECT c.level, s.name AS school FROM training_courses c LEFT JOIN schools s ON c.school_id = s.id WHERE c.id = ${d.trainingCourseId} LIMIT 1`))[0]; if (c) { level = c.level || null; school = c.school || null; } } catch { /* optional */ }
      }
      await put(o.id, type, d.title || d.name || '', body, labels, school, level, language);
    }
  }
  return n;
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
