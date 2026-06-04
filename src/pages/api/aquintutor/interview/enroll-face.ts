// POST /api/aquintutor/interview/enroll-face
// Body: { sessionId, descriptor: number[128], fingerprint?: object }
// Saves the candidate's face reference descriptor + browser fingerprint.
// Called once during preflight before the interview starts.
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
  const descriptor = Array.isArray(body?.descriptor) ? body.descriptor : null;
  const fingerprint = (body?.fingerprint && typeof body.fingerprint === 'object') ? body.fingerprint : null;

  if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);
  if (descriptor && (descriptor.length !== 128 || !descriptor.every((n: any) => typeof n === 'number'))) {
    return json({ ok: false, error: 'descriptor must be number[128]' }, 400);
  }

  try {
    const s = await db.execute(sql`SELECT id, status FROM ai_interview_sessions WHERE id = ${sessionId} LIMIT 1`);
    const sRows = Array.isArray(s) ? s : (s?.rows || []);
    if (sRows.length === 0) return json({ ok: false, error: 'session not found' }, 404);
    if ((sRows[0] as any).status !== 'in_progress') return json({ ok: false, error: 'session closed' }, 410);

    if (descriptor) {
      const descJson = JSON.stringify(descriptor).replace(/'/g, "''");
      await db.execute(sql`
        UPDATE ai_interview_sessions
        SET face_descriptor = ${sql.raw("'" + descJson + "'::jsonb")},
            preflight_passed = true
        WHERE id = ${sessionId}
      `);
      await db.execute(sql`
        INSERT INTO ai_interview_events (session_id, event_type, severity, detail, client_ts)
        VALUES (${sessionId}, 'face_enrolled', 'info',
          ${sql.raw("'" + JSON.stringify({ dims: 128 }).replace(/'/g, "''") + "'::jsonb")}, NOW())
      `).catch(() => {});
    }

    if (fingerprint) {
      const fpJson = JSON.stringify(fingerprint).replace(/'/g, "''");
      await db.execute(sql`
        UPDATE ai_interview_sessions
        SET fingerprint = ${sql.raw("'" + fpJson + "'::jsonb")}
        WHERE id = ${sessionId}
      `);
      await db.execute(sql`
        INSERT INTO ai_interview_events (session_id, event_type, severity, detail, client_ts)
        VALUES (${sessionId}, 'fingerprint_captured', 'info',
          ${sql.raw("'" + fpJson + "'::jsonb")}, NOW())
      `).catch(() => {});
    }

    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
