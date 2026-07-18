// /api/admin/backup — kernel export (GET) + restore (POST) (Prompt 23). STRICTLY superadmin
// (can(administer)). Restore validates + integrity-checks; a dry-run reports before applying and
// blocks on failure; apply is additive/non-destructive. Audited.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { exportKernel, existingObjectIds, planRestore, applyRestore, integrityReport } from '@/lib/backup';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any)?.user;
  if (!user || !(await can(user, 'administer', { type: 'platform' })).allow) return new Response('superadmin only', { status: 403 });
  if (url.searchParams.get('integrity') === '1') return j({ ok: true, report: await integrityReport() });
  const course = url.searchParams.get('course') || undefined;
  const pkg = await exportKernel(course);
  return new Response(JSON.stringify(pkg, null, 2), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="aquintutor-kernel-${course ? 'course' : 'full'}.json"` } });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  if (!(await can(user, 'administer', { type: 'platform' })).allow) return j({ ok: false, error: 'superadmin only' }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const pkg = b.package;
  try {
    const plan = planRestore(pkg, await existingObjectIds());
    if (b.action === 'dryRun') return j({ ok: true, plan });
    if (b.action === 'apply') {
      if (plan.blocked) return j({ ok: false, error: plan.reason || 'blocked by integrity check' });
      const r = await applyRestore(pkg);
      return j({ ok: true, applied: r });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
