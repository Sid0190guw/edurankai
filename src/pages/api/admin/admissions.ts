// POST /api/admin/admissions — a registrar records an admission decision (Prompt 16). Gated by
// can(manage, admission). On 'accepted' the applicant becomes enrolment-eligible (Prompt 17). Audited.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { recordDecision, getApplication, canDecide, DECISIONS, type AppStatus } from '@/lib/admissions';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'manage', { type: 'admission' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (registrar/superadmin only)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const appId = String(b.appId || '');
  const decision = b.decision as AppStatus;
  if (!appId || !DECISIONS.includes(decision)) return j({ ok: false, error: 'appId + valid decision required' }, 400);
  const app = await getApplication(appId);
  if (!app) return j({ ok: false, error: 'application not found' }, 404);
  if (!canDecide(app.status)) return j({ ok: false, error: 'already decided' }, 200);
  try { await recordDecision(appId, decision, String(b.reason || ''), user.id); return j({ ok: true }); }
  catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
