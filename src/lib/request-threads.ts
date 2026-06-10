// Request thread library — generic admin↔applicant message thread used by
// long-running tickets (Vis-vambhara access, fee waiver, etc.). One table,
// indexed by (request_type, request_id).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS request_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_type VARCHAR(40) NOT NULL,
      request_id UUID NOT NULL,
      applicant_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      sender_role VARCHAR(12) NOT NULL,
      sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      sender_name VARCHAR(200),
      body TEXT NOT NULL,
      attachment_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  } catch (_) {}
  // Bookkeeping columns the thread relies on — self-heal so the request list
  // never errors (and silently hides) on a DB missing them.
  for (const q of [
    sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ`,
    sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS unread_applicant INT NOT NULL DEFAULT 0`,
    sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS unread_admin INT NOT NULL DEFAULT 0`,
  ]) { try { await db.execute(q); } catch (_) {} }
}

export type RequestType = 'visvambhara_access' | 'fee_waiver';

export interface RequestMessage {
  id: string;
  request_type: string;
  request_id: string;
  applicant_user_id: string | null;
  sender_role: 'applicant' | 'admin';
  sender_user_id: string | null;
  sender_name: string | null;
  body: string;
  attachment_url: string | null;
  created_at: string;
}

export async function getThread(requestType: RequestType, requestId: string): Promise<RequestMessage[]> {
  await ensureSchema();
  return rows(await db.execute(sql`
    SELECT id, request_type, request_id, applicant_user_id, sender_role, sender_user_id, sender_name, body, attachment_url, created_at
    FROM request_messages
    WHERE request_type = ${requestType} AND request_id = ${requestId}
    ORDER BY created_at ASC
  `)) as RequestMessage[];
}

export async function postMessage(opts: {
  requestType: RequestType;
  requestId: string;
  applicantUserId: string | null;
  senderRole: 'applicant' | 'admin';
  senderUserId: string;
  senderName: string;
  body: string;
  attachmentUrl?: string | null;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  await ensureSchema();
  const txt = (opts.body || '').toString().trim();
  if (!txt) return { ok: false, error: 'empty body' };
  if (txt.length > 5000) return { ok: false, error: 'too long (max 5000)' };

  try {
    const ins = rows(await db.execute(sql`
      INSERT INTO request_messages (request_type, request_id, applicant_user_id, sender_role, sender_user_id, sender_name, body, attachment_url)
      VALUES (${opts.requestType}, ${opts.requestId}, ${opts.applicantUserId}, ${opts.senderRole}, ${opts.senderUserId}, ${opts.senderName.slice(0, 200)}, ${txt}, ${opts.attachmentUrl || null})
      RETURNING id
    `));
    const id = ins[0]?.id;

    // Bump bookkeeping on the source request row + bell the OTHER side
    if (opts.requestType === 'visvambhara_access') {
      try {
        if (opts.senderRole === 'admin') {
          await db.execute(sql`UPDATE visvambhara_access_requests SET last_message_at = NOW(), last_message_by = 'admin', unread_applicant = unread_applicant + 1, unread_admin = 0 WHERE id = ${opts.requestId}`);
          if (opts.applicantUserId) {
            const { sendPushToUser } = await import('@/lib/push');
            await sendPushToUser(opts.applicantUserId, {
              type: 'visvambhara_reply',
              title: 'Visvambhara: reply from research team',
              body: txt.slice(0, 160),
              url: '/portal/requests/visvambhara/' + opts.requestId,
              tag: 'visv-' + opts.requestId,
            });
          }
        } else {
          await db.execute(sql`UPDATE visvambhara_access_requests SET last_message_at = NOW(), last_message_by = 'applicant', unread_admin = unread_admin + 1, unread_applicant = 0 WHERE id = ${opts.requestId}`);
          const { sendPushToAdmins } = await import('@/lib/push');
          await sendPushToAdmins({
            type: 'visvambhara_applicant_reply',
            title: 'Visvambhara: applicant replied',
            body: (opts.senderName || 'Applicant') + ': ' + txt.slice(0, 140),
            url: '/admin/visvambhara-access?req=' + opts.requestId,
            tag: 'visv-admin-' + opts.requestId,
          });
        }
      } catch (_) {}
    } else if (opts.requestType === 'fee_waiver') {
      try {
        if (opts.senderRole === 'admin') {
          await db.execute(sql`UPDATE application_fee_waivers SET last_message_at = NOW(), unread_applicant = unread_applicant + 1, unread_admin = 0 WHERE id = ${opts.requestId}`).catch(() => {});
          if (opts.applicantUserId) {
            const { sendPushToUser } = await import('@/lib/push');
            await sendPushToUser(opts.applicantUserId, {
              type: 'fee_waiver_reply',
              title: 'Fee waiver: reply from admissions',
              body: txt.slice(0, 160),
              url: '/portal/requests/fee-waiver/' + opts.requestId,
              tag: 'fw-' + opts.requestId,
            });
          }
        } else {
          await db.execute(sql`UPDATE application_fee_waivers SET last_message_at = NOW(), unread_admin = unread_admin + 1, unread_applicant = 0 WHERE id = ${opts.requestId}`).catch(() => {});
          const { sendPushToAdmins } = await import('@/lib/push');
          await sendPushToAdmins({
            type: 'fee_waiver_applicant_reply',
            title: 'Fee waiver: applicant replied',
            body: (opts.senderName || 'Applicant') + ': ' + txt.slice(0, 140),
            url: '/admin/threads?req=' + opts.requestId,
            tag: 'fw-admin-' + opts.requestId,
          });
        }
      } catch (_) {}
    }
    return { ok: true, id };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'db error' };
  }
}

export async function markApplicantRead(requestType: RequestType, requestId: string) {
  if (requestType === 'visvambhara_access') {
    await db.execute(sql`UPDATE visvambhara_access_requests SET unread_applicant = 0 WHERE id = ${requestId}`).catch(() => {});
  } else if (requestType === 'fee_waiver') {
    await db.execute(sql`UPDATE application_fee_waivers SET unread_applicant = 0 WHERE id = ${requestId}`).catch(() => {});
  }
}

export async function listApplicantRequests(userId: string) {
  await ensureSchema();
  const visv = rows(await db.execute(sql`
    SELECT id, 'visvambhara_access' AS kind, status, note AS subject,
      last_message_at, COALESCE(unread_applicant, 0) AS unread, created_at
    FROM visvambhara_access_requests
    WHERE user_id = ${userId}
    ORDER BY COALESCE(last_message_at, created_at) DESC
  `)).map((r: any) => ({
    ...r,
    title: 'Vis-vambhara access',
    href: '/portal/requests/visvambhara/' + r.id,
  }));
  let waivers: any[] = [];
  try {
    waivers = rows(await db.execute(sql`
      SELECT id, 'fee_waiver' AS kind, status, situation_note AS subject,
        COALESCE(last_message_at, created_at) AS last_message_at,
        COALESCE(unread_applicant, 0) AS unread, created_at
      FROM application_fee_waivers
      WHERE user_id = ${userId}
      ORDER BY COALESCE(last_message_at, created_at) DESC
    `)).map((r: any) => ({
      ...r,
      title: 'Fee waiver',
      href: '/portal/requests/fee-waiver/' + r.id,
    }));
  } catch (_) {}
  return [...visv, ...waivers].sort((a, b) => new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime());
}
