// src/lib/push.ts
// Server-side push notification sender.
// Used by API routes to send notifications to subscribed admin users.

import webpush from 'web-push';
import { db } from '@/lib/db';
import { pushSubscriptions, notificationPreferences, users } from '@/lib/db/schema';
import { eq, inArray, and, ne } from 'drizzle-orm';
import { roleCanReceive } from '@/lib/notify-audience';
import { metaFor, vibrationFor, isHighPriority, type NotifPriority } from '@/lib/notification-catalog';
import { ensureNotificationsSchema } from '@/lib/notifications-schema';

// Configure web-push with VAPID keys
const VAPID_PUBLIC = import.meta.env.VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = import.meta.env.VAPID_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = import.meta.env.VAPID_SUBJECT || process.env.VAPID_SUBJECT || 'mailto:siddharth@edurankai.in';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

export type NotificationType = string;

export interface PushPayload {
  type: NotificationType;
  title: string;
  body: string;
  url: string;
  tag?: string;
  // Rich-notification extras (all optional; auto-filled from the catalogue).
  category?: string;
  priority?: NotifPriority;
  image?: string;                 // large banner image
  icon?: string;
  badge?: string;
  actions?: { action: string; title: string; url?: string }[];
}

// Build the full payload the service worker renders: fills category/priority
// from the catalogue, derives requireInteraction + vibration from priority.
function enrichPayload(p: PushPayload) {
  const meta = metaFor(p.type);
  const priority = p.priority || meta.priority;
  return {
    ...p,
    category: p.category || meta.category,
    priority,
    icon: p.icon || '/era/icon-192.png',
    badge: p.badge || '/era/badge-72.png',
    requireInteraction: isHighPriority(priority),
    vibrate: vibrationFor(priority),
  };
}

// ── Canonical notification catalogue ────────────────────────────────────────
// Single source of truth. Add a row here and it appears in the settings UI and
// is respected by sendPushToAdmins automatically (no migration needed - the
// per-user opt-out lives in notification_preferences.prefs jsonb).
export const NOTIFICATION_TYPES: { type: string; label: string; desc: string; group: string }[] = [
  // Recruitment
  { type: 'new_application',    label: 'New applications',          desc: 'When someone submits an application',          group: 'Recruitment' },
  { type: 'application_started',label: 'Applications awaiting fee', desc: 'When someone completes the form but the fee has not cleared yet', group: 'Recruitment' },
  { type: 'application_recovered', label: 'Recovered applications', desc: 'When a stuck or abandoned application is automatically recovered', group: 'Recruitment' },
  { type: 'applicant_message',  label: 'Applicant messages',        desc: 'When an applicant replies on their application', group: 'Recruitment' },
  { type: 'application_status', label: 'Application status changes', desc: 'When an application moves to a new stage',      group: 'Recruitment' },
  { type: 'offer_extended',     label: 'Offer extended',            desc: 'When an offer is extended to a candidate',     group: 'Recruitment' },
  { type: 'offer_signed',       label: 'Offer accepted',            desc: 'When a candidate signs their offer letter',    group: 'Recruitment' },
  { type: 'offer_verification_request', label: 'Offer verification requests', desc: 'When an employer, institution or individual asks us to verify an offer letter', group: 'Recruitment' },
  { type: 'offer_declined',     label: 'Offer declined',            desc: 'When a candidate declines their offer',        group: 'Recruitment' },
  { type: 'fee_waiver_request', label: 'Fee waiver requests',       desc: 'When an applicant asks for the application fee to be waived', group: 'Recruitment' },
  { type: 'fee_waiver_applicant_reply', label: 'Fee waiver replies',        desc: 'When an applicant replies on a fee waiver thread', group: 'Recruitment' },
  { type: 'duplicate_application_fee', label: 'Duplicate fee charged',     desc: 'When an applicant is charged twice for the same application', group: 'Recruitment' },
  { type: 'paid_application_stuck',    label: 'Paid but not created',      desc: 'When a fee was captured but the application was never created - needs manual repair', group: 'Recruitment' },
  { type: 'fee_waiver_coupon_redeemed', label: 'Fee waiver coupon redeemed', desc: 'When an applicant redeems a fee-waiver coupon to bypass payment', group: 'Recruitment' },
  { type: 'study_abroad_request',       label: 'Study-abroad requests',       desc: 'When an applicant submits a study-abroad support request',       group: 'Recruitment' },
  { type: 'intl_payment_request',       label: 'International payment requests', desc: 'When an applicant requests an international payment path (Stripe / PayPal / wire / Wise)', group: 'Recruitment' },
  { type: 'partnership_starter_paid',   label: 'Partnership starter paid',  desc: 'When a partner pays their starter fee',        group: 'People & HR' },
  { type: 'partner_payout_request',     label: 'Partner payout requests',   desc: 'When a partner requests a payout',             group: 'People & HR' },
  { type: 'visvambhara_applicant_reply',label: 'Visvambhara access replies', desc: 'When an applicant replies on a Visvambhara access request', group: 'Recruitment' },
  // Communication
  { type: 'chat_message',       label: 'Discussion messages',       desc: 'When someone posts in any discussion channel', group: 'Communication' },
  { type: 'dm_message',         label: 'Direct messages',           desc: 'When you receive a direct message',            group: 'Communication' },
  { type: 'help_message',       label: 'Help inbox',                desc: 'When a new help / support message arrives',    group: 'Communication' },
  // People & HR
  { type: 'new_user',           label: 'New user registrations',    desc: 'When someone creates a portal account',        group: 'People & HR' },
  { type: 'leave_request',      label: 'Leave requests',            desc: 'When an employee applies for leave',           group: 'People & HR' },
  { type: 'attendance_flag',    label: 'Attendance flags',          desc: 'When attendance needs attention',              group: 'People & HR' },
  { type: 'payroll_run',        label: 'Payroll',                   desc: 'When a payroll run completes or needs review',  group: 'People & HR' },
  // Academic / LMS
  { type: 'interview_scheduled',label: 'Interviews',                desc: 'When an interview is scheduled or updated',    group: 'Academic' },
  { type: 'ai_interview_completed', label: 'AI interviews completed', desc: 'When a candidate finishes an AI interview and it is awaiting review', group: 'Academic' },
  { type: 'test_submitted',     label: 'Test submissions',          desc: 'When a candidate submits a proctored test',    group: 'Academic' },
  { type: 'lms_enrolment',      label: 'AquinTutor enrolments',     desc: 'When a learner enrols in a course',            group: 'Academic' },
  { type: 'course_completed',   label: 'Course completions',        desc: 'When a learner completes a course',            group: 'Academic' },
  // Institutional
  { type: 'new_hei_submission', label: 'HEI submissions',           desc: 'When an institution submits scores',           group: 'Institutional' },
  { type: 'activity_alert',     label: 'Platform alerts',           desc: 'Money moved, a permission changed, or data was exported - things needing attention immediately', group: 'People & HR' },
  { type: 'activity_digest',    label: 'Activity digest',           desc: 'A periodic roll-up of routine platform activity', group: 'People & HR' },
  { type: 'hei_truth_report',   label: 'HEI truth reports',         desc: 'When an HEI truth report is generated',        group: 'Institutional' },
];

// In-app notifications feed. THE TABLE IS NOT CREATED HERE.
//
// A private ensureNotificationsTable() used to sit on this spot with a CREATE TABLE IF NOT EXISTS
// that listed FEWER columns than persistNotification() below writes — no category, no priority, no
// is_archived, no seen_at/clicked_at. It was also dead: nothing called it, because persistNotification
// already awaits the canonical ensure. Dead or not it was a second CREATE of a shared table, and
// CREATE TABLE IF NOT EXISTS is a no-op on an existing one: had anything called it first on a fresh
// database, every later INSERT naming category/priority would have thrown forever while the code read
// as though notifications were being delivered.
//
// src/lib/notifications-schema.ts is the ONE module that creates this table. It is additive
// (ALTER ... ADD COLUMN IF NOT EXISTS) so it is safe against a table that pre-dates those columns.

// ONE STATEMENT FOR THE WHOLE AUDIENCE.
//
// This was persistNotification(userId, payload), and sendPushToAdmins below called it as
// `await Promise.all(eligibleIds.map((id) => persistNotification(id, payload)))` — one INSERT per
// member of staff, all issued CONCURRENTLY. That is the exact shape that took this site down once
// before: a single serverless invocation asking the Supabase transaction pooler for as many
// simultaneous connections as there are admins, on a path nineteen call sites use. At 60 staff that
// is 60 concurrent statements per notification, and notifications arrive in bursts.
//
// The recipient list is now unrolled INSIDE Postgres, so a fan-out to any headcount costs ONE
// statement on ONE connection. The de-dupe predicate is unchanged, only correlated to the unrolled
// id instead of a bound one.
//
// The ids travel as a JSON string, not as a JS array: src/lib/pg-array.ts documents that
// `${jsArray}::uuid[]` is serialised by postgres-js as a record literal and rejected by Postgres.
// notifications.user_id is UUID, hence the per-element cast.
async function persistNotifications(userIds: string[], p: PushPayload) {
  const ids = (userIds || []).filter((x) => typeof x === 'string' && x.length > 0);
  if (ids.length === 0) return;
  try {
    const { sql } = await import('drizzle-orm');
    await ensureNotificationsSchema();
    const meta = metaFor(p.type);
    const category = p.category || meta.category;
    const priority = p.priority || meta.priority;
    // De-dupe: only insert if an IDENTICAL notification (same user/type/title/
    // body/url) hasn't landed in the last 2 minutes. This kills the 2-3x
    // duplicates from retried handlers (payment verify + recovery sweep, page
    // re-renders, double POSTs) while still allowing genuinely different
    // messages — distinct body/title pass straight through.
    await db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type, action_url, category, priority)
      SELECT t.x::uuid, ${p.title}, ${p.body}, ${p.type}, ${p.url}, ${category}, ${priority}
        FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x)
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = t.x::uuid
          AND n.type = ${p.type}
          AND n.title = ${p.title}
          AND COALESCE(n.body, '') = COALESCE(${p.body}, '')
          AND COALESCE(n.action_url, '') = COALESCE(${p.url}, '')
          AND n.created_at > NOW() - INTERVAL '2 minutes'
      )
    `);
  } catch (e) { /* silent — never block delivery */ }
}

// Send a push notification to all admin users who have opted in for this type.
// ALSO writes a row to the in-app notifications feed for each eligible admin
// so the bell + /admin/notifications populate even if browser push fails.
export async function sendPushToAdmins(payload: PushPayload, excludeUserId?: string): Promise<void> {
  // Mirror every admin notification into the activity feed.
  //
  // Nineteen files call this function directly, and none of them recorded anything, so
  // /admin/activity was reading an empty table while notifications flew past it. Instrumenting the
  // sink they ALL already call turns every one of them into a producer without editing any of
  // them — and without a new call site to forget next time.
  //
  // Recorded as 'log-only' because the notification is going out on this very call; letting it
  // default to 'digest' would announce the same event a second time in the nightly summary.
  //
  // activity_alert / activity_digest are skipped deliberately: those are emitted BY the feed
  // itself (record() sends an alert when an event routes to 'push'), so recording them here would
  // call record -> sendPushToAdmins -> record and never terminate.
  if (payload.type !== 'activity_alert' && payload.type !== 'activity_digest') {
    import('@/lib/activity-feed')
      .then((m) => m.record('notify.' + payload.type, { title: payload.title, body: payload.body, url: payload.url }, { reach: 'log-only' }))
      // Never let bookkeeping stop a notification the user is waiting on.
      .catch(() => {});
  }

  const vapidConfigured = !!(VAPID_PUBLIC && VAPID_PRIVATE);
  if (!vapidConfigured) {
    console.warn('[push] VAPID keys not configured. Browser push skipped — in-app bell still works.');
  }

  try {
    // Admins only — applicants share the users table, must be excluded so
    // sendPushToAdmins doesn't fan out admin events to candidates' inboxes.
    const adminUsers = await db.select({ id: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.isActive, true), ne(users.role, 'applicant' as any)));

    // Scope by role: only the people responsible for THIS kind of event get it
    // (HR/recruiting for applications, etc.). super_admin always receives.
    const adminIds = adminUsers
      .filter(u => u.id !== excludeUserId && roleCanReceive(u.role as any, payload.type))
      .map(u => u.id);

    if (adminIds.length === 0) return;

    // Get preferences for these users
    const prefs = await db.select()
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, adminIds));

    const prefMap = new Map(prefs.map(p => [p.userId, p]));

    // Filter to users who want this notification type. Opt-out lives in the
    // flexible jsonb `prefs` map ({ [type]: false } = muted). Absent = ON.
    const eligibleIds = adminIds.filter(id => {
      const pref: any = prefMap.get(id);
      if (!pref) return true; // No prefs row = default ON
      const map = (pref.prefs && typeof pref.prefs === 'object') ? pref.prefs : {};
      return map[payload.type] !== false;
    });

    if (eligibleIds.length === 0) return;

    // Persist in-app notifications for every eligible admin FIRST. This is the
    // source of truth for the bell + /admin/notifications feed and is what
    // the user actually sees if the browser push is missed / stripped / muted.
    await persistNotifications(eligibleIds, payload);

    // If VAPID isn't configured, the in-app bell is everything — stop here.
    if (!vapidConfigured) return;

    // Get push subscriptions for eligible users
    const subs = await db.select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, eligibleIds));

    if (subs.length === 0) return;

    const pushData = JSON.stringify(enrichPayload(payload));

    // Send to all subscriptions in parallel
    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            pushData,
            { TTL: 86400 }
          );
          await db.update(pushSubscriptions)
            .set({ lastUsedAt: new Date() })
            .where(eq(pushSubscriptions.id, sub.id));
        } catch (err: any) {
          // 410 Gone = subscription expired/revoked - clean it up
          if (err.statusCode === 410 || err.statusCode === 404) {
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
          }
        }
      })
    );
  } catch (err) {
    console.error('[push] Failed to send push notifications:', err);
  }
}

// Send a push to ONE specific user (applicant or admin) - used for personalised
// updates like "your application moved to Reviewing" or "the team replied".
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!userId) return;
  // Persist to in-app feed regardless of VAPID config so the bell still shows
  // activity even before push is wired.
  await persistNotifications([userId], payload);
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  try {
    const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    if (subs.length === 0) return;
    const pushData = JSON.stringify(enrichPayload(payload));
    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            pushData, { TTL: 86400 }
          );
          await db.update(pushSubscriptions).set({ lastUsedAt: new Date() }).where(eq(pushSubscriptions.id, sub.id));
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
          }
        }
      })
    );
  } catch (err) {
    console.error('[push] sendPushToUser failed:', err);
  }
}

// Applicant-facing notifications (sent to the candidate, not the admins)
export const pushApplicant = {
  newMessage: (applicantUserId: string, fromName: string, preview: string, appId: string) =>
    sendPushToUser(applicantUserId, {
      type: 'applicant_thread_message',
      title: `Reply from ${fromName}`,
      body: preview.slice(0, 140),
      url: `/portal/applications/${appId}`,
      tag: `app-thread-${appId}`,
    }),

  statusChanged: (applicantUserId: string, roleTitle: string, newStatus: string, appId: string) =>
    sendPushToUser(applicantUserId, {
      type: 'applicant_status_change',
      title: 'Application update',
      body: `${roleTitle}: ${newStatus.replace(/_/g, ' ')}`,
      url: `/portal/applications/${appId}`,
      tag: `app-status-${appId}`,
      requireInteraction: true,
    } as any),

  offerExtended: (applicantUserId: string, roleTitle: string, appId: string) =>
    sendPushToUser(applicantUserId, {
      type: 'applicant_offer',
      title: 'You have an offer waiting',
      body: `Offer extended for ${roleTitle}. Open your application to review.`,
      url: `/portal/applications/${appId}`,
      tag: `offer-${appId}`,
      requireInteraction: true,
    } as any),

  taskDeadlineReminder: (applicantUserId: string, roleTitle: string, appId: string, hoursLeft: '24h' | '6h') =>
    sendPushToUser(applicantUserId, {
      type: 'applicant_task_deadline',
      title: hoursLeft === '24h' ? 'Task due in 1 day' : 'Task due in 6 hours',
      body: `Your task for ${roleTitle} is due soon — submit from your application.`,
      url: `/portal/applications/${appId}`,
      tag: `task-deadline-${hoursLeft}-${appId}`,
      requireInteraction: true,
    } as any),
};

// Convenience wrappers for each notification type
export const pushNotify = {
  chatMessage: (channelName: string, senderName: string, preview: string, channelSlug: string, excludeUserId?: string) =>
    sendPushToAdmins({
      type: 'chat_message',
      title: `#${channelName}`,
      body: `${senderName}: ${preview}`,
      url: `/admin/chat?c=${channelSlug}`,
      tag: `chat-${channelSlug}`
    }, excludeUserId),

  newApplication: (applicantName: string, roleName: string, appId: string) =>
    sendPushToAdmins({
      type: 'new_application',
      title: 'New Application',
      body: `${applicantName} applied for ${roleName}`,
      url: `/admin/applications/${appId}`,
      tag: 'new-application'
    }),

  applicationStatus: (applicantName: string, newStatus: string, appId: string) =>
    sendPushToAdmins({
      type: 'application_status',
      title: 'Application Updated',
      body: `${applicantName} → ${newStatus}`,
      url: `/admin/applications/${appId}`,
      tag: `app-status-${appId}`
    }),

  newHeiSubmission: (institutionName: string, claimId: string) =>
    sendPushToAdmins({
      type: 'new_hei_submission',
      title: 'New HEI Submission',
      body: institutionName,
      url: `/admin/hei/submissions/${claimId}`,
      tag: 'new-hei-submission'
    }),

  newUser: (userName: string, userId: string) =>
    sendPushToAdmins({
      type: 'new_user',
      title: 'New User Registered',
      body: userName,
      url: `/admin/users`,
      tag: 'new-user'
    }),

  offerSigned: (candidateName: string, roleName: string, appId: string) =>
    sendPushToAdmins({
      type: 'offer_signed',
      title: 'Offer Accepted',
      body: `${candidateName} signed their offer for ${roleName}`,
      url: `/admin/applications/${appId}`,
      tag: `offer-signed-${appId}`
    }),

  offerDeclined: (candidateName: string, roleName: string, appId: string) =>
    sendPushToAdmins({
      type: 'offer_declined',
      title: 'Offer Declined',
      body: `${candidateName} declined their offer for ${roleName}`,
      url: `/admin/applications/${appId}`,
      tag: `offer-declined-${appId}`
    }),

  // An applicant replied on their own application thread.
  applicantMessage: (applicantName: string, preview: string, appId: string) =>
    sendPushToAdmins({
      type: 'applicant_message',
      title: `Message from ${applicantName}`,
      body: preview,
      url: `/admin/applications/${appId}`,
      tag: `app-msg-${appId}`
    }),

  leaveRequest: (employeeName: string, detail: string, url = '/admin/leave') =>
    sendPushToAdmins({
      type: 'leave_request',
      title: 'Leave Request',
      body: `${employeeName}: ${detail}`,
      url,
      tag: 'leave-request'
    }),

  testSubmitted: (candidateName: string, testTitle: string, url = '/admin/tests/attempts') =>
    sendPushToAdmins({
      type: 'test_submitted',
      title: 'Test Submitted',
      body: `${candidateName} submitted ${testTitle}`,
      url,
      tag: 'test-submitted'
    }),

  lmsEnrolment: (learnerName: string, courseTitle: string, url = '/admin/training') =>
    sendPushToAdmins({
      type: 'lms_enrolment',
      title: 'New Enrolment',
      body: `${learnerName} enrolled in ${courseTitle}`,
      url,
      tag: 'lms-enrolment'
    }),

  courseCompleted: (learnerName: string, courseTitle: string, certNumber: string) =>
    sendPushToAdmins({
      type: 'course_completed',
      title: 'Course completed',
      body: `${learnerName} finished ${courseTitle} (${certNumber})`,
      url: '/admin/training',
      tag: `course-complete-${certNumber}`,
    }),

  aiInterviewCompleted: (candidateName: string, templateTitle: string, sessionId: string) =>
    sendPushToAdmins({
      type: 'ai_interview_completed',
      title: 'AI interview submitted',
      body: `${candidateName} finished ${templateTitle}`,
      url: `/admin/interviews/ai/${sessionId}`,
      tag: `ai-interview-${sessionId}`,
    }),

  inboundMail: (toUserId: string, fromName: string, subject: string) =>
    sendPushToUser(toUserId, {
      type: 'inbound_mail',
      title: `New mail from ${fromName}`,
      body: (subject || '(no subject)').slice(0, 160),
      url: '/admin/mail',
      tag: `inbound-${Date.now()}`,
    }),

  friendJoined: (toUserId: string, friendName: string) =>
    sendPushToUser(toUserId, {
      type: 'friend_joined',
      title: 'New friend',
      body: `${friendName} accepted your invite. You both earned 50 XP.`,
      url: '/aquintutor/friends',
      tag: `friend-${friendName}`,
    }),

  certificateIssued: (toUserId: string, courseTitle: string, certNumber: string) =>
    sendPushToUser(toUserId, {
      type: 'certificate_issued',
      title: 'Certificate awarded',
      body: `${courseTitle} — certificate ${certNumber}`,
      url: '/verify/' + certNumber,
      tag: `cert-${certNumber}`,
    }),
};
