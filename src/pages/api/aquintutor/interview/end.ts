// POST /api/aquintutor/interview/end
// Body: { sessionId }
// Marks the session completed. Summary LLM grading is deferred for now.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const sessionId = (body?.sessionId || '').toString();
  if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);

  try {
    await db.execute(sql`
      UPDATE ai_interview_sessions SET status = 'completed', ended_at = NOW()
      WHERE id = ${sessionId} AND status = 'in_progress'
    `);
    return json({ ok: true, redirect: '/aquintutor/interview/done?session=' + encodeURIComponent(sessionId) });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
