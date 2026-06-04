// POST /api/aquintutor/friends/remove  { friendId }
import type { APIRoute } from 'astro';
import { removeFriend } from '@/lib/friends';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const friendId = (body.friendId || '').toString();
  if (!friendId) return json({ ok: false, error: 'friendId required' }, 400);
  await removeFriend(user.id, friendId);
  return json({ ok: true });
};
