// src/lib/notify.ts
// Creates in-app notification records for admin users

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { roleCanReceive } from '@/lib/notify-audience';

interface NotifyOptions {
  title: string;
  body?: string;
  type?: 'application' | 'hire' | 'leave' | 'message' | 'offer' | 'payroll' | 'system' | 'info';
  actionUrl?: string;
  entityType?: string;
  entityId?: string;
  // Optional audience key (a push.ts notification type). When given, only the
  // roles responsible for that event type receive it. Falls back to mapping the
  // coarse `type` below.
  audience?: string;
}

// Map the coarse in-app `type` to an audience key when no explicit one is given.
const TYPE_TO_AUDIENCE: Record<string, string> = {
  application: 'new_application',
  hire: 'new_application',
  leave: 'leave_request',
  message: 'help_message',
  offer: 'offer_signed',
  payroll: 'payroll_run',
};

// Insert one in-app notification, skipping an identical one from the last 2
// minutes (kills retry/double-fire duplicates without dropping distinct msgs).
async function insertOnce(userId: string, opts: NotifyOptions) {
  await db.execute(sql`
    INSERT INTO notifications (user_id, title, body, type, action_url, entity_type, entity_id)
    SELECT ${userId}, ${opts.title}, ${opts.body || null}, ${opts.type || 'info'},
           ${opts.actionUrl || null}, ${opts.entityType || null}, ${opts.entityId || null}
    WHERE NOT EXISTS (
      SELECT 1 FROM notifications
      WHERE user_id = ${userId}
        AND title = ${opts.title}
        AND COALESCE(body, '') = COALESCE(${opts.body || null}, '')
        AND COALESCE(entity_id, '') = COALESCE(${opts.entityId || null}, '')
        AND created_at > NOW() - INTERVAL '2 minutes'
    )
  `);
}

// Send notification to the admin users RESPONSIBLE for this event (role-scoped).
export async function notifyAllAdmins(opts: NotifyOptions) {
  try {
    const audienceKey = opts.audience || TYPE_TO_AUDIENCE[opts.type || ''] || '';
    const admins = await db.execute(sql`
      SELECT id, role FROM users WHERE role != 'applicant' AND is_active = true
    `);
    const rows = Array.isArray(admins) ? admins : (admins?.rows || []);
    for (const admin of rows as any[]) {
      if (audienceKey && !roleCanReceive(admin.role, audienceKey)) continue;
      await insertOnce(admin.id, opts);
    }
  } catch(e: any) {
    console.error('[notify] Failed:', e.cause?.message || e.message);
  }
}

// Send notification to a specific user
export async function notifyUser(userId: string, opts: NotifyOptions) {
  try {
    await insertOnce(userId, opts);
  } catch(e: any) {
    console.error('[notify] Failed:', e.cause?.message || e.message);
  }
}

// Shorthand helpers
export const notify = {
  newApplication: (name: string, role: string, appId: string) =>
    notifyAllAdmins({
      title: `New application: ${name}`,
      body: `Applied for ${role}`,
      type: 'application',
      actionUrl: `/admin/applications/${appId}`,
      entityType: 'application',
      entityId: appId,
    }),

  statusChange: (name: string, newStatus: string, appId: string) =>
    notifyAllAdmins({
      title: `${name} → ${newStatus}`,
      body: `Application status updated`,
      type: 'application',
      actionUrl: `/admin/applications/${appId}`,
      entityType: 'application',
      entityId: appId,
    }),

  hired: (name: string, appId: string) =>
    notifyAllAdmins({
      title: `${name} hired!`,
      body: `Employee record created automatically`,
      type: 'hire',
      actionUrl: `/admin/hr/employees`,
      entityType: 'application',
      entityId: appId,
    }),

  leaveRequest: (empName: string, leaveType: string, days: number) =>
    notifyAllAdmins({
      title: `Leave request: ${empName}`,
      body: `${days} day(s) ${leaveType}`,
      type: 'leave',
      actionUrl: `/admin/hr/leave`,
      entityType: 'leave',
    }),

  offerSigned: (name: string, role: string, offerId: string) =>
    notifyAllAdmins({
      title: `Offer signed: ${name}`,
      body: `Accepted offer for ${role}`,
      type: 'offer',
      actionUrl: `/admin/offers`,
      entityType: 'offer',
      entityId: offerId,
    }),
};
