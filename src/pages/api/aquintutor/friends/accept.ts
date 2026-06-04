// POST /api/aquintutor/friends/accept  { code }
import type { APIRoute } from 'astro';
import { acceptInvite } from '@/lib/friends';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const r = await acceptInvite(user.id, (body.code || '').toString());
  return json(r, r.ok ? 200 : 400);
};
