// POST /api/admin/rbac — management actions for the Kernel Permission Engine (Prompt 2b).
// Gated by the engine itself: the caller must hold the 'manage' capability for rbac
// (superadmin via 'administer', or registrar). Every call is audited by can().
//   actions: seed | assignRole | removeRole | setStage | linkGuardian | unlinkGuardian
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { can, ensureRbacSchema, seedRbac } from '@/lib/rbac';
import { SEED_ROLES, STAGES } from '@/lib/rbac/roles';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const ROLE_KEYS = SEED_ROLES.map((r) => r.key);

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const decision = await can(user, 'manage', { type: 'rbac' });
  if (!decision.allow) return j({ ok: false, error: 'not permitted (need the manage capability for rbac)', reason: decision.reason }, 403);

  let b: any = {};
  try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const action = String(b.action || '');
  try {
    await ensureRbacSchema();

    if (action === 'seed') { const r = await seedRbac(); return j({ ok: true, seeded: r }); }

    if (action === 'assignRole') {
      const userId = String(b.userId || ''), roleKey = String(b.roleKey || '');
      if (!userId || !ROLE_KEYS.includes(roleKey)) return j({ ok: false, error: 'valid userId + roleKey required' }, 400);
      const stage = roleKey === 'student' && STAGES.includes(b.stage) ? b.stage : null;
      await db.execute(sql`INSERT INTO rbac_user_roles (user_id, role_key, stage, assigned_by)
        VALUES (${userId}, ${roleKey}, ${stage}, ${user.id})
        ON CONFLICT (user_id, role_key) DO UPDATE SET stage = COALESCE(EXCLUDED.stage, rbac_user_roles.stage)`);
      return j({ ok: true });
    }

    if (action === 'removeRole') {
      await db.execute(sql`DELETE FROM rbac_user_roles WHERE user_id = ${String(b.userId)} AND role_key = ${String(b.roleKey)}`);
      return j({ ok: true });
    }

    if (action === 'setStage') {
      const stage = STAGES.includes(b.stage) ? b.stage : null;
      if (!stage) return j({ ok: false, error: 'valid stage required' }, 400);
      // ensure a student role row exists, then set its stage
      await db.execute(sql`INSERT INTO rbac_user_roles (user_id, role_key, stage, assigned_by)
        VALUES (${String(b.userId)}, 'student', ${stage}, ${user.id})
        ON CONFLICT (user_id, role_key) DO UPDATE SET stage = ${stage}`);
      return j({ ok: true });
    }

    if (action === 'linkGuardian') {
      const guardianUserId = String(b.guardianUserId || ''), minorUserId = String(b.minorUserId || '');
      if (!guardianUserId || !minorUserId || guardianUserId === minorUserId) return j({ ok: false, error: 'distinct guardianUserId + minorUserId required' }, 400);
      await db.execute(sql`INSERT INTO rbac_guardian_links (guardian_user_id, minor_user_id) VALUES (${guardianUserId}, ${minorUserId}) ON CONFLICT (guardian_user_id, minor_user_id) DO NOTHING`);
      // make sure the guardian actually holds the guardian role
      await db.execute(sql`INSERT INTO rbac_user_roles (user_id, role_key, assigned_by) VALUES (${guardianUserId}, 'guardian', ${user.id}) ON CONFLICT (user_id, role_key) DO NOTHING`);
      return j({ ok: true });
    }

    if (action === 'unlinkGuardian') {
      await db.execute(sql`DELETE FROM rbac_guardian_links WHERE guardian_user_id = ${String(b.guardianUserId)} AND minor_user_id = ${String(b.minorUserId)}`);
      return j({ ok: true });
    }

    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200);
  }
};
