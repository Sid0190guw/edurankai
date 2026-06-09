// GET /api/v1/courses — partner/university API: list published courses.
// Auth: x-api-key. Read-only, CORS-enabled.
import type { APIRoute } from 'astro';
import { validateApiKey, CORS } from '@/lib/api-keys';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { SITE } from '@/lib/site';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } }); }
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS });

export const GET: APIRoute = async ({ request }) => {
  const partner = await validateApiKey(request);
  if (!partner) return json({ ok: false, error: 'Invalid or missing API key.' }, 401);

  const base = SITE.url.replace(/\/$/, '');
  let courses: any[] = [];
  try {
    courses = rows(await db.execute(sql`
      SELECT slug, title, subtitle, short_desc, category, school, difficulty,
        COALESCE(enrolled_count, 0) AS enrolled,
        (SELECT COUNT(*)::int FROM training_lessons WHERE course_id = training_courses.id) AS lessons
      FROM training_courses WHERE is_published = true
      ORDER BY enrolled DESC, created_at DESC LIMIT 500`));
  } catch (_) { courses = []; }

  const out = courses.map((c) => ({
    slug: c.slug, title: c.title, subtitle: c.subtitle || null, summary: c.short_desc || null,
    category: c.category || null, school: c.school || null, difficulty: c.difficulty || null,
    lessons: c.lessons || 0, enrolled: c.enrolled || 0,
    url: base + '/aquintutor/courses/' + c.slug,
  }));
  return json({ ok: true, count: out.length, courses: out });
};
