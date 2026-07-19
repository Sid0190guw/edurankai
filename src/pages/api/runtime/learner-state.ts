// GET /api/runtime/learner-state?studentObjectId=<uuid> — Block 04: read the persisted
// LearnerState for a student. Owner-gated.
import type { APIRoute } from 'astro';
import { createPgKernel } from '@/lib/kernel';
import { loadLearnerState } from '@/lib/runtime/estimators';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const id = (new URL(request.url).searchParams.get('studentObjectId') || '').trim();
  if (!id) return j({ ok: false, error: 'studentObjectId required' }, 400);

  const kernel = createPgKernel();
  const obj = await kernel.getObject(id);
  if (!obj || obj.type !== 'StudentObject') return j({ ok: false, error: 'not a StudentObject' }, 404);
  if (obj.owner !== user.id) return j({ ok: false, error: 'not your learner record' }, 403);

  const learnerState = await loadLearnerState(kernel, id);
  return j({ ok: true, learnerState });
};
