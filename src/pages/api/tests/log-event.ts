// POST /api/tests/log-event
// Batch endpoint: client buffers proctoring events and flushes here every few
// seconds (and on submit). Each row goes into test_attempt_events and severe
// events also bump counters on test_attempts so existing dashboards still see
// summary numbers.
//
// Body: { attemptId, events: [{ type, severity?, detail?, clientTs? }, ...] }
//
// AUTHORISATION. This header used to read "No auth required because anonymous attempts are allowed
// by the runner; we scope writes by attemptId only". Scoping by an identifier the CALLER SUPPLIES is
// not scoping: anyone holding an attempt id could write into test_attempt_events, which is the
// advisory proctoring record a human reads when deciding whether a candidate cheated. Forgeable
// evidence that looks authoritative is worse than none.
//
// Anonymous attempts really are allowed, so the fix is ownership rather than sign-in:
// attemptAccess() (src/lib/auth/attempt-access.ts) requires the session to be the attempt's
// candidate, or — for a guest attempt, which has candidate_id NULL — the httpOnly `gat_<test_id>`
// cookie the runner set when the attempt was created. A real candidate carries one or the other.
//
// Still enforced, unchanged:
//   - attempt must exist
//   - attempt must be in 'in_progress' (or just submitted/auto_submitted
//     within last 60s) so we don't keep accepting events forever
//
// WHY THIS IS THREE ROUND TRIPS AND NOT N+3, AND WHY A FAILED WRITE NOW ANSWERS 500.
//
// It used to run one INSERT per event inside the loop. The runner flushes every 2.5s and the elite
// event set includes per-click, per-keypress-burst and 1.5s face sampling, so a normal batch is
// 10-40 events and the cap is 200 — up to 200 sequential statements, each one able to pay the
// ~810ms this deployment charges for OPENING a connection. The batch is validated in JS and written
// by a single INSERT ... SELECT FROM jsonb_to_recordset, so the cost no longer grows with the batch.
//
// The second half matters more than the speed. Every insert had its own try/catch that counted
// `failed++` and the handler still answered HTTP 200, so the runner's `if (!r.ok)` beacon fallback
// never fired and the batch — already spliced out of the client buffer — was simply gone. A reviewer
// then opens /admin/tests/sentinel/[attemptId], whose integrity ring is COUNTED FROM ROWS IN
// test_attempt_events, and reads "Continue - no escalation needed" about a candidate whose flag
// events were never written. Proctoring here is advisory and a human decides on that screen, so
// "the writes failed" must never render as "the candidate was clean". One statement either lands or
// throws, and a throw reaches the outer catch and answers 500, which is what makes the client retry.
//
// A timed-out write may still land — withDbTimeout sheds the WAIT and not the WORK — so a retried
// batch can duplicate. Duplicates are visible to the reviewer as duplicates; a missing flag is
// invisible and reads as innocence. That is the trade this makes deliberately.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { attemptAccess, type AttemptAccess } from '@/lib/auth/attempt-access';
import { withDbTimeout, isDbUnavailable } from '@/lib/db-timeout';

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

/**
 * Bootstrap the event table once per instance rather than once per flush.
 *
 * CREATE TABLE IF NOT EXISTS is still a round trip wherever schema bootstrap is permitted, and this
 * endpoint is hit every 2.5s by every candidate sitting a test. Set only on SUCCESS, so a bootstrap
 * that failed is attempted again by the next flush instead of being marked done forever.
 */
let schemaEnsured = false;

export const POST: APIRoute = async ({ request, locals, cookies, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const attemptId = (body?.attemptId || '').toString();
  const events = Array.isArray(body?.events) ? body.events : [];
  if (!attemptId) return json({ ok: false, error: 'attemptId required' }, 400);
  if (events.length === 0) return json({ ok: true, inserted: 0 });
  if (events.length > 200) return json({ ok: false, error: 'too many events in one batch (max 200)' }, 400);

  // Ownership first. attemptAccess() also does the "attempt exists" lookup that used to happen
  // below, so this is one query, not two.
  //
  // Bounded, and deliberately NOT retried: the runner flushes here every 2.5s, so asking twice
  // inside one flush only doubles the load on a database that is already struggling — the next
  // flush IS the retry. Unbounded, a stalled connection held the invocation until the gateway
  // killed it and the candidate's events went nowhere with nothing logged.
  let access: AttemptAccess;
  try {
    access = await withDbTimeout(attemptAccess(attemptId, locals, cookies), 'tests.logEvent.access', 3000);
  } catch (e: any) {
    console.error('[tests/log-event] attempt ownership check failed -', e?.cause?.message || e?.message);
    return json({
      ok: false,
      error: isDbUnavailable(e)
        ? 'the database did not answer, so these proctoring events were not recorded'
        : 'the attempt could not be checked, so these proctoring events were not recorded',
    }, 503);
  }
  if (!access.ok) return json({ ok: false, error: access.error }, access.status);
  const attempt = access.attempt;

  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);

  try {
    const submittedRecently = attempt.submitted_at && (Date.now() - new Date(attempt.submitted_at).getTime() < 60000);
    if (attempt.status !== 'in_progress' && !submittedRecently) {
      return json({ ok: true, inserted: 0, note: 'attempt closed' });
    }

    // Ensure schema exists (first-call bootstrap) so older deployments without
    // a prior migration don't silently drop every event.
    if (!schemaEnsured) {
      try {
        await withDbTimeout(db.execute(sql`CREATE TABLE IF NOT EXISTS test_attempt_events (
          id BIGSERIAL PRIMARY KEY,
          attempt_id UUID NOT NULL,
          event_type VARCHAR(60) NOT NULL,
          severity VARCHAR(16) NOT NULL DEFAULT 'info',
          detail JSONB,
          client_ts TIMESTAMPTZ,
          ip_address VARCHAR(64),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`), 'tests.logEvent.ddl.table', 3000);
        await withDbTimeout(db.execute(sql`CREATE INDEX IF NOT EXISTS tae_attempt_idx ON test_attempt_events(attempt_id, created_at DESC)`), 'tests.logEvent.ddl.index', 3000);
        schemaEnsured = true;
      } catch (e: any) {
        // Logged rather than swallowed: if this is what is failing, the INSERT below fails too and
        // the 500 it raises is the only reason anyone finds out the log is not being written.
        console.error('[tests/log-event] event table bootstrap -', e?.cause?.message || e?.message);
      }
    }

    let inserted = 0;
    let skipped = 0;
    let tabSwitchInc = 0;
    let fullscreenExitInc = 0;
    const flagSummary: any[] = [];
    // [{ t: event_type, s: severity, d: detail, ts: client_ts|null }] — the shape jsonb_to_recordset
    // expands below. The loop now only validates; nothing in it talks to the database.
    const okRows: { t: string; s: string; d: any; ts: string | null }[] = [];

    for (const ev of events) {
      const type = (ev?.type || '').toString();
      if (!ALLOWED_TYPES.has(type)) { skipped++; continue; }
      const severity = SEVERITIES.has(ev?.severity) ? ev.severity : 'info';

      // One unserialisable detail must not cost the other 199 events their row. The batch is
      // stringified as a SINGLE parameter below, so anything JSON.stringify cannot survive is
      // replaced with {} here — the same protection the per-event stringify used to give.
      let detail: any = {};
      try { detail = JSON.parse(JSON.stringify(ev?.detail || {})); } catch { detail = {}; }

      // Same reason for the timestamp. An unparseable clientTs used to fail only its own INSERT;
      // in one statement it would fail all 200, so it is dropped to NULL and the row still lands
      // with its server-side created_at.
      let clientTs: string | null = null;
      if (ev?.clientTs) {
        const d = new Date(ev.clientTs);
        if (!Number.isNaN(d.getTime())) clientTs = d.toISOString();
      }

      okRows.push({ t: type, s: severity, d: detail, ts: clientTs });

      if (type === 'tab_hidden' || type === 'window_blur') tabSwitchInc++;
      if (type === 'fullscreen_exit' || type === 'fullscreen_required_violation') fullscreenExitInc++;
      if (severity === 'flag' || severity === 'warn') flagSummary.push({ t: type, s: severity, at: clientTs });
    }

    if (okRows.length > 0) {
      // ONE statement, ONE parameter, and that parameter is a JSON STRING — never a JS array with
      // ::text[]. postgres-js serialises an interpolated array as a RECORD literal and Postgres
      // answers "cannot cast type record to text[]"; src/lib/pg-array.ts exists because that shape
      // broke six call sites for months.
      //
      // No try/catch on purpose. A failed write must reach the outer catch and answer 500 — that is
      // what fires the runner's beacon fallback instead of losing a batch it has already spliced out
      // of its buffer, and what stops a reviewer being shown a clean integrity ring for a log that
      // was never written.
      const r = await withDbTimeout(db.execute(sql`
        INSERT INTO test_attempt_events (attempt_id, event_type, severity, detail, client_ts, ip_address)
        SELECT ${attemptId}::uuid, e.t, e.s, e.d, e.ts, ${ip || null}
        FROM jsonb_to_recordset(${JSON.stringify(okRows)}::jsonb)
          AS e(t text, s text, d jsonb, ts timestamptz)
        RETURNING 1
      `), 'tests.logEvent.insert', 5000);
      inserted = (Array.isArray(r) ? r : (r?.rows || [])).length;   // postgres-js returns a plain array
    }

    let summaryStale = false;
    if (tabSwitchInc > 0 || fullscreenExitInc > 0 || flagSummary.length > 0) {
      // The rows above ARE the record a human reviews; this only bumps the summary counters older
      // dashboards read. It stays non-fatal for exactly that reason — answering 500 here would make
      // the client resend a batch that has already landed, and duplicated flags on a proctoring
      // record are their own false claim. But `.catch(() => {})` is gone: a counter that did not
      // move is now logged and reported, because "0 tab switches" is a claim too.
      //
      // The flag summary is BOUND rather than pasted into the statement text. The old version built
      // SQL by string concatenation and escaped only single quotes, which is one unusual character
      // in a detail payload away from a syntax error on a proctoring write.
      try {
        await withDbTimeout(db.execute(sql`
          UPDATE test_attempts SET
            tab_switches = COALESCE(tab_switches, 0) + ${tabSwitchInc},
            fullscreen_exits = COALESCE(fullscreen_exits, 0) + ${fullscreenExitInc},
            suspicious_activity = COALESCE(suspicious_activity, '[]'::jsonb) || ${JSON.stringify(flagSummary)}::jsonb
          WHERE id = ${attemptId}
        `), 'tests.logEvent.summary', 3000);
      } catch (e: any) {
        summaryStale = true;
        console.error('[tests/log-event] attempt summary counters not updated -', e?.cause?.message || e?.message);
      }
    }

    return json({ ok: true, inserted, skipped, summaryStale: summaryStale || undefined });
  } catch (e: any) {
    // e.message is only the failed SQL on this driver; the real Postgres reason is on e.cause.
    // This is the line that tells whoever is on call that a proctoring log stopped being written.
    console.error('[tests/log-event] batch not recorded -', e?.cause?.message || e?.message);
    return json({
      ok: false,
      error: isDbUnavailable(e)
        ? 'the database did not answer, so these proctoring events were not recorded'
        : 'these proctoring events were not recorded',
    }, 500);
  }
};
