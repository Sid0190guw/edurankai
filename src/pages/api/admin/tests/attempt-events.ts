// GET /api/admin/tests/attempt-events?id=<attempt_id>&since=<iso_ts>
// Returns events newer than `since` for live sentinel monitoring.
// Admin-only.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'auth required' }, 401);
  if (user.role === 'applicant') return json({ ok: false, error: 'admin only' }, 403);

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
