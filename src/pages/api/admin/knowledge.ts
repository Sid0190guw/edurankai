// POST /api/admin/knowledge — authoring actions for Course/KnowledgeObjects (Prompt 3).
// Each action is capability-gated via can() (which audits): create/edit/attach/prereq need
// write-class caps (content_author+); publish/archive need 'execute' (content_author DENIED,
// reviewer_examiner/faculty/dean ALLOWED). All writes go through the kernel content service.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { contentService } from '@/lib/kernel-content';
import type { Equation, WorkedExample, SecurityLabel } from '@/lib/kernel';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
const LABELS: SecurityLabel[] = ['public', 'enrolled-only', 'exam-secure'];
function parseEquations(s: string): Equation[] { return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).map((latex) => ({ latex })); }
function parseExamples(s: string): WorkedExample[] { return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [prompt, ...rest] = l.split('::'); return { prompt: (prompt || '').trim(), solution: rest.join('::').trim() }; }).filter((e) => e.prompt); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const action = String(b.action || '');
  const svc = contentService();

  // capability required per action
  const need: Record<string, string> = { ensureCourse: 'create', createUnit: 'create', editUnit: 'write', attachUnit: 'write', addPrerequisite: 'write', publishUnit: 'execute', archiveUnit: 'execute' };
  const cap = need[action];
  if (!cap) return j({ ok: false, error: 'unknown action' }, 400);
  const decision = await can(user, cap as any, { type: 'KnowledgeObject' });
  if (!decision.allow) return j({ ok: false, error: `not permitted: need the "${cap}" capability`, reason: decision.reason }, 403);

  try {
    if (action === 'ensureCourse') {
      if (!b.trainingCourseId || !b.title) return j({ ok: false, error: 'trainingCourseId + title required' }, 400);
      const c = await svc.ensureCourse(String(b.trainingCourseId), String(b.title), b.summary ? String(b.summary) : undefined);
      return j({ ok: true, id: c.id });
    }
    if (action === 'createUnit') {
      if (!b.title) return j({ ok: false, error: 'title required' }, 400);
      const label: SecurityLabel = LABELS.includes(b.securityLabel) ? b.securityLabel : 'public';
      const lm: any = {};
      if (b.difficulty) lm.difficulty = String(b.difficulty);
      if (b.estimatedMinutes) lm.estimatedMinutes = Number(b.estimatedMinutes) || undefined;
      if (b.languages) lm.languages = String(b.languages).split(',').map((x: string) => x.trim()).filter(Boolean);
      const ko = await svc.createUnit({ title: String(b.title), body: b.body ? String(b.body) : undefined, equations: parseEquations(b.equations), examples: parseExamples(b.examples), securityLabels: [label], learningMetadata: lm, owner: user.id });
      if (b.courseObjId) await svc.attachUnit(String(b.courseObjId), ko.id, Number(b.order) || 1);
      return j({ ok: true, id: ko.id });
    }
    if (action === 'editUnit') {
      if (!b.id) return j({ ok: false, error: 'id required' }, 400);
      const patch: any = {};
      if (b.title !== undefined) patch.title = String(b.title);
      if (b.body !== undefined) patch.body = String(b.body);
      if (b.equations !== undefined) patch.equations = parseEquations(b.equations);
      if (b.examples !== undefined) patch.examples = parseExamples(b.examples);
      if (b.securityLabel && LABELS.includes(b.securityLabel)) patch.securityLabels = [b.securityLabel];
      await svc.editUnit(String(b.id), patch);
      return j({ ok: true });
    }
    if (action === 'attachUnit') {
      if (!b.courseObjId || !b.unitId) return j({ ok: false, error: 'courseObjId + unitId required' }, 400);
      await svc.attachUnit(String(b.courseObjId), String(b.unitId), Number(b.order) || 1);
      return j({ ok: true });
    }
    if (action === 'addPrerequisite') {
      if (!b.unitId || !b.prerequisiteUnitId || b.unitId === b.prerequisiteUnitId) return j({ ok: false, error: 'distinct unitId + prerequisiteUnitId required' }, 400);
      await svc.addPrerequisite(String(b.unitId), String(b.prerequisiteUnitId));
      return j({ ok: true });
    }
    if (action === 'publishUnit') {
      if (!b.id) return j({ ok: false, error: 'id required' }, 400);
      const o = await svc.publishUnit(String(b.id));
      return j({ ok: true, state: o.lifecycleState });
    }
    if (action === 'archiveUnit') {
      if (!b.id) return j({ ok: false, error: 'id required' }, 400);
      const o = await svc.archiveUnit(String(b.id));
      return j({ ok: true, state: o.lifecycleState });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200);
  }
};
