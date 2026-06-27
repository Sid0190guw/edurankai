// Single source of truth for WHO receives each notification type.
//
// Problem this solves: both notify.ts and push.ts used to fan every event out
// to *every* non-applicant user, so marketing / editors / partners / teachers
// received HR and recruitment alerts they have no business seeing. This maps
// each notification type to the admin roles that should actually receive it.
//
// Rules:
//  - super_admin ALWAYS receives everything (the owner never misses anything).
//  - A type mapped to [] is delivered only to super_admin (plus per-user sends).
//  - A type NOT in the map returns null => delivered to all admins. This is a
//    deliberate fail-open default so a brand-new/unmapped type is never
//    silently dropped (a missed notification is worse than an over-broad one).
//  - 'applicant' and 'partner' are external roles and are never admins here.

export type AppRole =
  | 'super_admin' | 'hr' | 'recruiter' | 'reviewer' | 'department_head'
  | 'marketing' | 'editor' | 'technical_moderator' | 'teacher'
  | 'partner' | 'applicant';

const HR_RECRUITING: AppRole[] = ['super_admin', 'hr', 'recruiter', 'reviewer', 'department_head'];
const HR_CORE: AppRole[] = ['super_admin', 'hr'];
const HR_OPS: AppRole[] = ['super_admin', 'hr', 'department_head'];
const RECRUITING: AppRole[] = ['super_admin', 'hr', 'recruiter'];

// Keys here align with push.ts NOTIFICATION_TYPES + the tags used at call sites.
export const NOTIFICATION_AUDIENCE: Record<string, AppRole[]> = {
  // ── Recruitment ──────────────────────────────────────────────
  new_application: HR_RECRUITING,
  applicant_message: HR_RECRUITING,
  application_status: HR_RECRUITING,
  application_recovered: HR_RECRUITING,
  duplicate_application_fee: RECRUITING,
  offer_extended: RECRUITING,
  offer_signed: RECRUITING,
  offer_declined: RECRUITING,
  fee_waiver_applicant_reply: HR_RECRUITING,
  fee_waiver_coupon_redeemed: RECRUITING,
  study_abroad_request: RECRUITING,
  intl_payment_request: RECRUITING,
  visvambhara_applicant_reply: HR_RECRUITING,
  // ── Communication ────────────────────────────────────────────
  chat_message: ['super_admin', 'hr', 'recruiter', 'reviewer', 'department_head', 'marketing', 'editor', 'technical_moderator'],
  help_message: ['super_admin', 'hr', 'recruiter', 'marketing', 'technical_moderator'],
  // ── People & HR ──────────────────────────────────────────────
  new_user: HR_CORE,
  leave_request: HR_OPS,
  attendance_flag: HR_OPS,
  payroll_run: HR_CORE,
  // ── Academic / LMS ───────────────────────────────────────────
  interview_scheduled: HR_RECRUITING,
  test_submitted: ['super_admin', 'hr', 'recruiter', 'reviewer', 'technical_moderator'],
  lms_enrolment: ['super_admin', 'teacher'],
  // ── Institutional ────────────────────────────────────────────
  new_hei_submission: ['super_admin', 'reviewer'],
  hei_truth_report: ['super_admin', 'reviewer'],
  // ── Finance / Partnerships ───────────────────────────────────
  partnership_starter_paid: HR_CORE,
};

/** Roles allowed to receive a notification type, or null = all admins. */
export function audienceFor(type: string): AppRole[] | null {
  if (Object.prototype.hasOwnProperty.call(NOTIFICATION_AUDIENCE, type)) {
    return NOTIFICATION_AUDIENCE[type];
  }
  return null; // fail-open: unmapped types go to everyone (never silently drop)
}

/** Is a given role eligible for a notification type? super_admin always is. */
export function roleCanReceive(role: string, type: string): boolean {
  if (role === 'super_admin') return true;
  if (role === 'applicant') return false; // never an admin recipient
  const audience = audienceFor(type);
  if (audience === null) return role !== 'applicant'; // all admins
  return audience.includes(role as AppRole);
}
