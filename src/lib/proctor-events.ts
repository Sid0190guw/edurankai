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
  'print_blocked', 'save_blocked', 'screen_share_blocked',
  // Network
  'network_offline', 'network_online',
  // Mouse + idle + resize
  'mouse_leave', 'mouse_enter',
  'idle_start', 'idle_end', 'idle_long',
  'orientation_change', 'resize',
  // Session bookkeeping
  'attempt_listeners_attached', 'session_listeners_attached',
  'fingerprint_captured', 'preflight_passed', 'preflight_failed',
  'strike_added', 'auto_terminated',
  // Identity verification
  'face_enrolled', 'face_match', 'face_mismatch',
  // Camera + mic (real-time analysis only; no bytes stored)
  'media_consent_granted', 'media_consent_denied', 'media_lost',
  'face_lost', 'face_visible', 'multiple_faces',
  'looking_away', 'looking_down', 'looking_up', 'head_tilt', 'gaze_restored',
  'face_partial', 'face_too_small',
  'voice_detected', 'voice_silenced',
  'audio_no_mouth', 'mouth_no_audio',
  // Display / hardware
  'multi_monitor_detected', 'screen_resolution_changed', 'devicepixel_change',
  // Object detection (coco-ssd)
  'cell_phone_detected', 'book_detected', 'laptop_detected', 'tv_detected',
  'remote_detected', 'extra_person_detected', 'object_cleared',
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
  'audio_no_mouth': 'Voice detected but mouth not moving (external audio)',
  'mouth_no_audio': 'Mouth moving but no audio (muted speech)',
  'print_blocked': 'Print shortcut blocked',
  'save_blocked': 'Save shortcut blocked',
  'screen_share_blocked': 'Screen-share attempt blocked',
  'idle_long': 'Long idle period (>2 min no input)',
  'fingerprint_captured': 'Browser fingerprint captured',
  'preflight_passed': 'Preflight checks passed',
  'preflight_failed': 'Preflight checks failed',
  'strike_added': 'Strike issued',
  'auto_terminated': 'Session auto-terminated by proctor',
  'face_enrolled': 'Face reference enrolled',
  'face_match': 'Face matches enrolled identity',
  'face_mismatch': 'Face does not match enrolled identity',
  'looking_down': 'Looking down (notes / phone)',
  'looking_up': 'Looking up / away',
  'head_tilt': 'Head tilted / poor posture',
  'gaze_restored': 'Gaze back on screen',
  'face_partial': 'Face partially out of frame',
  'face_too_small': 'Face too far from camera',
  'multi_monitor_detected': 'Multiple monitors detected',
  'screen_resolution_changed': 'Screen resolution changed mid-session',
  'devicepixel_change': 'Device pixel ratio changed (window moved)',
  'cell_phone_detected': 'Cell phone in frame',
  'book_detected': 'Book / paper in frame',
  'laptop_detected': 'Secondary laptop in frame',
  'tv_detected': 'TV / monitor in frame',
  'remote_detected': 'Remote control in frame',
  'extra_person_detected': 'Extra person in frame',
  'object_cleared': 'Object no longer in frame',
};

export function proctorEventLabel(type: string): string {
  return PROCTOR_EVENT_LABELS[type] || type;
}

export const VALID_SEVERITIES = new Set(['info', 'warn', 'flag']);
