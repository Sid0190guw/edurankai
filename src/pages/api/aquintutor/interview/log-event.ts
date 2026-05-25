// POST /api/aquintutor/interview/log-event
// Batch endpoint for AI interview proctoring events. Mirror of
// /api/tests/log-event but writes to ai_interview_events.
// Body: { sessionId, events: [{ type, severity?, detail?, clientTs? }, ...] }
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ALLOWED_PROCTOR_EVENT_TYPES, VALID_SEVERITIES } from '@/lib/proctor-events';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const sessionId = (body?.sessionId || '').toString();
  const events = Array.isArray(body?.events) ? body.events : [];
  if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);
  if (events.length === 0) return json({ ok: true, inserted: 0 });
  if (events.length > 200) return json({ ok: false, error: 'too many events (max 200)' }, 400);

  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  try {
    const s = await db.execute(sql`SELECT id, status FROM ai_interview_sessions WHERE id = ${sessionId} LIMIT 1`);
    const sRows = Array.isArray(s) ? s : (s?.rows || []);
    if (sRows.length === 0) return json({ ok: false, error: 'session not found' }, 404);
    const sess = sRows[0] as any;
    if (sess.status !== 'in_progress') return json({ ok: true, inserted: 0, note: 'session closed' });

    let inserted = 0;
    for (const ev of events) {
      const type = (ev?.type || '').toString();
      if (!ALLOWED_PROCTOR_EVENT_TYPES.has(type)) continue;
      const severity = VALID_SEVERITIES.has(ev?.severity) ? ev.severity : 'info';
      const detail = ev?.detail || {};
      const clientTs = ev?.clientTs ? new Date(ev.clientTs) : null;

      await db.execute(sql`
        INSERT INTO ai_interview_events (session_id, event_type, severity, detail, client_ts, ip_address)
        VALUES (${sessionId}, ${type}, ${severity},
          ${sql.raw("'" + JSON.stringify(detail).replace(/'/g, "''") + "'::jsonb")},
          ${clientTs}, ${ip || null})
      `).catch(() => {});
      inserted++;
    }
    return json({ ok: true, inserted });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
