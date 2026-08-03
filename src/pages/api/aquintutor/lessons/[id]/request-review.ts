import type { APIRoute } from 'astro';
import { requestReview } from '@/lib/aquintutor-authoring';
import { can } from '@/lib/auth/permissions';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

// MECHANISM SWAP, IDENTICAL POPULATION — `lessons.author` is held by exactly the ten non-applicant
// built-in roles that passed the `role === 'applicant'` test this replaces. See lesson-blocks/index.ts.
// Submitting for review is an authoring act, not a publishing one: it makes nothing live.
export const POST: APIRoute = async ({ locals, params }) => {
  const user = (locals as any).user;
  if (!can(user, 'lessons.author')) return json({ ok: false, error: 'unauthorised' }, 403);
  const id = params.id as string;
  if (!id) return json({ ok: false, error: 'id required' }, 400);
  try { await requestReview(id); return json({ ok: true }); }
  catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
