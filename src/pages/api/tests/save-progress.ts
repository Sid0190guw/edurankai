// src/pages/api/tests/save-progress.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { attemptId, answers, flagged, tabSwitches } = body;

    if (!attemptId) {
      return new Response(JSON.stringify({ ok: false, error: 'attemptId required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    await db.execute(sql`
      UPDATE test_attempts
      SET answers = ${JSON.stringify(answers || {})},
          flagged_questions = ${JSON.stringify(flagged || {})},
          tab_switches = ${tabSwitches || 0}
      WHERE id = ${attemptId} AND status = 'in_progress'
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
