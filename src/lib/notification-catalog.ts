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

// Per-type classification. Keys must match the `type` string passed to sendPushToAdmins /
// sendPushToUser EXACTLY — an unregistered type falls through to DEFAULT_META and is silently
// filed as system/medium, which drops it out of its real category, strips its priority badge,
// sorts it below less important events, and stops it persisting on screen. An audit on
// 2026-07-30 found 22 of 44 emitted types in exactly that state; entries marked "(user-facing
// counterpart)" are the ones that were missing.
const NOTIF_META: Record<string, NotifMeta> = {
  // Recruitment / jobs
  new_application:        { category: 'jobs', priority: 'high' },
  application_started:    { category: 'jobs', priority: 'high' },   // form completed, fee not yet cleared
  applicant_message:      { category: 'messages', priority: 'high' },
  application_status:     { category: 'jobs', priority: 'medium' },
  application_recovered:  { category: 'jobs', priority: 'high' },
  offer_extended:         { category: 'jobs', priority: 'high' },
  offer_signed:           { category: 'jobs', priority: 'critical' },
  offer_declined:         { category: 'jobs', priority: 'high' },
  study_abroad_request:   { category: 'jobs', priority: 'medium' },
  // Sent TO the candidate. An offer is the single most consequential message a candidate can
  // receive, so it is critical on their side just as offer_signed is on ours.
  applicant_offer:        { category: 'jobs', priority: 'critical' },
  applicant_status_change: { category: 'jobs', priority: 'high' },
  applicant_task_deadline: { category: 'jobs', priority: 'high' },  // time-boxed; late = disqualifying
  // Payments
  duplicate_application_fee: { category: 'payments', priority: 'high' },
  fee_waiver_applicant_reply: { category: 'payments', priority: 'medium' },
  fee_waiver_coupon_redeemed: { category: 'payments', priority: 'medium' },
  fee_waiver_request:     { category: 'payments', priority: 'high' },     // blocks the applicant until answered
  fee_waiver_approved:    { category: 'payments', priority: 'high' },     // (user-facing counterpart)
  fee_waiver_rejected:    { category: 'payments', priority: 'high' },     // (user-facing counterpart)
  intl_payment_request:   { category: 'payments', priority: 'high' },
  intl_payment_invoice:   { category: 'payments', priority: 'high' },     // (user-facing counterpart)
  intl_payment_received:  { category: 'payments', priority: 'high' },     // (user-facing counterpart)
  partnership_starter_paid: { category: 'payments', priority: 'critical' },
  // Money was captured but the application was never created. Revenue AND candidate harm, and
  // it needs manual repair — the same tier as an accepted offer.
  paid_application_stuck: { category: 'payments', priority: 'critical' },
  partner_payout_request: { category: 'payments', priority: 'high' },
  payroll_run:            { category: 'payments', priority: 'high' },
  // Messages / communication
  chat_message:           { category: 'messages', priority: 'medium' },
  dm_message:             { category: 'messages', priority: 'high' },
  dm:                     { category: 'messages', priority: 'high' },    // (user-facing counterpart)
  help_message:           { category: 'messages', priority: 'high' },
  inbound_mail:           { category: 'messages', priority: 'high' },    // (user-facing counterpart)
  visvambhara_applicant_reply: { category: 'messages', priority: 'medium' },
  visvambhara_reply:      { category: 'messages', priority: 'high' },    // (user-facing counterpart)
  fee_waiver_reply:       { category: 'messages', priority: 'high' },    // (user-facing counterpart)
  applicant_thread_message: { category: 'messages', priority: 'high' },
  // Interviews
  interview_scheduled:    { category: 'interviews', priority: 'critical' },
  ai_interview_completed: { category: 'interviews', priority: 'high' },  // finished; awaiting review
  // People & HR
  new_user:               { category: 'people', priority: 'low' },
  leave_request:          { category: 'people', priority: 'high' },
  attendance_flag:        { category: 'people', priority: 'medium' },
  friend_joined:          { category: 'people', priority: 'low' },
  // Academic / LMS
  test_submitted:         { category: 'academic', priority: 'high' },
  lms_enrolment:          { category: 'academic', priority: 'low' },
  course_completed:       { category: 'academic', priority: 'medium' },
  certificate_issued:     { category: 'academic', priority: 'high' },    // a credential the learner earned
  daily_done:             { category: 'academic', priority: 'low' },
  streak_at_risk:         { category: 'academic', priority: 'low' },     // a nudge, never an interrupt
  // Institutional
  new_hei_submission:     { category: 'institutional', priority: 'medium' },
  hei_truth_report:       { category: 'institutional', priority: 'medium' },
  // System / test
  test:                   { category: 'system', priority: 'low' },
};

const DEFAULT_META: NotifMeta = { category: 'system', priority: 'medium' };

// Dynamic type families. payouts.astro sends `type: 'partner_payout_' + action`, so the concrete
// strings are partner_payout_paid / _approved / _declined. Matching on the prefix means adding a
// new action can never silently degrade to system/medium the way a missing exact key does.
const PREFIX_META: [string, NotifMeta][] = [
  ['partner_payout_', { category: 'payments', priority: 'high' }],
];

export function metaFor(type: string): NotifMeta {
  const exact = NOTIF_META[type];
  if (exact) return exact;
  for (const [prefix, meta] of PREFIX_META) if (type.startsWith(prefix)) return meta;
  return DEFAULT_META;
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
