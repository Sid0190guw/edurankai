// POST /api/tests/log-event
// Batch endpoint: client buffers proctoring events and flushes here every few
// seconds (and on submit). Each row goes into test_attempt_events and severe
// events also bump counters on test_attempts so existing dashboards still see
// summary numbers.
//
// Body: { attemptId, events: [{ type, severity?, detail?, clientTs? }, ...] }
//
// We trust the attemptId only to insert rows for that attempt - the admin
// viewer is the source of truth for what happened. We also enforce:
//   - attempt must exist
//   - attempt must be in 'in_progress' (or just submitted/auto_submitted
//     within last 60s) so we don't keep accepting events forever
//
// No auth required because anonymous attempts are allowed by the runner; we
// scope writes by attemptId only.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

const ALLOWED_TYPES = new Set([
  'tab_hidden', 'tab_visible',
  'window_blur', 'window_focus',
  'fullscreen_enter', 'fullscreen_exit',
  'right_click_blocked', 'right_click',
  'copy', 'paste', 'cut', 'copy_blocked', 'paste_blocked',
  'keyboard_shortcut_blocked',
  'devtools_suspected', 'devtools_opened', 'devtools_closed',
  'network_offline', 'network_online',
  'mouse_leave', 'mouse_enter',
  'idle_start', 'idle_end',
  'orientation_change',
  'resize', 'window_resize_suspicious',
  'fullscreen_required_violation',
  'attempt_listeners_attached',
  // Elite-tier (Honorlock-class) — client + browser integrity
  'multi_monitor_detected', 'monitor_count_changed',
  'screen_share_started', 'screen_share_stopped',
  'screen_record_attempt',
  'clipboard_read', 'clipboard_write',
  'print_attempt', 'print_blocked',
  'page_zoom_changed',
  'browser_extension_suspected',
  'page_source_view_attempt',
  'incognito_suspected',
  'virtual_camera_suspected',
  // Camera + mic real-time analysis (no bytes stored, only text events)
  'media_consent_granted', 'media_consent_denied', 'media_lost',
  'face_lost', 'face_visible', 'multiple_faces', 'looking_away',
  'looking_down', 'looking_up', 'head_tilt', 'bad_posture', 'face_partial', 'face_too_small', 'gaze_restored',
  'voice_detected', 'voice_silenced',
  // Elite behavioural — face landmarks + audio
  'eyes_closed_extended', 'mouth_movement_detected',
  'voice_multiple_speakers', 'background_noise_high',
  'unusual_head_rotation', 'face_obscured',
  'away_from_seat',
  'phone_like_object_detected',
  'unusual_typing_pattern',
  'paste_after_blur',
  // Per-click + per-action tracking (every click, nav, answer change persisted as text)
  'question_navigated', 'question_answered', 'answer_changed', 'answer_cleared',
  'click', 'click_outside_question', 'rapid_clicks',
  'key_press_burst', 'long_idle_then_answer',
  'option_select', 'option_deselect',
  'mouse_pattern_unusual', 'scroll_burst',
  'submit_clicked', 'submit_blocked',
  'flag_review_toggle', 'review_panel_opened',
]);

const SEVERITIES = new Set(['info', 'warn', 'flag']);

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const attemptId = (body?.attemptId || '').toString();
  const events = Array.isArray(body?.events) ? body.events : [];
  if (!attemptId) return json({ ok: false, error: 'attemptId required' }, 400);
  if (events.length === 0) return json({ ok: true, inserted: 0 });
  if (events.length > 200) return json({ ok: false, error: 'too many events in one batch (max 200)' }, 400);

  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  try {
    // Confirm attempt exists; soft-bail otherwise
    const a = await db.execute(sql`SELECT id, status, submitted_at FROM test_attempts WHERE id = ${attemptId} LIMIT 1`);
    const aRows = Array.isArray(a) ? a : (a?.rows || []);
    if (aRows.length === 0) return json({ ok: false, error: 'attempt not found' }, 404);
    const attempt = aRows[0] as any;
    const submittedRecently = attempt.submitted_at && (Date.now() - new Date(attempt.submitted_at).getTime() < 60000);
    if (attempt.status !== 'in_progress' && !submittedRecently) {
      return json({ ok: true, inserted: 0, note: 'attempt closed' });
    }

    let inserted = 0;
    let tabSwitchInc = 0;
    let fullscreenExitInc = 0;
    const flagSummary: any[] = [];

    for (const ev of events) {
      const type = (ev?.type || '').toString();
      if (!ALLOWED_TYPES.has(type)) continue;
      const severity = SEVERITIES.has(ev?.severity) ? ev.severity : 'info';
      const detail = ev?.detail || {};
      const clientTs = ev?.clientTs ? new Date(ev.clientTs) : null;

      await db.execute(sql`
        INSERT INTO test_attempt_events (attempt_id, event_type, severity, detail, client_ts, ip_address)
        VALUES (${attemptId}, ${type}, ${severity}, ${sql.raw("'" + JSON.stringify(detail).replace(/'/g, "''") + "'::jsonb")},
          ${clientTs}, ${ip || null})
      `).catch(() => {});
      inserted++;

      if (type === 'tab_hidden' || type === 'window_blur') tabSwitchInc++;
      if (type === 'fullscreen_exit' || type === 'fullscreen_required_violation') fullscreenExitInc++;
      if (severity === 'flag' || severity === 'warn') flagSummary.push({ t: type, s: severity, at: clientTs });
    }

    if (tabSwitchInc > 0 || fullscreenExitInc > 0 || flagSummary.length > 0) {
      await db.execute(sql`
        UPDATE test_attempts SET
          tab_switches = COALESCE(tab_switches, 0) + ${tabSwitchInc},
          fullscreen_exits = COALESCE(fullscreen_exits, 0) + ${fullscreenExitInc},
          suspicious_activity = COALESCE(suspicious_activity, '[]'::jsonb) || ${sql.raw("'" + JSON.stringify(flagSummary).replace(/'/g, "''") + "'::jsonb")}
        WHERE id = ${attemptId}
      `).catch(() => {});
    }

    return json({ ok: true, inserted });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'server error' }, 500);
  }
};
