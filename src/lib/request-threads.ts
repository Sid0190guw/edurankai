// Request thread library — generic admin↔applicant message thread used by
// long-running tickets (Vis-vambhara access, fee waiver, etc.). One table,
// indexed by (request_type, request_id).
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
// ONCE PER PROCESS, AND NOT AT ALL IN PRODUCTION.
//
// This was the one bootstrap in the codebase with real reach and NO memo of any kind. Nine DDL
// round trips ran at the top of every exported function here -- postMessage(), the thread reader
// and the unread counter -- and this module is imported by ten pages and API routes, including
// src/pages/portal/index.astro, which is the landing page every applicant sees. A page that reads a
// thread and then posts to it paid eighteen round trips of no-op ALTER TABLE before doing any work.
//
// ensureOnce and NOT ensureBatch, deliberately. src/lib/ensure-once.ts sets out the rule: a batch is
// one transaction and rolls back whole, which is the wrong shape wherever a statement is ALLOWED to
// fail on its own. Every ALTER below is wrapped in its own try/catch precisely because
// visvambhara_access_requests is created nowhere in this repository and a missing TABLE is the
// expected outcome on a deployment that never shipped that feature. Batching them would let one
// missing table roll back the columns for the other.
import { ensureOnce } from '@/lib/ensure-once';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  return ensureOnce('request_threads_v1', async () => {
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
  } catch (e: any) {
    console.error('[request-threads] request_messages could not be created:', e?.cause?.message || e?.message);
  }
  // Bookkeeping columns the thread relies on — self-heal so the request list
  // never errors (and silently hides) on a DB missing them.
  //
  // THE VISVAMBHARA HALF WAS MISSING. Only the three fee-waiver columns were self-healed here, yet
  // postMessage() writes last_message_at, last_message_by, unread_applicant and unread_admin on
  // visvambhara_access_requests too — and that table is created nowhere in this repository, so
  // nothing declared them. Every one of those updates threw into a swallowing catch, which is why a
  // reply could land in a thread and no unread badge ever appeared for the other party: the message
  // was there, and nobody was told it was there. Additive; a live table already carrying them is
  // untouched.
  for (const q of [
    sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ`,
    sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS last_message_by VARCHAR(12)`,
    sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS unread_applicant INT NOT NULL DEFAULT 0`,
    sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS unread_admin INT NOT NULL DEFAULT 0`,
    sql`ALTER TABLE visvambhara_access_requests ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ`,
    sql`ALTER TABLE visvambhara_access_requests ADD COLUMN IF NOT EXISTS last_message_by VARCHAR(12)`,
    sql`ALTER TABLE visvambhara_access_requests ADD COLUMN IF NOT EXISTS unread_applicant INT NOT NULL DEFAULT 0`,
    sql`ALTER TABLE visvambhara_access_requests ADD COLUMN IF NOT EXISTS unread_admin INT NOT NULL DEFAULT 0`,
  ]) {
    try { await db.execute(q); } catch (e: any) {
      // A missing TABLE (rather than column) is the expected failure on a deployment that never
      // shipped that feature; either way the reason belongs on the log and not in a black hole.
      console.error('[request-threads] thread bookkeeping column could not be added:', e?.cause?.message || e?.message);
    }
  }
  });
}

// EXTENDED, NOT FORKED. `request_messages` is already keyed by (request_type, request_id) and is
// already the generic thread store; the employee helpdesk reuses it rather than creating a second
// messages table that would need its own reader, its own ordering and its own bugs.
//
// TWO NEW SENDER ROLES COME WITH IT. 'applicant' and 'admin' describe the candidate-facing threads;
// a workplace ticket is between an EMPLOYEE and the AGENT working the desk, and calling the agent
// 'admin' would misdescribe the record - the person answering an IT ticket is frequently not an
// administrator of anything. The column is VARCHAR(12), so both fit.
//
// NO BOOKKEEPING BRANCH IS ADDED BELOW for 'helpdesk_ticket'. Its unread counters, its SLA stamps
// (first response, resolved) and its notifications are owned by src/lib/helpdesk.ts, which knows
// what a first response MEANS on a ticket and which side to tell. Reaching back into a helpdesk
// table from here would put that knowledge in two places.
export type RequestType = 'visvambhara_access' | 'fee_waiver' | 'helpdesk_ticket';
export type ThreadSenderRole = 'applicant' | 'admin' | 'employee' | 'agent';

export interface RequestMessage {
  id: string;
  request_type: string;
  request_id: string;
  applicant_user_id: string | null;
  sender_role: ThreadSenderRole;
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
  senderRole: ThreadSenderRole;
  senderUserId: string;
  senderName: string;
  body: string;
  attachmentUrl?: string | null;
  /**
   * `warning` is set when the message WAS posted but the other side was not alerted — the unread
   * counter or the push failed. Callers that report "reply sent" should append it, because a reply
   * nobody is told about is a reply nobody reads.
   */
}): Promise<{ ok: boolean; id?: string; error?: string; warning?: string }> {
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
    let warning: string | undefined;

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
      } catch (e: any) {
        // The message IS stored, so this must not fail the post — but the other side has not been
        // told, and that is the whole point of a thread.
        console.error('[request-threads] visvambhara notify/bookkeeping failed for', opts.requestId, '-', e?.cause?.message || e?.message);
        warning = 'The message was saved, but the other party was not alerted to it.';
      }
    } else if (opts.requestType === 'fee_waiver') {
      try {
        if (opts.senderRole === 'admin') {
          await db.execute(sql`UPDATE application_fee_waivers SET last_message_at = NOW(), unread_applicant = unread_applicant + 1, unread_admin = 0 WHERE id = ${opts.requestId}`);
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
          await db.execute(sql`UPDATE application_fee_waivers SET last_message_at = NOW(), unread_admin = unread_admin + 1, unread_applicant = 0 WHERE id = ${opts.requestId}`);
          const { sendPushToAdmins } = await import('@/lib/push');
          await sendPushToAdmins({
            type: 'fee_waiver_applicant_reply',
            title: 'Fee waiver: applicant replied',
            body: (opts.senderName || 'Applicant') + ': ' + txt.slice(0, 140),
            url: '/admin/threads?req=' + opts.requestId,
            tag: 'fw-admin-' + opts.requestId,
          });
        }
      } catch (e: any) {
        console.error('[request-threads] fee-waiver notify/bookkeeping failed for', opts.requestId, '-', e?.cause?.message || e?.message);
        warning = 'The message was saved, but the other party was not alerted to it.';
      }
    }
    return { ok: true, id, warning };
  } catch (e: any) {
    const real = e?.cause?.message || e?.message;
    console.error('[request-threads] postMessage failed for', opts.requestType, opts.requestId, '-', real);
    return { ok: false, error: real || 'db error' };
  }
}

export async function markApplicantRead(requestType: RequestType, requestId: string) {
  const fail = (e: any) => console.error('[request-threads] could not clear the applicant unread counter for', requestType, requestId, '-', e?.cause?.message || e?.message);
  if (requestType === 'visvambhara_access') {
    await db.execute(sql`UPDATE visvambhara_access_requests SET unread_applicant = 0 WHERE id = ${requestId}`).catch(fail);
  } else if (requestType === 'fee_waiver') {
    await db.execute(sql`UPDATE application_fee_waivers SET unread_applicant = 0 WHERE id = ${requestId}`).catch(fail);
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
    title: 'Restricted research access',
    href: '/portal/requests/visvambhara/' + r.id,
  }));
  // A FAILED READ IS NOT AN ABSENCE OF REQUESTS. This ended in `catch (_) {}` over an empty array,
  // so a fee-waiver query that could not run — a missing bookkeeping column, a pooler timeout —
  // returned the applicant a list with their waiver thread simply gone from it, and
  // /portal/requests then drew "No requests yet. When you request access to gated content or apply
  // for a fee waiver, the thread shows up here." That is a statement about what the person has
  // done, made on the strength of a question that was never answered, on the one screen they open
  // to find out whether anybody has replied about the money.
  //
  // The failure is reported instead: the reason goes to the log, and `unreadable` travels back with
  // the rows so a caller can say so rather than inventing an empty state. The visvambhara read
  // above is deliberately left to throw — its caller already handles that, and swallowing it here
  // would recreate the same fault on the other half.
  let waivers: any[] = [];
  const unreadable: string[] = [];
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
  } catch (e: any) {
    console.error('[request-threads] fee-waiver requests could not be read for', userId, '-', e?.cause?.message || e?.message);
    unreadable.push('Fee waiver');
  }
  const out = [...visv, ...waivers].sort((a, b) => new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime()) as any[];
  // Carried as a non-enumerable property so every existing consumer — .length, .map, the spread in
  // /portal/index — behaves exactly as before, and a surface that wants to be honest can ask.
  Object.defineProperty(out, 'unreadable', { value: unreadable, enumerable: false });
  return out;
}

/** Which request kinds could not be read for this list, if any. Empty means every read answered. */
export function unreadableKinds(list: any): string[] {
  const u = (list as any)?.unreadable;
  return Array.isArray(u) ? u : [];
}
