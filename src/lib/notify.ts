// src/lib/notify.ts
// Creates in-app notification records for admin users

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

interface NotifyOptions {
  title: string;
  body?: string;
  type?: 'application' | 'hire' | 'leave' | 'message' | 'offer' | 'payroll' | 'system' | 'info';
  actionUrl?: string;
  entityType?: string;
  entityId?: string;
}

// Send notification to all admin users (non-applicants)
export async function notifyAllAdmins(opts: NotifyOptions) {
  try {
    const admins = await db.execute(sql`
      SELECT id FROM users WHERE role != 'applicant' AND is_active = true
    `);
    const rows = Array.isArray(admins) ? admins : (admins?.rows || []);
    for (const admin of rows as any[]) {
      await db.execute(sql`
        INSERT INTO notifications (user_id, title, body, type, action_url, entity_type, entity_id)
        VALUES (${admin.id}, ${opts.title}, ${opts.body || null}, ${opts.type || 'info'},
                ${opts.actionUrl || null}, ${opts.entityType || null}, ${opts.entityId || null})
      `);
    }
  } catch(e: any) {
    console.error('[notify] Failed:', e.message);
  }
}

// Send notification to a specific user
export async function notifyUser(userId: string, opts: NotifyOptions) {
  try {
    await db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type, action_url, entity_type, entity_id)
      VALUES (${userId}, ${opts.title}, ${opts.body || null}, ${opts.type || 'info'},
              ${opts.actionUrl || null}, ${opts.entityType || null}, ${opts.entityId || null})
    `);
  } catch(e: any) {
    console.error('[notify] Failed:', e.message);
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
