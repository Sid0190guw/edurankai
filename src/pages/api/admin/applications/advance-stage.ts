import type { APIRoute } from 'astro';
import { advanceStage, isKnownStage } from '@/lib/application-stages';
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
  // isKnownStage(), not STAGES alone. The six OPEN steps were the only stages this route would
  // accept, so the two endings of the funnel — 'decision_no' and 'withdrawn' — could not be set
  // through the one URL that exists for setting a stage. A funnel whose ending is unreachable is a
  // funnel every candidate stays inside.
  if (!id || !isKnownStage(toStage)) return json({ ok: false, error: 'bad input' }, 400);
  try {
    // ITS ANSWER IS RETURNED. This was `await advanceStage(...); return json({ ok: true })`, so a
    // refusal — the stage engine declining a key, or an application that was already there — came
    // back as a success to whatever called it.
    const moved = await advanceStage({ applicationId: id, toStage, actorUserId: user.id, actorName: user.name || user.email, note });
    if (!moved.ok) return json({ ok: false, error: moved.error || 'The stage was not changed.' }, 409);
    return json({ ok: true, changed: moved.changed });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[api/advance-stage]', e?.cause?.message || e?.message);
    return json({ ok: false, error: String(e?.cause?.message || e?.message || e).slice(0, 240) }, 500);
  }
};
