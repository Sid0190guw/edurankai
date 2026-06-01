// src/lib/push.ts
// Server-side push notification sender.
// Used by API routes to send notifications to subscribed admin users.

import webpush from 'web-push';
import { db } from '@/lib/db';
import { pushSubscriptions, notificationPreferences, users } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';

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
}

// ── Canonical notification catalogue ────────────────────────────────────────
// Single source of truth. Add a row here and it appears in the settings UI and
// is respected by sendPushToAdmins automatically (no migration needed - the
// per-user opt-out lives in notification_preferences.prefs jsonb).
export const NOTIFICATION_TYPES: { type: string; label: string; desc: string; group: string }[] = [
  // Recruitment
  { type: 'new_application',    label: 'New applications',          desc: 'When someone submits an application',          group: 'Recruitment' },
  { type: 'applicant_message',  label: 'Applicant messages',        desc: 'When an applicant replies on their application', group: 'Recruitment' },
  { type: 'application_status', label: 'Application status changes', desc: 'When an application moves to a new stage',      group: 'Recruitment' },
  { type: 'offer_extended',     label: 'Offer extended',            desc: 'When an offer is extended to a candidate',     group: 'Recruitment' },
  { type: 'offer_signed',       label: 'Offer accepted',            desc: 'When a candidate signs their offer letter',    group: 'Recruitment' },
  { type: 'offer_declined',     label: 'Offer declined',            desc: 'When a candidate declines their offer',        group: 'Recruitment' },
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
  { type: 'test_submitted',     label: 'Test submissions',          desc: 'When a candidate submits a proctored test',    group: 'Academic' },
  { type: 'lms_enrolment',      label: 'AquinTutor enrolments',     desc: 'When a learner enrols in a course',            group: 'Academic' },
  // Institutional
  { type: 'new_hei_submission', label: 'HEI submissions',           desc: 'When an institution submits scores',           group: 'Institutional' },
  { type: 'hei_truth_report',   label: 'HEI truth reports',         desc: 'When an HEI truth report is generated',        group: 'Institutional' },
];

// In-app notifications feed. Self-bootstrap so /admin/notifications populates
// even if no migration ran.
let notificationsReady: Promise<void> | null = null;
function ensureNotificationsTable(): Promise<void> {
  if (notificationsReady) return notificationsReady;
  notificationsReady = (async () => {
    try {
      const { sql } = await import('drizzle-orm');
      await db.execute(sql`CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, body TEXT,
        type TEXT NOT NULL DEFAULT 'info', action_url TEXT,
        entity_type TEXT, entity_id TEXT,
        is_read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id, is_read) WHERE is_read = false`);
    } catch (_) {}
  })();
  return notificationsReady;
}

async function persistNotification(userId: string, p: PushPayload) {
  try {
    const { sql } = await import('drizzle-orm');
    await ensureNotificationsTable();
    await db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type, action_url)
      VALUES (${userId}, ${p.title}, ${p.body}, ${p.type}, ${p.url})
    `);
  } catch (e) { /* silent — never block delivery */ }
}

// Send a push notification to all admin users who have opted in for this type.
// ALSO writes a row to the in-app notifications feed for each eligible admin
// so the bell + /admin/notifications populate even if browser push fails.
export async function sendPushToAdmins(payload: PushPayload, excludeUserId?: string): Promise<void> {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[push] VAPID keys not configured. Skipping push.');
    return;
  }

  try {
    // Get all admin users (not applicants)
    const adminUsers = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.isActive, true));

    const adminIds = adminUsers
      .map(u => u.id)
      .filter(id => id !== excludeUserId);

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
    await Promise.all(eligibleIds.map((id) => persistNotification(id, payload)));

    // Get push subscriptions for eligible users
    const subs = await db.select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, eligibleIds));

    if (subs.length === 0) return;

    const pushData = JSON.stringify(payload);

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
  await persistNotification(userId, payload);
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  try {
    const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    if (subs.length === 0) return;
    const pushData = JSON.stringify(payload);
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
      title: '🎉 Offer Accepted',
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
};
