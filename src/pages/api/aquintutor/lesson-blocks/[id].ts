import type { APIRoute } from 'astro';
import { updateBlock, deleteBlock } from '@/lib/aquintutor-authoring';
import { can } from '@/lib/auth/permissions';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// MECHANISM SWAP, IDENTICAL POPULATION — `lessons.author` is held by exactly the ten non-applicant
// built-in roles that passed the `role === 'applicant'` test this replaces. See lesson-blocks/index.ts.
//
// BOTH VERBS KEEP THE SAME TEST, deliberately. Editing and DELETING a lesson block are gated
// identically today, and they stay identical here. A section-based conversion would NOT have been
// equivalent: canAccessSection() keeps 'delete' super_admin-only for built-in roles, so routing
// DELETE through it would have removed every other role from a verb they hold right now.
export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const user = (locals as any).user;
  if (!can(user, 'lessons.author')) return json({ ok: false, error: 'unauthorised' }, 403);
  const id = params.id as string;
  if (!id) return json({ ok: false, error: 'block id required' }, 400);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  try {
    await updateBlock(id, { kind: body.kind, content: body.content, position: body.position });
    return json({ ok: true });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const user = (locals as any).user;
  if (!can(user, 'lessons.author')) return json({ ok: false, error: 'unauthorised' }, 403);
  const id = params.id as string;
  if (!id) return json({ ok: false, error: 'block id required' }, 400);
  try { await deleteBlock(id); return json({ ok: true }); }
  catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
