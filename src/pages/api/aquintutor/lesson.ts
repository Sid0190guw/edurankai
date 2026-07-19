// POST /api/aquintutor/lesson — Block 03: the JSON entrypoint for the lesson runtime.
// action-dispatched: 'start' (runs the pipeline; guests allowed for public KOs),
// 'complete' (advance mastery; sign-in required), 'offline' (compile an offline package).
import type { APIRoute } from 'astro';
import { LessonRequest, runLesson, completeLessonRun, prepareOffline } from '@/lib/runtime/lesson-engine';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user ?? null;
  let body: unknown; try { body = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const parsed = LessonRequest.safeParse(body);
  if (!parsed.success) return j({ ok: false, error: 'invalid body', issues: parsed.error.issues.map((i) => i.message) }, 400);
  const { action, koId, seconds, tier, maxBytes } = parsed.data;

  try {
    if (action === 'start') {
      const { view, result, isStaff } = await runLesson(user, koId, request);
      if (!view || !result) return j({ ok: false, error: 'unit not found' }, 404);
      return j({ ok: true, result, isStaff });
    }

    // complete / offline require a signed-in user
    if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);

    if (action === 'complete') {
      const { state } = await completeLessonRun(user.id, koId, seconds);
      return j({ ok: true, state });
    }
    if (action === 'offline') {
      const manifest = await prepareOffline(user.id, koId, tier ?? 'lite', maxBytes);
      return j({ ok: true, manifest });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200);
  }
};
