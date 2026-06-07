import type { APIRoute } from 'astro';
import { recordQuizAttempt } from '@/lib/aquintutor-authoring';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorised' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  if (!body.lessonId || !body.blockId) return json({ ok: false, error: 'lessonId + blockId required' }, 400);
  try {
    await recordQuizAttempt({ userId: user.id, lessonId: body.lessonId, blockId: body.blockId, chosen: body.chosen, isCorrect: !!body.isCorrect });
    return json({ ok: true });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
