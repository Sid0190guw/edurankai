// POST /api/aquintutor/attempt — a student takes an assessment (Prompt 8). Gated: signed in +
// can(read) the assessment's securityLabels + can(execute) (student attempts). Practice = instant
// feedback, never affects eligibility; official = recorded + updates mastery on pass.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { createPgKernel } from '@/lib/kernel';
import { startAttempt, submitAttempt } from '@/lib/assessment';
import { ensureProctorSchema } from '@/lib/proctor';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const assessmentId = String(b.assessmentId || '');
  const mode = b.mode === 'official' ? 'official' : 'practice';
  const responses = (b.responses && typeof b.responses === 'object') ? b.responses : {};
  if (!assessmentId) return j({ ok: false, error: 'assessmentId required' }, 400);

  const obj = await createPgKernel().getObject(assessmentId).catch(() => null);
  if (!obj || obj.lifecycleState !== 'published') return j({ ok: false, error: 'assessment not available' }, 404);
  const labels = (obj as any).securityLabels || ['public'];
  const gate = await can(user, 'read', { type: 'AssessmentObject', securityLabels: labels });
  if (!gate.allow) return j({ ok: false, error: 'not permitted for this assessment' }, 403);
  const exec = await can(user, 'execute', { type: 'AssessmentObject', securityLabels: labels });   // audited attempt
  if (!exec.allow) return j({ ok: false, error: 'not permitted to attempt' }, 403);

  try {
    const attemptId = await startAttempt(user.id, assessmentId, mode);
    // Link an ATLAS proctoring session to this official attempt (Prompt 11), if one was run.
    const proctorSessionId = String(b.proctorSessionId || '');
    if (mode === 'official' && proctorSessionId) {
      try { await ensureProctorSchema(); await db.execute(sql`UPDATE edu_attempts SET proctor_session_id = ${proctorSessionId} WHERE id = ${attemptId}`); } catch { /* proctoring optional */ }
    }
    const r = await submitAttempt(attemptId, responses);
    // practice returns per-item feedback; official hides it (pct + state only)
    return j({ ok: true, attemptId, pct: r.pct, passed: r.passed, state: r.state, needsManual: r.needsManual, feedback: mode === 'practice' ? r.perItem : undefined });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
