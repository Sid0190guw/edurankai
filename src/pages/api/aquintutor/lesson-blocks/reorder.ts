import type { APIRoute } from 'astro';
import { reorderBlocks } from '@/lib/aquintutor-authoring';

function json(b: any, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorised' }, 403);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  if (!body.lessonId || !Array.isArray(body.ids)) return json({ ok: false, error: 'lessonId + ids[] required' }, 400);
  try { await reorderBlocks(body.lessonId, body.ids); return json({ ok: true }); }
  catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 240) }, 500); }
};
