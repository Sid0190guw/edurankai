// Shared list of accepted proctoring event types + human-readable labels.
// Used by both the test runner and the AI interview surface so the two
// admin viewers render identical event names.

export const ALLOWED_PROCTOR_EVENT_TYPES = new Set([
  // Tab + window
  'tab_hidden', 'tab_visible',
  'window_blur', 'window_focus',
  // Fullscreen
  'fullscreen_enter', 'fullscreen_exit', 'fullscreen_required_violation',
  // Input + clipboard
  'right_click_blocked',
  'copy', 'paste', 'cut', 'copy_blocked', 'paste_blocked',
  'keyboard_shortcut_blocked',
  'devtools_suspected',
  // Network
  'network_offline', 'network_online',
  // Mouse + idle + resize
  'mouse_leave', 'mouse_enter',
  'idle_start', 'idle_end',
  'orientation_change', 'resize',
  // Session bookkeeping
  'attempt_listeners_attached', 'session_listeners_attached',
  // Camera + mic (real-time analysis only; no bytes stored)
  'media_consent_granted', 'media_consent_denied', 'media_lost',
  'face_lost', 'face_visible', 'multiple_faces', 'looking_away',
  'voice_detected', 'voice_silenced',
]);

export const PROCTOR_EVENT_LABELS: Record<string, string> = {
  'tab_hidden': 'Tab hidden (switched away)',
  'tab_visible': 'Tab back in focus',
  'window_blur': 'Window lost focus',
  'window_focus': 'Window regained focus',
  'fullscreen_enter': 'Entered fullscreen',
  'fullscreen_exit': 'Exited fullscreen',
  'fullscreen_required_violation': 'Fullscreen required violation',
  'right_click_blocked': 'Right-click blocked',
  'copy': 'Copy',
  'paste': 'Paste',
  'cut': 'Cut',
  'copy_blocked': 'Copy blocked',
  'paste_blocked': 'Paste blocked',
  'keyboard_shortcut_blocked': 'Shortcut blocked',
  'devtools_suspected': 'DevTools suspected',
  'network_offline': 'Went offline',
  'network_online': 'Back online',
  'mouse_leave': 'Mouse left window',
  'mouse_enter': 'Mouse re-entered',
  'idle_start': 'Idle period started',
  'idle_end': 'Idle ended',
  'orientation_change': 'Orientation changed',
  'resize': 'Window resized',
  'attempt_listeners_attached': 'Test session started',
  'session_listeners_attached': 'Interview session started',
  'media_consent_granted': 'Camera + mic permission granted',
  'media_consent_denied': 'Camera + mic permission denied',
  'media_lost': 'Camera or mic stream lost',
  'face_lost': 'No face detected on camera',
  'face_visible': 'Face back on camera',
  'multiple_faces': 'Multiple faces detected',
  'looking_away': 'Looking away from screen',
  'voice_detected': 'Voice / talking detected',
  'voice_silenced': 'Voice stopped',
};

export function proctorEventLabel(type: string): string {
  return PROCTOR_EVENT_LABELS[type] || type;
}

export const VALID_SEVERITIES = new Set(['info', 'warn', 'flag']);
