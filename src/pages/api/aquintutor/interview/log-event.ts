// POST /api/aquintutor/interview/log-event
// Batch endpoint for AI interview proctoring events. Writes to
// ai_interview_events AND maintains per-session risk_score, strikes_count,
// tab_switches, fullscreen_exits. Triggers auto-termination when strikes
// reach the template's max_strikes or risk_score >= 90.
//
// Body: { sessionId, events: [{ type, severity?, detail?, clientTs? }, ...] }
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ALLOWED_PROCTOR_EVENT_TYPES, VALID_SEVERITIES } from '@/lib/proctor-events';
import { eventWeight, strikesFor } from '@/lib/sentinel';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

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
    const sR = await db.execute(sql`
      SELECT s.id, s.status, s.risk_score, s.strikes_count, s.tab_switches, s.fullscreen_exits,
        t.max_strikes, t.max_tab_switches, t.block_tab_switch, t.require_fullscreen
      FROM ai_interview_sessions s
      LEFT JOIN ai_interview_templates t ON s.template_id = t.id
      WHERE s.id = ${sessionId} LIMIT 1
    `);
    const sRows = rows(sR);
    if (sRows.length === 0) return json({ ok: false, error: 'session not found' }, 404);
    const sess = sRows[0] as any;
    if (sess.status !== 'in_progress') return json({ ok: true, inserted: 0, note: 'session closed' });

    const maxStrikes = Number(sess.max_strikes || 5);
    const maxTabSw = Number(sess.max_tab_switches || 3);
    const blockTabSw = !!sess.block_tab_switch;
    let riskScore = Number(sess.risk_score || 0);
    let strikes = Number(sess.strikes_count || 0);
    let tabSw = Number(sess.tab_switches || 0);
    let fsEx = Number(sess.fullscreen_exits || 0);
    let autoTermReason = '';

    let inserted = 0;
    const flagEvents: any[] = [];

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

      riskScore = Math.min(100, riskScore + eventWeight(type, severity));
      strikes += strikesFor(type);
      if (type === 'tab_hidden' || type === 'window_blur') tabSw++;
      if (type === 'fullscreen_exit' || type === 'fullscreen_required_violation') fsEx++;
      if (severity === 'flag' || severity === 'warn') flagEvents.push({ t: type, s: severity, at: clientTs });
    }

    if (blockTabSw && tabSw >= maxTabSw && !autoTermReason) {
      autoTermReason = 'tab_switch_limit_exceeded';
    }
    if (strikes >= maxStrikes && !autoTermReason) {
      autoTermReason = 'max_strikes_exceeded';
    }
    if (riskScore >= 90 && !autoTermReason) {
      autoTermReason = 'risk_score_critical';
    }

    await db.execute(sql`
      UPDATE ai_interview_sessions
      SET risk_score = ${riskScore},
          strikes_count = ${strikes},
          tab_switches = ${tabSw},
          fullscreen_exits = ${fsEx}
      WHERE id = ${sessionId}
    `).catch(() => {});

    if (autoTermReason) {
      await db.execute(sql`
        UPDATE ai_interview_sessions
        SET status = 'auto_terminated', ended_at = NOW(),
            auto_terminated_reason = ${autoTermReason}
        WHERE id = ${sessionId} AND status = 'in_progress'
      `).catch(() => {});
      await db.execute(sql`
        INSERT INTO ai_interview_events (session_id, event_type, severity, detail, client_ts)
        VALUES (${sessionId}, 'auto_terminated', 'flag',
          ${sql.raw("'" + JSON.stringify({ reason: autoTermReason, risk: riskScore, strikes }).replace(/'/g, "''") + "'::jsonb")},
          NOW())
      `).catch(() => {});
    }

    return json({
      ok: true,
      inserted,
      riskScore,
      strikes,
      tabSwitches: tabSw,
      fullscreenExits: fsEx,
      autoTerminated: !!autoTermReason,
      autoTerminatedReason: autoTermReason || null,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
