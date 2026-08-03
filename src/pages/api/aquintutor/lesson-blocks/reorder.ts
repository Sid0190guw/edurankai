import type { APIRoute } from 'astro';
import { reorderBlocks } from '@/lib/aquintutor-authoring';
import { can } from '@/lib/auth/permissions';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// MECHANISM SWAP, IDENTICAL POPULATION — `lessons.author` is held by exactly the ten non-applicant
// built-in roles that passed the `role === 'applicant'` test this replaces. See lesson-blocks/index.ts.
export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!can(user, 'lessons.author')) return json({ ok: false, error: 'unauthorised' }, 403);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  if (!body.lessonId || !Array.isArray(body.ids)) return json({ ok: false, error: 'lessonId + ids[] required' }, 400);
  try { await reorderBlocks(body.lessonId, body.ids); return json({ ok: true }); }
  catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
