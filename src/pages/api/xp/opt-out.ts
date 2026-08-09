// POST /api/xp/opt-out — a learner asks to be left off the XP leaderboards, or back onto them.
//
// WHY THIS ROUTE IS NOT UNDER /api/aquintutor ANY MORE. There is one XP ledger now (src/lib/xp.ts)
// and it is read by two different leaderboards on two different products: /aquintutor/xp and
// /portal/achievements. The opt-out has to cover both, so it cannot live under one of them. The old
// /api/aquintutor/xp-optout is gone rather than kept as an alias — two doors onto one privacy
// setting is how one of them ends up not being maintained.
//
// It also no longer answers { ok: true } when the write failed. Telling somebody their name has
// been taken off a public board when it has not is the one answer this endpoint must never give.
import type { APIRoute } from 'astro';
import { setLeaderboardOptOut } from '@/lib/xp';

function j(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);

  let b: any = {};
  try {
    b = await request.json();
  } catch {
    return j({ ok: false, error: 'bad json' }, 400);
  }

  const optOut = !!b.optOut;
  try {
    const saved = await setLeaderboardOptOut(user.id, optOut);
    if (!saved) return j({ ok: false, optOut, error: 'your leaderboard setting could not be saved' }, 200);
    return j({ ok: true, optOut });
  } catch (e: any) {
    return j({ ok: false, optOut, error: e?.cause?.message || e?.message || 'error' }, 200);
  }
};
