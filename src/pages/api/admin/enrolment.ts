// POST /api/admin/enrolment — registrar enrolment management (Prompt 17). Gated by
// can(manage, enrolment). Enrol a student in a course, set a student stage, set course meta. Audited.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { enrolStudent, enrolInCourse, setCourseMeta } from '@/lib/enrolment';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'manage', { type: 'enrolment' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (registrar/superadmin only)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'makeStudent') { if (!b.userId) return j({ ok: false, error: 'userId required' }, 400); await enrolStudent(String(b.userId), String(b.stage || 'undergraduate'), user.id); return j({ ok: true }); }
    if (b.action === 'enrol') { if (!b.userId || !b.courseObjId) return j({ ok: false, error: 'userId + courseObjId required' }, 400); return j(await enrolInCourse(String(b.userId), String(b.courseObjId), user.id)); }
    if (b.action === 'courseMeta') { if (!b.courseObjId) return j({ ok: false, error: 'courseObjId required' }, 400); await setCourseMeta(String(b.courseObjId), b.capacity != null ? Number(b.capacity) : null, Array.isArray(b.prereqs) ? b.prereqs.map((x: any) => String(x)) : []); return j({ ok: true }); }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
