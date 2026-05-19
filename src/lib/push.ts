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

export type NotificationType =
  | 'chat_message'
  | 'new_application'
  | 'application_status'
  | 'new_hei_submission'
  | 'new_user'
  | 'offer_signed';

export interface PushPayload {
  type: NotificationType;
  title: string;
  body: string;
  url: string;
  tag?: string;
}

// Map notification type to the preference column name
const PREF_MAP: Record<NotificationType, keyof typeof notificationPreferences.$inferSelect> = {
  chat_message: 'notifyChat',
  new_application: 'notifyNewApplication',
  application_status: 'notifyApplicationStatus',
  new_hei_submission: 'notifyNewHeiSubmission',
  new_user: 'notifyNewUser',
  offer_signed: 'notifyOfferSigned',
};

// Send a push notification to all admin users who have opted in for this type
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
    const prefKey = PREF_MAP[payload.type];

    // Filter to users who want this notification type
    const eligibleIds = adminIds.filter(id => {
      const pref = prefMap.get(id);
      if (!pref) return true; // No prefs set = default ON
      return pref[prefKey] !== false;
    });

    if (eligibleIds.length === 0) return;

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
};
