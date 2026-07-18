// GET /api/aquintutor/board/inspect?session=SID — session roster + recent fires (Prompt A1b).
// Faculty-only (the driver): who joined, at which render tier, who is still online, what was fired.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { sessionInspector } from '@/lib/board-session';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return new Response(JSON.stringify({ ok: false, error: 'sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  const gate = await can(user, 'write', { type: 'AnimationObject' });
  if (!gate.allow) return new Response(JSON.stringify({ ok: false, error: 'faculty only' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  const sessionId = (url.searchParams.get('session') || '').trim();
  if (!sessionId) return new Response(JSON.stringify({ ok: false, error: 'missing session' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  try {
    const data = await sessionInspector(sessionId);
    return new Response(JSON.stringify({ ok: true, ...data }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.cause?.message || e?.message || 'error' }), { headers: { 'Content-Type': 'application/json' } });
  }
};
