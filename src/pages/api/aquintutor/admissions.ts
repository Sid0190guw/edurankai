// POST /api/aquintutor/admissions — an applicant submits an application or completes the screening
// interview (Prompt 16). Access-scoped: an applicant acts only on their own application. Audited.
import type { APIRoute } from 'astro';
import { writeAudit } from '@/lib/rbac';
import { submitApplication, saveInterview, myApplication } from '@/lib/admissions';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'submit') {
      if (!b.program) return j({ ok: false, error: 'program required' }, 400);
      const existing = await myApplication(user.id);
      if (existing && existing.status !== 'rejected') return j({ ok: false, error: 'you already have an application in progress' }, 200);
      const id = await submitApplication(user.id, String(b.program), b.profile || {});
      await writeAudit({ userId: user.id, capability: 'create', resource: 'application:' + id, allow: true, reason: 'application submitted', stage: 'return-decision', matchedGrant: null, context: {}, at: new Date().toISOString() });
      return j({ ok: true, id });
    }
    if (b.action === 'interview') {
      const app = await myApplication(user.id);
      if (!app) return j({ ok: false, error: 'no application found' }, 404);
      const answers = Array.isArray(b.answers) ? b.answers.map((a: any) => String(a || '')) : [];
      const r = await saveInterview(app.id, user.id, answers);
      await writeAudit({ userId: user.id, capability: 'execute', resource: 'application:' + app.id, allow: true, reason: 'screening interview completed', stage: 'return-decision', matchedGrant: null, context: { score: r.score }, at: new Date().toISOString() });
      return j({ ok: true, score: r.score });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
