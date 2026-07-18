// POST /api/admin/assessments — authoring + manual grading (Prompt 8). Each action gated via
// can() (audited): create/addItem/deleteItem need write-class caps; publish + gradeManual need
// 'execute' (reviewer_examiner/faculty). Assessments are kernel AssessmentObjects (assesses edge).
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { createAssessment, addItem, deleteItem, publishAssessment, gradeManual, type ItemType } from '@/lib/assessment';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const TYPES: ItemType[] = ['mcq', 'numeric', 'true_false', 'short_answer'];
const LABELS = ['public', 'enrolled-only', 'exam-secure'];

function parseAnswer(type: string, b: any): any {
  if (type === 'mcq') return { correctIndex: Number(b.correctIndex) || 0 };
  if (type === 'numeric') return { value: Number(b.value) || 0, tolerance: Number(b.tolerance) || 0 };
  if (type === 'true_false') return { value: b.value === true || b.value === 'true' };
  return {};
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const action = String(b.action || '');
  const need: Record<string, string> = { create: 'create', addItem: 'write', deleteItem: 'write', publish: 'execute', gradeManual: 'execute' };
  const cap = need[action];
  if (!cap) return j({ ok: false, error: 'unknown action' }, 400);
  const d = await can(user, cap as any, { type: 'AssessmentObject' });
  if (!d.allow) return j({ ok: false, error: `not permitted: need "${cap}"`, reason: d.reason }, 403);

  try {
    if (action === 'create') {
      if (!b.title || !b.koId) return j({ ok: false, error: 'title + koId required' }, 400);
      const label = LABELS.includes(b.securityLabel) ? b.securityLabel : 'public';
      const id = await createAssessment(String(b.title), String(b.kind || 'quiz'), String(b.koId), user.id, [label]);
      return j({ ok: true, id });
    }
    if (action === 'addItem') {
      const type = TYPES.includes(b.type) ? b.type : null;
      if (!b.assessmentId || !type || !b.prompt) return j({ ok: false, error: 'assessmentId + valid type + prompt required' }, 400);
      const options = Array.isArray(b.options) ? b.options.map((x: any) => String(x)) : (typeof b.options === 'string' ? b.options.split('\n').map((s: string) => s.trim()).filter(Boolean) : []);
      const id = await addItem(String(b.assessmentId), { type, prompt: String(b.prompt), options, answer: parseAnswer(type, b), points: Number(b.points) || 1, sort: Number(b.sort) || 0 });
      return j({ ok: true, id });
    }
    if (action === 'deleteItem') { await deleteItem(String(b.itemId)); return j({ ok: true }); }
    if (action === 'publish') { await publishAssessment(String(b.assessmentId)); return j({ ok: true }); }
    if (action === 'gradeManual') {
      if (!b.attemptId) return j({ ok: false, error: 'attemptId required' }, 400);
      const r = await gradeManual(String(b.attemptId), Number(b.manualPoints) || 0, user.id);
      return j({ ok: true, ...r });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
