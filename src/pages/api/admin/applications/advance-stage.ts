import type { APIRoute } from 'astro';
import { advanceStage, STAGES } from '@/lib/application-stages';
import { denyAdminApi } from '@/lib/auth/api-guard';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  // Moving a candidate's pipeline stage is the `applications` section, edit. `role !== 'applicant'`
  // admitted marketing and editor too — neither of whom can open /admin/applications, because the
  // middleware section gate stops them. The URL now answers the same as the page.
  const denied = await denyAdminApi(locals, { section: 'applications', action: 'edit', label: 'applications.advance-stage' });
  if (denied) return denied;
  const user = (locals as any).user;
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const id = (body.applicationId || '').toString();
  const toStage = (body.toStage || '').toString();
  const note = (body.note || '').toString().slice(0, 2000);
  if (!id || !STAGES.find(s => s.key === toStage)) return json({ ok: false, error: 'bad input' }, 400);
  try {
    await advanceStage({ applicationId: id, toStage, actorUserId: user.id, actorName: user.name || user.email, note });
    return json({ ok: true });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
