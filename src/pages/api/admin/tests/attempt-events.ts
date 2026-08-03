// GET /api/admin/tests/attempt-events?id=<attempt_id>&since=<iso_ts>
// Returns events newer than `since` for live sentinel monitoring.
// Admin-only.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  // A named candidate's per-attempt proctoring log. That is the `tests_proctoring` section
  // (middleware.ts:68), and the sentinel page this feeds sits under /admin/tests, which the same
  // section family already gates. Proctoring output is advisory and a human decides on it — so the
  // set of humans who may read it is not "everyone who is not an applicant".
  const denied = await denyAdminApi(locals, { section: 'tests_proctoring', action: 'view', label: 'tests.attempt-events' });
  if (denied) return denied;

  const url = new URL(request.url);
  const attemptId = (url.searchParams.get('id') || '').trim();
  const sinceRaw = (url.searchParams.get('since') || '').trim();
  if (!attemptId) return json({ ok: false, error: 'id required' }, 400);

  try {
    const r = await db.execute(sql`
      SELECT id, event_type, severity, detail, client_ts, created_at
      FROM test_attempt_events
      WHERE attempt_id = ${attemptId}
        ${sinceRaw ? sql`AND created_at > ${sinceRaw}::timestamptz` : sql``}
      ORDER BY created_at ASC LIMIT 500
    `);
    const events = Array.isArray(r) ? r : (r?.rows || []);

    // Also return updated counters
    const c = await db.execute(sql`
      SELECT status, tab_switches, fullscreen_exits, percentage, submitted_at,
        (SELECT COUNT(*)::int FROM test_attempt_events WHERE attempt_id = ${attemptId} AND severity = 'flag') as flag_count,
        (SELECT COUNT(*)::int FROM test_attempt_events WHERE attempt_id = ${attemptId} AND severity = 'warn') as warn_count,
        (SELECT COUNT(*)::int FROM test_attempt_events WHERE attempt_id = ${attemptId}) as total_events
      FROM test_attempts WHERE id = ${attemptId} LIMIT 1
    `);
    const cRows = Array.isArray(c) ? c : (c?.rows || []);
    const counters = cRows[0] || null;

    return json({ ok: true, events, counters });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
