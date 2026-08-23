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
//  - A type NOT in the map goes to super_admin ONLY, and says so in the log.
//  - 'applicant' and 'partner' are external roles and are never admins here.
//
// =================================================================================================
// THE UNMAPPED DEFAULT USED TO BE "EVERYONE", AND ELEVEN LIVE TYPES WERE TAKING IT
// =================================================================================================
//
// The old default returned null for an unmapped type, and roleCanReceive turned null into
// `role !== 'applicant'` — every active non-applicant user, INCLUDING the `partner` role this
// header says is never an admin here. The stated reason was that a missed notification is worse
// than an over-broad one, which is a fair trade for a notification that carries nothing. These did
// not carry nothing. Eleven types reached sendPushToAdmins/notifyAllAdmins with no map entry:
//
//   activity_alert, activity_digest        the platform oversight feed — money moved, a permission
//                                          changed, data left the building — to marketing and partners
//   paid_application_stuck                 a named applicant, their email, and the error that ate
//                                          their payment
//   payment_effect_failed                  "Payment taken but not applied", with the order id
//   credit_debit_stranded                  a rupee amount taken from a named user's wallet
//   tool_pass_stranded                     the same, for a day pass
//   fee_waiver_request                     a person's declared inability to pay, to editors
//   course_fee_waiver_requested            the same, for a course
//   offer_verification_request             a named candidate, and the firm checking their offer
//   partner_payout_request                 payout amounts
//   application_started                    a candidate's name and email before they have paid
//
// So the default is now super_admin ONLY. That still never drops a notification — super_admin
// receives everything by the first rule in roleCanReceive — it just stops broadcasting a stranger's
// name, money and hardship to every role in the building while somebody gets round to adding a map
// entry. The log line names the missing type so adding that entry is a one-liner, and
// notify-audience.test.ts fails the build if a NEW broadcast type appears with no entry at all.

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

  // ── Added after the audit that found them taking the unmapped default ────────
  // Recruitment, so the same audience as the rest of the recruitment funnel.
  application_started: HR_RECRUITING,
  fee_waiver_request: RECRUITING,
  offer_verification_request: RECRUITING,
  paid_application_stuck: RECRUITING,
  // Money incidents. Every one of these points at /admin/finance or /admin/course-waivers and needs
  // a hand to fix it, so it goes to the people who have that hand — not to everyone with a login.
  payment_effect_failed: HR_CORE,
  credit_debit_stranded: HR_CORE,
  tool_pass_stranded: HR_CORE,
  course_fee_waiver_requested: HR_CORE,
  partner_payout_request: HR_CORE,
  // Platform oversight. summarise() puts the actor and the object of the event in the body, and the
  // routing table sends permission changes and data exports here, so this is the owner's feed and
  // nobody else's.
  activity_alert: ['super_admin'],
  activity_digest: ['super_admin'],

  // ── HORIZON signals ──────────────────────────────────────────────────────────
  // An automatically detected change in somebody's working record, addressed to whoever can do
  // something about it. Four keys rather than one, because the categories are not four shades of the
  // same thing: an Opportunity is a good thing being noticed out loud, and an Attention is a machine
  // asking a human to look at something BEFORE any human has looked at it.
  //
  // Attention is HR_CORE for that reason. A department head is not cut out of it — HR is the reviewer
  // every Attention signal is assigned to, and routing it onward is one screen with a person's name
  // against it. Broadcasting it first would be a finding about somebody circulated on nobody's
  // authority. Category-to-key mapping lives in src/lib/horizon/signal-visibility.ts.
  horizon_signal_opportunity: HR_OPS,
  horizon_signal_growth: HR_OPS,
  horizon_signal_watch: HR_OPS,
  horizon_signal_attention: HR_CORE,
};

/** Types already reported as unmapped, so the warning is one line per type per process, not per send. */
const WARNED = new Set<string>();

/**
 * Roles allowed to receive a notification type, or null when the type has no entry.
 *
 * null still means "unmapped" so a caller can tell the difference between a deliberate [] and a
 * missing entry. What it no longer means is "everyone" — see roleCanReceive.
 */
export function audienceFor(type: string): AppRole[] | null {
  if (Object.prototype.hasOwnProperty.call(NOTIFICATION_AUDIENCE, type)) {
    return NOTIFICATION_AUDIENCE[type];
  }
  return null;
}

/**
 * Is a given role eligible for a notification type? super_admin always is.
 *
 * An unmapped type reaches super_admin and nobody else. It is not dropped — the first line here
 * already delivered it to the one account that receives everything — and it is not broadcast.
 */
export function roleCanReceive(role: string, type: string): boolean {
  if (role === 'super_admin') return true;
  if (role === 'applicant' || role === 'partner') return false; // external roles, never admins here
  const audience = audienceFor(type);
  if (audience === null) {
    if (type && !WARNED.has(type)) {
      WARNED.add(type);
      console.warn('[notify-audience] no audience is mapped for notification type "' + type + '";'
        + ' it is going to super_admin only. Add it to NOTIFICATION_AUDIENCE in'
        + ' src/lib/notify-audience.ts so the people responsible for it are told.');
    }
    return false;
  }
  return audience.includes(role as AppRole);
}
