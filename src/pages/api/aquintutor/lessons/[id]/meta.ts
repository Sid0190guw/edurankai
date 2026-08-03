import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { can } from '@/lib/auth/permissions';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// MECHANISM SWAP, IDENTICAL POPULATION — `lessons.author` is held by exactly the ten non-applicant
// built-in roles that passed the `role === 'applicant'` test this replaces. See lesson-blocks/index.ts.
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const user = (locals as any).user;
  if (!can(user, 'lessons.author')) return json({ ok: false, error: 'unauthorised' }, 403);
  const id = params.id as string;
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  try {
    if (body.title != null) await db.execute(sql`UPDATE training_lessons SET title = ${body.title}, updated_at = NOW() WHERE id = ${id}`);
    if (body.estimated_minutes != null) await db.execute(sql`UPDATE training_lessons SET estimated_minutes = ${parseInt(body.estimated_minutes, 10) || 0}, updated_at = NOW() WHERE id = ${id}`);
    if (body.preview_allowed != null) await db.execute(sql`UPDATE training_lessons SET preview_allowed = ${!!body.preview_allowed}, updated_at = NOW() WHERE id = ${id}`);
    return json({ ok: true });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
