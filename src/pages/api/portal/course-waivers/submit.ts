// POST /api/portal/course-waivers/submit
// Body: { courseSlug, reason, evidenceUrl? }
//
// A learner asking for help with a COURSE fee. The application-fee waiver has its own endpoint
// (/api/portal/fee-waivers/submit) and its own flow; this is the same table, the same statuses and
// the same reviewer vocabulary, pointed at a course through reference_type/reference_id.
//
// EVERYTHING THAT DECIDES ANYTHING IS SERVER-SIDE. The body names a course and carries a reason;
// the price, the audience, whether there is anything to waive at all, and the approval routing are
// all resolved in src/lib/course-waiver.ts. Nothing here trusts a number from a browser.
//
// NO UPLOADS. If somebody wants to attach evidence it is a LINK. This product stores no files but a
// profile photo, and that is deliberate.
import type { APIRoute } from 'astro';
import { requestCourseWaiver } from '@/lib/course-waiver';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in to ask for a fee waiver.', loginUrl: '/portal/login' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const courseSlug = (body?.courseSlug || '').toString().trim();
  if (!courseSlug) return json({ ok: false, error: 'Which course?' }, 400);

  try {
    const result = await requestCourseWaiver({
      userId: String(user.id),
      courseIdOrSlug: courseSlug,
      reason: (body?.reason || '').toString(),
      evidenceUrl: (body?.evidenceUrl || '').toString(),
      user: { id: user.id, role: user.role },
    });

    if (!result.ok) return json({ ok: false, error: result.error }, 400);
    return json({
      ok: true,
      waiverId: result.waiverId,
      status: result.status,
      changed: result.changed !== false,
      warning: result.warning || null,
      message: result.changed === false
        ? 'You have already asked for a waiver on this course. We will come back to you.'
        : 'Your request is with the team. You will be told the answer either way.',
    });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL and names the schema.
    console.error('[api/portal/course-waivers/submit]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'We could not submit that request just now. Nothing was saved. Try again in a moment.' }, 500);
  }
};
