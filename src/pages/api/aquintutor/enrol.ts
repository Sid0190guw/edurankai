// POST /api/aquintutor/enrol — self-service enrolment (Prompt 17). 'activate' turns an ACCEPTED
// applicant into a student (Prompt 16 hand-off); 'enrol' enrols in a course respecting prereqs +
// capacity. Access-scoped to the acting user. Audited.
import type { APIRoute } from 'astro';
import { writeAudit } from '@/lib/rbac';
import { myApplication, isEnrolmentEligible } from '@/lib/admissions';
import { enrolStudent, enrolInCourse } from '@/lib/enrolment';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'activate') {
      const app = await myApplication(user.id);
      if (!app || !isEnrolmentEligible(app.status)) return j({ ok: false, error: 'no accepted application to activate' }, 200);
      await enrolStudent(user.id, String(b.stage || 'undergraduate'), user.id);
      await writeAudit({ userId: user.id, capability: 'create', resource: 'enrolment:student', allow: true, reason: 'enrolment activated', stage: 'return-decision', matchedGrant: null, context: {}, at: new Date().toISOString() });
      return j({ ok: true });
    }
    if (b.action === 'enrol') {
      if (!b.courseObjId) return j({ ok: false, error: 'courseObjId required' }, 400);
      const r = await enrolInCourse(user.id, String(b.courseObjId), user.id);
      if (r.ok) await writeAudit({ userId: user.id, capability: 'execute', resource: 'enrolment:' + b.courseObjId, allow: true, reason: 'course enrolment', stage: 'return-decision', matchedGrant: null, context: {}, at: new Date().toISOString() });
      return j(r);
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
