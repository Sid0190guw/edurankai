// Sentinel risk scoring for proctored sessions.
// Pure weight table; called both at log-event ingest (incremental bump) and
// at admin-view (recompute from full event log).
// Risk scale: 0 (clean) → 100 (auto-terminate worthy).

export type ScoringEvent = { event_type: string; severity?: string | null };

const WEIGHTS: Record<string, number> = {
  // Light noise - never bump
  tab_visible: 0, window_focus: 0, face_visible: 0, voice_silenced: 0,
  gaze_restored: 0, network_online: 0, mouse_enter: 0, idle_end: 0,
  fullscreen_enter: 0, object_cleared: 0, face_match: 0,
  session_listeners_attached: 0, attempt_listeners_attached: 0,
  preflight_passed: 0, fingerprint_captured: 0, face_enrolled: 0,

  // Mild concern
  copy: 1, paste: 1, cut: 1, resize: 1, orientation_change: 1,
  mouse_leave: 1, idle_start: 1, looking_up: 1, head_tilt: 1,
  copy_blocked: 1, paste_blocked: 2,
  devicepixel_change: 1,

  // Moderate concern
  tab_hidden: 4, window_blur: 3,
  looking_away: 2, looking_down: 3, face_partial: 3, face_too_small: 2,
  voice_detected: 2, keyboard_shortcut_blocked: 3,
  right_click_blocked: 1, network_offline: 3,
  multi_monitor_detected: 4, screen_resolution_changed: 2,
  print_blocked: 4, save_blocked: 3, screen_share_blocked: 8,
  idle_long: 4, preflight_failed: 5,
  book_detected: 6, remote_detected: 4, tv_detected: 5,
  laptop_detected: 6,

  // Serious concern
  fullscreen_exit: 6, fullscreen_required_violation: 7,
  face_lost: 6, devtools_suspected: 8,
  audio_no_mouth: 8, mouth_no_audio: 4,

  // Critical
  multiple_faces: 14, extra_person_detected: 14,
  face_mismatch: 18, cell_phone_detected: 16,
  media_lost: 12, media_consent_denied: 25,
  strike_added: 3, auto_terminated: 30,
};

export function eventWeight(type: string, severity?: string | null): number {
  if (type in WEIGHTS) return WEIGHTS[type];
  if (severity === 'flag') return 6;
  if (severity === 'warn') return 3;
  return 0;
}

export function computeRiskScore(events: ScoringEvent[]): number {
  let total = 0;
  for (const e of events) total += eventWeight(e.event_type, e.severity || undefined);
  return Math.min(100, Math.max(0, total));
}

export function riskBand(score: number): 'clean' | 'low' | 'medium' | 'high' | 'critical' {
  if (score <= 5) return 'clean';
  if (score <= 20) return 'low';
  if (score <= 45) return 'medium';
  if (score <= 75) return 'high';
  return 'critical';
}

export function riskColor(score: number): string {
  const b = riskBand(score);
  if (b === 'clean') return '#10b981';
  if (b === 'low') return '#84cc16';
  if (b === 'medium') return '#fbbf24';
  if (b === 'high') return '#f97316';
  return '#ef4444';
}

// Map serious events to strike weights. Strikes accumulate independently of
// the risk score and are what trigger auto-termination at max_strikes.
const STRIKE_WEIGHTS: Record<string, number> = {
  multiple_faces: 1,
  face_mismatch: 1,
  cell_phone_detected: 1,
  extra_person_detected: 1,
  fullscreen_required_violation: 1,
  media_lost: 2,
  media_consent_denied: 3,
  devtools_suspected: 1,
  screen_share_blocked: 1,
};
export function strikesFor(type: string): number {
  return STRIKE_WEIGHTS[type] || 0;
}
