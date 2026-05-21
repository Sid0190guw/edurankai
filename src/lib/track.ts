// src/lib/track.ts
// Portal activity tracking

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export async function trackEvent(opts: {
  applicationId?: string;
  userId?: string;
  eventType: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}) {
  try {
    await db.execute(sql`
      INSERT INTO portal_activity (application_id, user_id, event_type, metadata, ip_address, user_agent)
      VALUES (
        ${opts.applicationId || null},
        ${opts.userId || null},
        ${opts.eventType},
        ${JSON.stringify(opts.metadata || {})},
        ${opts.ipAddress || null},
        ${opts.userAgent || null}
      )
    `);
  } catch(e: any) {
    console.error('[track]', e.message);
  }
}

export async function markThreadOpened(applicationId: string, userId: string, ip?: string) {
  await Promise.all([
    trackEvent({ applicationId, userId, eventType: 'thread_opened', ipAddress: ip }),
    db.execute(sql`
      UPDATE applications SET
        applicant_last_seen = NOW(),
        thread_last_opened = NOW(),
        thread_open_count = COALESCE(thread_open_count, 0) + 1
      WHERE id = ${applicationId}
    `),
    db.execute(sql`
      UPDATE application_messages SET
        read_by_applicant = true,
        read_at = NOW()
      WHERE application_id = ${applicationId}
        AND sender_role != 'applicant'
        AND (read_by_applicant = false OR read_by_applicant IS NULL)
    `)
  ]).catch(() => {});
}

export async function markOfferOpened(offerId: string, userId: string, ip?: string) {
  await Promise.all([
    trackEvent({ userId, eventType: 'offer_opened', metadata: { offer_id: offerId }, ipAddress: ip }),
    db.execute(sql`
      UPDATE offer_letters SET
        opened_at = COALESCE(opened_at, NOW()),
        open_count = COALESCE(open_count, 0) + 1,
        last_opened_ip = ${ip || null}
      WHERE id = ${offerId}
    `)
  ]).catch(() => {});
}
