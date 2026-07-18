// POST /api/aquintutor/proctor — receive privacy-preserving TEXT proctoring events (Prompt 11).
// The server sanitizes to { type, at } only, so NO media bytes are ever stored even if a client
// tries to attach them. Signed-in students post to their own session. Advisory only.
import type { APIRoute } from 'astro';
import { recordEvents } from '@/lib/proctor';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const sessionId = String(b.sessionId || '');
  if (!sessionId) return j({ ok: false, error: 'sessionId required' }, 400);
  try { const n = await recordEvents(sessionId, user.id, Array.isArray(b.events) ? b.events : []); return j({ ok: true, recorded: n }); }
  catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
