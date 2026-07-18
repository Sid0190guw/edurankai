// POST /api/admin/moderation — moderator actions (Prompt 20). Gated by can(delete, discussion) =
// moderator. Remove a post (hides it for students) or dismiss a report. Audited.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { removePost, resolveReport } from '@/lib/edu-community';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'delete', { type: 'discussion' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (moderator only)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'remove') { if (!b.postId) return j({ ok: false, error: 'postId required' }, 400); await removePost(String(b.postId)); return j({ ok: true }); }
    if (b.action === 'dismiss') { if (!b.reportId) return j({ ok: false, error: 'reportId required' }, 400); await resolveReport(String(b.reportId)); return j({ ok: true }); }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
