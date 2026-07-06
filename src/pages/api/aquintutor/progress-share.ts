// Manage read-only progress-share links for the signed-in learner.
//   GET  /api/aquintutor/progress-share            -> { shares }
//   POST /api/aquintutor/progress-share { action }  -> create | revoke
import type { APIRoute } from 'astro';
import { createShare, listShares, revokeShare } from '@/lib/aquintutor-share';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  try { return json({ ok: true, shares: await listShares(user.id) }); }
  catch (e: any) { return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500); }
};

export const POST: APIRoute = async ({ request, locals, url }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'create') {
      const token = await createShare(user.id, (b.label || '').toString());
      return json({ ok: true, token, path: '/aquintutor/shared-progress/' + token });
    }
    if (b.action === 'revoke') {
      if (!b.token) return json({ ok: false, error: 'token required' }, 400);
      await revokeShare(user.id, String(b.token));
      return json({ ok: true });
    }
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500); }
};
