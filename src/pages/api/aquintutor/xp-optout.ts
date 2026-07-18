// POST /api/aquintutor/xp-optout — a student opts in/out of the XP leaderboard (Prompt 15).
import type { APIRoute } from 'astro';
import { setOptOut } from '@/lib/xp-ledger';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  let b: any = {}; try { b = await request.json(); } catch {}
  try { await setOptOut(user.id, !!b.optOut); } catch {}
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
