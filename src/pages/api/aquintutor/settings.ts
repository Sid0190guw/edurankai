// POST /api/aquintutor/settings — save student settings (Prompt 14). A student edits their own
// (minors are consent-gated); a linked GUARDIAN may edit a minor's settings. Audited. Changes take
// effect in the next runtime session (getProfile feeds the same edu_student_settings the runtime reads).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { writeAudit } from '@/lib/rbac';
import { isMinorStage } from '@/lib/rbac/roles';
import { getProfile, saveProfile, mergeProfile, isGuardianOf } from '@/lib/student-settings';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const target = String(b.targetUserId || user.id);
  const isSelf = target === user.id;
  const isGuardian = !isSelf && await isGuardianOf(user.id, target).catch(() => false);
  if (!isSelf && !isGuardian) return j({ ok: false, error: 'not permitted to edit these settings' }, 403);

  let isMinor = false;
  try { const s = rows(await db.execute(sql`SELECT stage FROM rbac_user_roles WHERE user_id = ${target} AND role_key = 'student' LIMIT 1`))[0]?.stage; isMinor = isMinorStage(s); } catch { /* default false */ }

  try {
    const current = await getProfile(target);
    const next = mergeProfile(current, b.patch || {}, { isSelf, isMinor, isGuardianOfTarget: isGuardian });
    await saveProfile(target, next);
    await writeAudit({ userId: user.id, capability: 'configure', resource: 'settings:' + target, allow: true, reason: isGuardian ? 'guardian updated minor settings' : 'settings updated', stage: 'apply-constraints', matchedGrant: null, context: { target }, at: new Date().toISOString() });
    return j({ ok: true, profile: next });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
