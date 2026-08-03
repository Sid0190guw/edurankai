// src/pages/api/tests/save-progress.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { attemptAccess } from '@/lib/auth/attempt-access';

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  try {
    const body = await request.json();
    const { attemptId, answers, flagged, tabSwitches } = body;

    if (!attemptId) {
      return new Response(JSON.stringify({ ok: false, error: 'attemptId required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // This UPDATE overwrites a candidate's answers AND RESETS tab_switches, which is proctoring
    // evidence — the counter a human later reads when deciding whether somebody cheated. It ran with
    // no authorisation at all, so anyone holding an attempt id could rewrite another person's paper
    // and zero their own switch count. Ownership is checked before the write, never after.
    const access = await attemptAccess(String(attemptId), locals, cookies);
    if (!access.ok) {
      return new Response(JSON.stringify({ ok: false, error: access.error }), {
        status: access.status, headers: { 'Content-Type': 'application/json' }
      });
    }

    await db.execute(sql`
      UPDATE test_attempts
      SET answers = ${JSON.stringify(answers || {})},
          flagged_questions = ${JSON.stringify(flagged || {})},
          tab_switches = ${tabSwitches || 0}
      WHERE id = ${access.attempt.id} AND status = 'in_progress'
    `);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};
