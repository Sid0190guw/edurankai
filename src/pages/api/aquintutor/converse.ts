// POST /api/aquintutor/converse  { conversationId?, language, topic?, level?, message }
import type { APIRoute } from 'astro';
import { continueConversation } from '@/lib/ai-tutor';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'sign in required' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const msg = (body.message || '').toString().trim();
  if (!msg) return json({ ok: false, error: 'message required' }, 400);
  const r = await continueConversation({
    conversationId: body.conversationId,
    userId: user.id,
    language: (body.language || 'en').toString(),
    topic: (body.topic || '').toString(),
    level: (body.level || 'beginner').toString(),
    userMessage: msg,
  });
  return json(r);
};
