// POST /api/aquintutor/lesson-progress — a student marks a KnowledgeObject complete (Prompt 4).
// Form POST (zero client JS on the lesson page). Gated: signed in + permitted to read the unit
// (via can()); then advances mastery in aq_mastery + persists resume in edu_progress.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { contentService } from '@/lib/kernel-content';
import { completeLesson } from '@/lib/edu-runtime';
import { awardXp } from '@/lib/xp-ledger';

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

  try { await completeLesson(user.id, koId, seconds); } catch (e) { /* best-effort */ }
  try { await awardXp(user.id, 'lesson_complete', koId); } catch (e) { /* gamification best-effort, idempotent */ }
  return back(next);
};
