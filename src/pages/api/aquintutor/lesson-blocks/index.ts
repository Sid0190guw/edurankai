import type { APIRoute } from 'astro';
import { createBlock } from '@/lib/aquintutor-authoring';
import { can } from '@/lib/auth/permissions';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// MECHANISM SWAP, IDENTICAL POPULATION. `!user || user.role === 'applicant'` asked who somebody is;
// `lessons.author` asks what they may do. That key is granted in PERMS_BY_ROLE to all ten
// non-applicant built-in roles and to applicant not at all, so the same accounts pass and fail.
// can(), never hasPermission() — the registry would additionally admit custom roles holding a
// section checkbox that spells the key. Nine routes in this cluster share this exact test.
export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!can(user, 'lessons.author')) return json({ ok: false, error: 'unauthorised' }, 403);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  if (!body.lessonId || !body.kind) return json({ ok: false, error: 'lessonId + kind required' }, 400);
  try {
    const block = await createBlock(body.lessonId, { kind: body.kind, content: body.content || {} });
    return json({ ok: true, block });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
