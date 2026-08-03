import type { APIRoute } from 'astro';
import { getCourseLabs, setCourseLabs } from '@/lib/aquintutor-authoring';
import { can } from '@/lib/auth/permissions';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// MECHANISM SWAP, IDENTICAL POPULATION — `lessons.author` is held by exactly the ten non-applicant
// built-in roles that passed the `role === 'applicant'` test this replaces. See lesson-blocks/index.ts.
// Attaching labs to a course is assembling teaching material, so it takes the authoring key rather
// than the publishing one.

// GET  -> { ok, labs: [slug] } currently attached to the course
export const GET: APIRoute = async ({ locals, params }) => {
  const user = (locals as any).user;
  if (!can(user, 'lessons.author')) return json({ ok: false, error: 'unauthorised' }, 403);
  const id = params.id as string;
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  try { return json({ ok: true, labs: await getCourseLabs(id) }); }
  catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};

// POST { labs: [slug] } -> replace the course's attached labs
export const POST: APIRoute = async ({ locals, params, request }) => {
  const user = (locals as any).user;
  if (!can(user, 'lessons.author')) return json({ ok: false, error: 'unauthorised' }, 403);
  const id = params.id as string;
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  if (!Array.isArray(body.labs)) return json({ ok: false, error: 'labs array required' }, 400);
  try {
    await setCourseLabs(id, body.labs);
    return json({ ok: true, labs: await getCourseLabs(id) });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
