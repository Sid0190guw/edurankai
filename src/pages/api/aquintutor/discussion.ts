// POST /api/aquintutor/discussion — create a thread, post/reply, or report (Prompt 20). A minor may
// participate only with guardian community consent (Prompt 14). Replies notify (Prompt 18). Audited.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { isMinorStage } from '@/lib/rbac/roles';
import { getProfile } from '@/lib/student-settings';
import { createThread, createPost, reportPost, canParticipate } from '@/lib/edu-community';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

async function participationOk(userId: string): Promise<boolean> {
  let minor = false;
  try { const stage = rows(await db.execute(sql`SELECT stage FROM rbac_user_roles WHERE user_id = ${userId} AND role_key = 'student' LIMIT 1`))[0]?.stage; minor = isMinorStage(stage); } catch {}
  if (!minor) return true;
  const p = await getProfile(userId).catch(() => null);
  return canParticipate(true, !!p?.consent?.community);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  // report is allowed for everyone; posting/creating requires participation rights
  if (b.action !== 'report' && !(await participationOk(user.id))) return j({ ok: false, error: 'a guardian must enable community participation for your account' }, 403);
  try {
    if (b.action === 'newThread') { if (!b.title) return j({ ok: false, error: 'title required' }, 400); const id = await createThread(b.scope === 'course' || b.scope === 'ko' ? b.scope : 'general', b.scopeId || null, String(b.title), user.id); if (b.body) await createPost(id, user.id, String(b.body), null); return j({ ok: true, id }); }
    if (b.action === 'post') { if (!b.threadId || !b.body) return j({ ok: false, error: 'threadId + body required' }, 400); const id = await createPost(String(b.threadId), user.id, String(b.body), b.parentId || null); return j({ ok: true, id }); }
    if (b.action === 'report') { if (!b.postId) return j({ ok: false, error: 'postId required' }, 400); await reportPost(String(b.postId), user.id, String(b.reason || '')); return j({ ok: true }); }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
