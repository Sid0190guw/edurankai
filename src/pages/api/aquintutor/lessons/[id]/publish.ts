import type { APIRoute } from 'astro';
import { publishLesson } from '@/lib/aquintutor-authoring';
import { can } from '@/lib/auth/permissions';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// MECHANISM SWAP, IDENTICAL POPULATION. This used to read `!user || user.role === 'applicant'` —
// the test docs/workforce-os/AUTHORIZATION_FIRST.md and canAccessSection() both name as a defect,
// because it asks WHO somebody is instead of what they may do, and every internal role passes it
// including the `editor` the 2026 offer-signing promotion handed to interns.
//
// `lessons.publish` is granted in PERMS_BY_ROLE to all ten non-applicant built-in roles and to
// applicant NOT AT ALL, so exactly the same accounts pass and fail as before. Nothing is gained or
// lost by any role; the width is inherited history and narrowing it is a separate, deliberate
// decision for a human.
//
// can(), NOT hasPermission(). can() reads the compiled matrix alone. The registry would also admit
// any custom role holding a section checkbox that spells the same key — a widening that would arrive
// without anyone granting a permission. See the rule in src/lib/auth/registry.ts.
//
// Publishing is deliberately its own key: writing a lesson (`lessons.author`, the other nine routes
// in this cluster) and deciding it is ready to teach are two powers, held by the same people today.
export const POST: APIRoute = async ({ locals, params }) => {
  const user = (locals as any).user;
  if (!can(user, 'lessons.publish')) return json({ ok: false, error: 'unauthorised' }, 403);
  const id = params.id as string;
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  try { await publishLesson({ lessonId: id, byUserId: user.id, byName: user.name || user.email }); return json({ ok: true }); }
  catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
