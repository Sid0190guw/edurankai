// POST /api/aquintutor/lesson-progress — a student marks a KnowledgeObject complete (Prompt 4).
// Form POST (zero client JS on the lesson page). Gated: signed in + permitted to read the unit
// (via can()); then advances mastery in aq_mastery + persists resume in edu_progress.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { contentService } from '@/lib/kernel-content';
import { completeLesson } from '@/lib/edu-runtime';
import { awardXp, xpAwardKey, xpAmountFor } from '@/lib/xp';

function back(next: string) { return new Response(null, { status: 303, headers: { Location: next } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  const form = await request.formData().catch(() => null);
  const koId = String(form?.get('koId') || '');
  const next = String(form?.get('next') || '/aquintutor/courses');
  const seconds = Number(form?.get('seconds') || 0) || 0;
  if (!user?.id || !koId) return back('/aquintutor/login');

  const view = await contentService().getUnitView(koId).catch(() => null);
  if (!view) return new Response('not found', { status: 404 });
  const labels = (view.unit as any).securityLabels || ['public'];
  const gate = await can(user, 'read', { type: 'KnowledgeObject', securityLabels: labels });   // audited
  if (!gate.allow) return back('/aquintutor/courses?locked=1');

  // Two writes, neither of them allowed to fail in silence. The learner is redirected either way —
  // a lesson they finished should not become a 500 — but a completion that did not record is a
  // support call somebody has to answer, and it has to be findable in the log.
  try {
    await completeLesson(user.id, koId, seconds);
  } catch (e: any) {
    console.error('[lesson-progress] completeLesson', e?.cause?.message || e?.message);
  }

  // ONE XP LEDGER. This used to award into src/lib/xp-ledger.ts (edu_xp_ledger), which is retired:
  // the same learner then had two different XP totals on two pages that are both linked from
  // /aquintutor/access, and neither was wrong. The once-only guarantee that ledger provided is kept
  // here by awardKey — re-opening a lesson you have already completed awards nothing a second time —
  // and the amount still comes from /admin/xp-config.
  try {
    await awardXp({
      userId: user.id,
      source: 'lesson_complete',
      delta: await xpAmountFor('lesson_complete'),
      refId: koId,
      reason: 'Lesson completed',
      awardKey: xpAwardKey(user.id, 'lesson_complete', koId),
    });
  } catch (e: any) {
    console.error('[lesson-progress] awardXp', e?.cause?.message || e?.message);
  }
  return back(next);
};
