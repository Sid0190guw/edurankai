// POST /api/aquintutor/interview/enroll-face
// Body: { sessionId, descriptor: number[128], fingerprint?: object }
// Saves the candidate's face reference descriptor + browser fingerprint.
// Called once during preflight before the interview starts.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { guardInterviewSession } from '@/lib/aquin/interview-session';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// SESSION OWNERSHIP IS THE TEST, AND IT IS NOW MADE — see src/lib/aquin/interview-session.ts.
//
// What this route did before: possession of a sessionId string was the whole credential, and /api/
// has no structural gate. Anyone holding one could overwrite the BIOMETRIC REFERENCE DESCRIPTOR for
// an in-progress interview and set preflight_passed = true — substitute their own face as the
// candidate's reference, which every later identity check is then measured against.
//
// The instrument is not a capability, because the question was never "may this person enrol a face";
// it is "is this caller the candidate whose session this is". /start binds the session to the
// browser that opened it and this refuses any other. No sign-in was added: who may call it is
// unchanged.
export const POST: APIRoute = async ({ request, cookies }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const sessionId = (body?.sessionId || '').toString();
  const descriptor = Array.isArray(body?.descriptor) ? body.descriptor : null;
  const fingerprint = (body?.fingerprint && typeof body.fingerprint === 'object') ? body.fingerprint : null;

  if (!sessionId) return json({ ok: false, error: 'sessionId required' }, 400);
  const gate = guardInterviewSession(cookies, sessionId);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);
  if (descriptor && (descriptor.length !== 128 || !descriptor.every((n: any) => typeof n === 'number'))) {
    return json({ ok: false, error: 'descriptor must be number[128]' }, 400);
  }

  try {
    const s = await db.execute(sql`SELECT id, status FROM ai_interview_sessions WHERE id = ${sessionId} LIMIT 1`);
    const sRows = Array.isArray(s) ? s : (s?.rows || []);
    if (sRows.length === 0) return json({ ok: false, error: 'session not found' }, 404);
    if ((sRows[0] as any).status !== 'in_progress') return json({ ok: false, error: 'session closed' }, 410);

    // The JSON travels as a BOUND PARAMETER cast to jsonb, not as sql.raw with hand-doubled quotes.
    // The old form was not injectable — doubling `'` is the correct escape inside a literal — but it
    // is one editing mistake away from being so, and `fingerprint` is an arbitrary object posted by
    // a browser. A parameter needs no escaping to be right.
    if (descriptor) {
      const descJson = JSON.stringify(descriptor);
      await db.execute(sql`
        UPDATE ai_interview_sessions
        SET face_descriptor = ${descJson}::jsonb,
            preflight_passed = true
        WHERE id = ${sessionId}
      `);
      await db.execute(sql`
        INSERT INTO ai_interview_events (session_id, event_type, severity, detail, client_ts)
        VALUES (${sessionId}, 'face_enrolled', 'info', ${JSON.stringify({ dims: 128 })}::jsonb, NOW())
      `).catch(() => {});
    }

    if (fingerprint) {
      const fpJson = JSON.stringify(fingerprint);
      await db.execute(sql`
        UPDATE ai_interview_sessions
        SET fingerprint = ${fpJson}::jsonb
        WHERE id = ${sessionId}
      `);
      await db.execute(sql`
        INSERT INTO ai_interview_events (session_id, event_type, severity, detail, client_ts)
        VALUES (${sessionId}, 'fingerprint_captured', 'info', ${fpJson}::jsonb, NOW())
      `).catch(() => {});
    }

    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
