// Presentation + classification for every notification type: which category it
// belongs to (for the Notification Center filters), its priority (drives
// requireInteraction, vibration, sort order), and its accent colour + icon.
//
// This is the single source of truth the server (push payload), the service
// worker (rich notification) and the Notification Center all read from, so a
// type looks and behaves consistently everywhere.

export type NotifCategory =
  | 'jobs' | 'messages' | 'payments' | 'interviews'
  | 'people' | 'academic' | 'institutional' | 'system';

export type NotifPriority = 'critical' | 'high' | 'medium' | 'low';

export interface NotifMeta {
  category: NotifCategory;
  priority: NotifPriority;
}

// Category-level visual + label (icon keys map to inline SVGs in the UI).
export const CATEGORY_META: Record<NotifCategory, { label: string; color: string; icon: string }> = {
  jobs:          { label: 'Jobs',          color: '#FF4F00', icon: 'briefcase' },
  messages:      { label: 'Messages',      color: '#1045BB', icon: 'message' },
  payments:      { label: 'Payments',      color: '#15803d', icon: 'wallet' },
  interviews:    { label: 'Interviews',    color: '#6d28d9', icon: 'calendar' },
  people:        { label: 'People',        color: '#b45309', icon: 'users' },
  academic:      { label: 'Academic',      color: '#0e7490', icon: 'book' },
  institutional: { label: 'Institutional', color: '#9333ea', icon: 'building' },
  system:        { label: 'System',        color: '#6b6259', icon: 'bell' },
};

export const PRIORITY_RANK: Record<NotifPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Per-type classification. Keys align with push.ts NOTIFICATION_TYPES + tags.
const NOTIF_META: Record<string, NotifMeta> = {
  // Recruitment / jobs
  new_application:        { category: 'jobs', priority: 'high' },
  applicant_message:      { category: 'messages', priority: 'high' },
  application_status:     { category: 'jobs', priority: 'medium' },
  application_recovered:  { category: 'jobs', priority: 'high' },
  offer_extended:         { category: 'jobs', priority: 'high' },
  offer_signed:           { category: 'jobs', priority: 'critical' },
  offer_declined:         { category: 'jobs', priority: 'high' },
  study_abroad_request:   { category: 'jobs', priority: 'medium' },
  // Payments
  duplicate_application_fee: { category: 'payments', priority: 'high' },
  fee_waiver_applicant_reply: { category: 'payments', priority: 'medium' },
  fee_waiver_coupon_redeemed: { category: 'payments', priority: 'medium' },
  intl_payment_request:   { category: 'payments', priority: 'high' },
  partnership_starter_paid: { category: 'payments', priority: 'critical' },
  payroll_run:            { category: 'payments', priority: 'high' },
  // Messages / communication
  chat_message:           { category: 'messages', priority: 'medium' },
  dm_message:             { category: 'messages', priority: 'high' },
  help_message:           { category: 'messages', priority: 'high' },
  visvambhara_applicant_reply: { category: 'messages', priority: 'medium' },
  applicant_thread_message: { category: 'messages', priority: 'high' },
  // Interviews
  interview_scheduled:    { category: 'interviews', priority: 'critical' },
  // People & HR
  new_user:               { category: 'people', priority: 'low' },
  leave_request:          { category: 'people', priority: 'high' },
  attendance_flag:        { category: 'people', priority: 'medium' },
  // Academic / LMS
  test_submitted:         { category: 'academic', priority: 'high' },
  lms_enrolment:          { category: 'academic', priority: 'low' },
  // Institutional
  new_hei_submission:     { category: 'institutional', priority: 'medium' },
  hei_truth_report:       { category: 'institutional', priority: 'medium' },
  // System / test
  test:                   { category: 'system', priority: 'low' },
};

const DEFAULT_META: NotifMeta = { category: 'system', priority: 'medium' };

export function metaFor(type: string): NotifMeta {
  return NOTIF_META[type] || DEFAULT_META;
}

/** High-priority events should stay on screen until acted on. */
export function isHighPriority(priority: NotifPriority): boolean {
  return priority === 'critical' || priority === 'high';
}

/** Android vibration pattern by priority (ms on/off). */
export function vibrationFor(priority: NotifPriority): number[] {
  switch (priority) {
    case 'critical': return [120, 60, 120, 60, 200];
    case 'high':     return [80, 50, 120];
    case 'medium':   return [60];
    default:         return [];
  }
}
