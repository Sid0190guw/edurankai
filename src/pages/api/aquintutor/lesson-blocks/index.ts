import type { APIRoute } from 'astro';
import { createBlock } from '@/lib/aquintutor-authoring';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorised' }, 403);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  if (!body.lessonId || !body.kind) return json({ ok: false, error: 'lessonId + kind required' }, 400);
  try {
    const block = await createBlock(body.lessonId, { kind: body.kind, content: body.content || {} });
    return json({ ok: true, block });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
