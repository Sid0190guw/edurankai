// Proctoring integrity scoring — Honorlock-class severity model.
// Maps every event type to a severity weight, then computes a 0-100 integrity
// score per attempt. Used by /admin/tests/attempts/[id]/integrity.

export const EVENT_SEVERITY: Record<string, { weight: number; category: string; label: string }> = {
  // -------- Critical (strong cheating signal) --------
  'screen_share_started':       { weight: 25, category: 'screen', label: 'Screen recording started' },
  'screen_record_attempt':      { weight: 25, category: 'screen', label: 'Screen capture API invoked' },
  'multi_monitor_detected':     { weight: 18, category: 'screen', label: 'Multiple monitors detected' },
  'monitor_count_changed':      { weight: 15, category: 'screen', label: 'Monitor count changed mid-test' },
  'devtools_opened':            { weight: 22, category: 'browser', label: 'DevTools opened' },
  'browser_extension_suspected':{ weight: 12, category: 'browser', label: 'Extension activity suspected' },
  'virtual_camera_suspected':   { weight: 20, category: 'browser', label: 'Virtual camera signature' },
  'incognito_suspected':        { weight: 8,  category: 'browser', label: 'Incognito mode suspected' },

  // -------- High (cheating-likely behavioural) --------
  'multiple_faces':             { weight: 22, category: 'face', label: 'Multiple faces in frame' },
  'voice_multiple_speakers':    { weight: 18, category: 'audio', label: 'Multiple voices detected' },
  'phone_like_object_detected': { weight: 20, category: 'face', label: 'Phone-like object in frame' },
  'away_from_seat':             { weight: 16, category: 'face', label: 'Away from seat (extended face loss)' },
  'face_obscured':              { weight: 14, category: 'face', label: 'Face obscured' },
  'paste_after_blur':           { weight: 16, category: 'input', label: 'Paste right after tab-switch' },
  'clipboard_read':             { weight: 10, category: 'input', label: 'Clipboard read attempt' },
  'page_source_view_attempt':   { weight: 12, category: 'browser', label: 'View source attempted' },

  // -------- Medium --------
  'tab_hidden':                 { weight: 8,  category: 'focus', label: 'Tab hidden' },
  'window_blur':                { weight: 7,  category: 'focus', label: 'Window lost focus' },
  'fullscreen_exit':            { weight: 6,  category: 'focus', label: 'Fullscreen exited' },
  'fullscreen_required_violation': { weight: 10, category: 'focus', label: 'Required fullscreen left' },
  'face_lost':                  { weight: 6,  category: 'face', label: 'Face left frame' },
  'looking_away':               { weight: 4,  category: 'face', label: 'Looking away' },
  'mouth_movement_detected':    { weight: 6,  category: 'face', label: 'Mouth movement (talking)' },
  'unusual_head_rotation':      { weight: 5,  category: 'face', label: 'Unusual head rotation' },
  'eyes_closed_extended':       { weight: 7,  category: 'face', label: 'Eyes closed extended period' },
  'voice_detected':             { weight: 4,  category: 'audio', label: 'Voice detected' },
  'background_noise_high':      { weight: 3,  category: 'audio', label: 'Noisy environment' },
  'copy':                       { weight: 3,  category: 'input', label: 'Copy event' },
  'paste':                      { weight: 4,  category: 'input', label: 'Paste event' },
  'cut':                        { weight: 3,  category: 'input', label: 'Cut event' },
  'right_click':                { weight: 2,  category: 'input', label: 'Right-click' },
  'print_attempt':              { weight: 8,  category: 'browser', label: 'Print attempt' },
  'window_resize_suspicious':   { weight: 5,  category: 'focus', label: 'Suspicious window resize' },
  'unusual_typing_pattern':     { weight: 5,  category: 'input', label: 'Unusual typing pattern' },

  // -------- Low (informational, near-zero weight) --------
  'looking_down':               { weight: 1,  category: 'face', label: 'Looking down' },
  'looking_up':                 { weight: 1,  category: 'face', label: 'Looking up' },
  'head_tilt':                  { weight: 1,  category: 'face', label: 'Head tilt' },
  'bad_posture':                { weight: 1,  category: 'face', label: 'Bad posture' },
  'face_partial':               { weight: 2,  category: 'face', label: 'Face partial' },
  'face_too_small':             { weight: 2,  category: 'face', label: 'Face too small' },
  'devtools_suspected':         { weight: 4,  category: 'browser', label: 'DevTools suspected (heuristic)' },
  'network_offline':            { weight: 2,  category: 'network', label: 'Network offline' },
  'idle_start':                 { weight: 1,  category: 'focus', label: 'Idle' },
  'mouse_leave':                { weight: 1,  category: 'focus', label: 'Mouse left viewport' },
  'orientation_change':         { weight: 1,  category: 'device', label: 'Device orientation changed' },
  'resize':                     { weight: 0,  category: 'device', label: 'Window resized' },
  'page_zoom_changed':          { weight: 2,  category: 'browser', label: 'Page zoom changed' },
  'right_click_blocked':        { weight: 1,  category: 'input', label: 'Right-click blocked' },
  'copy_blocked':               { weight: 2,  category: 'input', label: 'Copy blocked' },
  'paste_blocked':              { weight: 3,  category: 'input', label: 'Paste blocked' },
  'keyboard_shortcut_blocked':  { weight: 2,  category: 'input', label: 'Shortcut blocked' },
  'print_blocked':              { weight: 4,  category: 'browser', label: 'Print blocked' },
};

// 0–100 score (100 = clean). Sums weights of all events, applies a cap so
// hundreds of low-severity events don't crush the score, and a floor of 0.
// Repeated identical events stack but each repetition contributes a
// diminishing 70% of the previous one (anti-spam).
export interface IntegrityResult {
  score: number;
  riskBand: 'clean' | 'low' | 'medium' | 'high' | 'critical';
  bySeverity: { critical: number; high: number; medium: number; low: number };
  byCategory: Record<string, number>;
  totalEvents: number;
  flaggedEvents: number;
  topFlags: { type: string; count: number; weight: number; label: string }[];
}

export function computeIntegrityScore(events: { type: string; severity?: string }[]): IntegrityResult {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;

  const byCategory: Record<string, number> = {};
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  let raw = 0;

  for (const [type, count] of Object.entries(counts)) {
    const spec = EVENT_SEVERITY[type] || { weight: 0, category: 'other', label: type };
    // Diminishing returns: total = w + 0.7w + 0.49w + ...
    const effective = count > 0 ? spec.weight * (1 - Math.pow(0.7, count)) / (1 - 0.7) : 0;
    raw += effective;
    byCategory[spec.category] = (byCategory[spec.category] || 0) + effective;
    if (spec.weight >= 20) bySeverity.critical += count;
    else if (spec.weight >= 12) bySeverity.high += count;
    else if (spec.weight >= 4) bySeverity.medium += count;
    else if (spec.weight > 0) bySeverity.low += count;
  }

  // Score: 100 - capped(raw). Anything past 100 saturates the score to 0.
  const score = Math.max(0, Math.min(100, Math.round(100 - raw)));
  const riskBand: IntegrityResult['riskBand'] =
    score >= 90 ? 'clean' :
    score >= 75 ? 'low' :
    score >= 55 ? 'medium' :
    score >= 30 ? 'high' :
    'critical';

  const topFlags = Object.entries(counts)
    .map(([type, count]) => {
      const spec = EVENT_SEVERITY[type] || { weight: 0, category: 'other', label: type };
      return { type, count, weight: spec.weight, label: spec.label };
    })
    .filter(f => f.weight > 0)
    .sort((a, b) => (b.weight * b.count) - (a.weight * a.count))
    .slice(0, 8);

  return {
    score, riskBand, bySeverity, byCategory,
    totalEvents: events.length,
    flaggedEvents: bySeverity.critical + bySeverity.high + bySeverity.medium,
    topFlags,
  };
}

export const RISK_BAND_COLORS: Record<IntegrityResult['riskBand'], { bg: string; fg: string; border: string; label: string }> = {
  clean:    { bg: 'rgba(74,222,128,0.14)',  fg: '#86efac', border: 'rgba(74,222,128,0.4)',  label: 'Clean' },
  low:      { bg: 'rgba(34,211,238,0.14)',  fg: '#67e8f9', border: 'rgba(34,211,238,0.4)',  label: 'Low risk' },
  medium:   { bg: 'rgba(251,191,36,0.14)',  fg: '#fbbf24', border: 'rgba(251,191,36,0.4)',  label: 'Medium risk' },
  high:     { bg: 'rgba(249,115,22,0.16)',  fg: '#fb923c', border: 'rgba(249,115,22,0.4)',  label: 'High risk' },
  critical: { bg: 'rgba(239,68,68,0.18)',   fg: '#fca5a5', border: 'rgba(239,68,68,0.45)',  label: 'Critical risk' },
};
