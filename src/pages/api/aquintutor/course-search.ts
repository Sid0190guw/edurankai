// GET /api/aquintutor/course-search?q=...
// Instant autocomplete for the catalogue search — matches course codes
// (e.g. CS-101), school tags (e.g. SCR) and titles. Auth-gated (AquinTutor area).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, items: [] }, 401);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return json({ ok: true, items: [] });
  const like = '%' + q + '%';
  try {
    const r = await db.execute(sql`
      SELECT c.title, c.slug, c.course_code, s.code AS school_code
      FROM training_courses c
      LEFT JOIN schools s ON c.school_id = s.id
      WHERE c.is_published = true AND c.access_type IN ('public', 'both')
        AND (
          c.title ILIKE ${like}
          OR COALESCE(c.course_code, '') ILIKE ${like}
          OR COALESCE(s.code, '') ILIKE ${like}
          OR COALESCE(c.subtitle, '') ILIKE ${like}
        )
      ORDER BY
        CASE WHEN COALESCE(c.course_code, '') ILIKE ${q + '%'} THEN 0
             WHEN c.title ILIKE ${q + '%'} THEN 1 ELSE 2 END,
        c.enrolled_count DESC NULLS LAST
      LIMIT 8
    `);
    return json({ ok: true, items: rows(r) });
  } catch (_) {
    return json({ ok: true, items: [] });
  }
};
