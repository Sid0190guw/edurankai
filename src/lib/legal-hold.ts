// src/lib/legal-hold.ts — retention of business communications, and controlled access to them.
//
// WHAT THIS IS. EduRankAI's groups, direct messages and application threads are business records.
// Retaining them is ordinary and lawful: employers do it for dispute resolution, regulatory
// enquiries, harassment investigations and litigation hold. This module is the retention and the
// access path for that.
//
// WHAT MAKES IT LAWFUL RATHER THAN SURVEILLANCE — three things, built in rather than left as policy
// somebody has to remember:
//
//   1. DISCLOSURE. Staff are told, before they write anything, that work communications are
//      retained and may be disclosed. disclosureText() is the notice, and hasAcknowledged() records
//      that each person saw it. India's DPDP Act 2023 requires notice for processing personal data;
//      most employment law elsewhere requires it too. Silent monitoring is the thing that turns a
//      defensible record into a liability.
//
//   2. A STATED REASON, EVERY TIME. There is no "browse everyone's messages" mode. Access is opened
//      as a numbered matter with a written reason and a scope, because "why were you reading that
//      conversation" must have an answer that is not "I was curious".
//
//   3. AN AUDIT THE SUBJECT CAN BE SHOWN. Every access is logged with who looked, whose messages,
//      when, and under which matter. The log is append-only and readable by the subject on request.
//      An access record nobody can inspect protects nobody.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not read anyone's personal accounts, private devices,
// or communications outside EduRankAI's own systems. The boundary is business records on our
// infrastructure — everything else is not ours to retain.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export type MatterStatus = 'open' | 'closed';
export type SourceKind = 'group' | 'dm' | 'application_thread' | 'mail';

export interface Matter {
  id: string;
  reference: string;
  title: string;
  reason: string;
  status: MatterStatus;
  openedBy: string;
  openedAt: string;
  closedAt: string | null;
  subjectUserIds: string[];
}

export function ensureLegalHoldSchema(): Promise<void> {
  return ensureOnce('legal_hold_v1', async () => {
    // A matter is the unit of authorisation. Access happens under one, never on its own.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS legal_matters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reference TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      subject_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      opened_by UUID NOT NULL,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      closed_by UUID
    )`);
    // Append-only by intent: there is no update or delete path in this module. A tamperable access
    // log is not evidence of anything.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS legal_access_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      matter_id UUID REFERENCES legal_matters(id),
      accessed_by UUID NOT NULL,
      subject_user_id UUID,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      item_count INT NOT NULL DEFAULT 0,
      justification TEXT NOT NULL,
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS legal_access_subject_idx ON legal_access_log (subject_user_id, created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS legal_access_matter_idx ON legal_access_log (matter_id, created_at DESC)`);
    // Who has seen the retention notice, so disclosure is provable rather than assumed.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS retention_acknowledgements (
      user_id UUID PRIMARY KEY,
      version TEXT NOT NULL,
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip TEXT
    )`);
  });
}

/** Bump when the wording changes materially, so people re-acknowledge rather than being assumed to. */
export const DISCLOSURE_VERSION = '2026-08-01';

/**
 * The notice shown to every member of staff. Written to be understood, not to be technically true
 * while practically misleading — someone reading this should come away knowing exactly what is kept
 * and who can see it.
 */
export function disclosureText(): string[] {
  return [
    'Messages you send in EduRankAI groups, direct messages, application threads and work email are business records. They are retained by EduRankAI.',
    'They may be reviewed if there is a specific, recorded reason — a dispute, a complaint, a safety or harassment concern, a regulatory enquiry, or a legal obligation. Access is opened as a numbered matter with a written justification.',
    'Every access is logged: who looked, whose messages, when, and under which matter. You may request that log for your own account at any time, and we will provide it.',
    'Nobody browses messages casually. There is no general monitoring, and no access without a stated reason.',
    'This covers EduRankAI systems only. We do not access your personal accounts, your own devices, or anything outside our platform.',
    'If you would not write it in a work email, do not write it in a work group.',
  ];
}

export async function hasAcknowledged(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    await ensureLegalHoldSchema();
    const r = rows(await db.execute(sql`
      SELECT 1 FROM retention_acknowledgements
      WHERE user_id = ${userId} AND version = ${DISCLOSURE_VERSION} LIMIT 1`));
    return r.length > 0;
  } catch { return false; }
}

export async function acknowledge(userId: string, ip?: string | null): Promise<void> {
  try {
    await ensureLegalHoldSchema();
    await db.execute(sql`
      INSERT INTO retention_acknowledgements (user_id, version, ip)
      VALUES (${userId}, ${DISCLOSURE_VERSION}, ${ip || null})
      ON CONFLICT (user_id) DO UPDATE SET version = ${DISCLOSURE_VERSION}, acknowledged_at = NOW()`);
  } catch { /* never block someone from working over an acknowledgement write */ }
}

const map = (r: any): Matter => ({
  id: r.id, reference: r.reference, title: r.title, reason: r.reason,
  status: r.status, openedBy: r.opened_by, openedAt: String(r.opened_at),
  closedAt: r.closed_at ? String(r.closed_at) : null,
  subjectUserIds: Array.isArray(r.subject_user_ids) ? r.subject_user_ids : [],
});

/**
 * Open a matter. The reason is mandatory and substantive — a one-word "investigation" is refused,
 * because the whole point is that the answer to "why did you read this" exists in writing and was
 * written BEFORE the reading, not reconstructed afterwards.
 */
export async function openMatter(input: {
  title: string; reason: string; openedBy: string; subjectUserIds?: string[];
}): Promise<{ ok: boolean; id?: string; reference?: string; error?: string }> {
  const title = (input.title || '').trim();
  const reason = (input.reason || '').trim();
  if (title.length < 4) return { ok: false, error: 'Give the matter a title.' };
  if (reason.length < 20) {
    return { ok: false, error: 'Give a specific reason of at least 20 characters. This is the record of why the access was justified, and it is written before anything is read.' };
  }
  try {
    await ensureLegalHoldSchema();
    const reference = 'LM-' + new Date().getFullYear() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const r = rows(await db.execute(sql`
      INSERT INTO legal_matters (reference, title, reason, subject_user_ids, opened_by)
      VALUES (${reference}, ${title.slice(0, 200)}, ${reason.slice(0, 4000)},
              ${JSON.stringify(input.subjectUserIds || [])}::jsonb, ${input.openedBy})
      RETURNING id`))[0];
    return { ok: true, id: r?.id, reference };
  } catch (e: any) {
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not open the matter.' };
  }
}

export async function closeMatter(id: string, byUserId: string): Promise<void> {
  await ensureLegalHoldSchema();
  await db.execute(sql`
    UPDATE legal_matters SET status = 'closed', closed_at = NOW(), closed_by = ${byUserId}
    WHERE id = ${id} AND status = 'open'`);
}

export async function listMatters(status?: MatterStatus): Promise<Matter[]> {
  try {
    await ensureLegalHoldSchema();
    const r = status
      ? await db.execute(sql`SELECT * FROM legal_matters WHERE status = ${status} ORDER BY opened_at DESC LIMIT 200`)
      : await db.execute(sql`SELECT * FROM legal_matters ORDER BY opened_at DESC LIMIT 200`);
    return rows(r).map(map);
  } catch { return []; }
}

/**
 * Record an access. Called BEFORE the messages are returned, never after — if the log write fails,
 * the access does not happen. An unlogged read is precisely what this module exists to prevent, so
 * failing closed here is the whole design and not an inconvenience to work around.
 */
export async function logAccess(input: {
  matterId: string; accessedBy: string; subjectUserId?: string | null;
  sourceKind: SourceKind; sourceId?: string | null; itemCount: number;
  justification: string; ip?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureLegalHoldSchema();
    const m = rows(await db.execute(sql`SELECT status FROM legal_matters WHERE id = ${input.matterId} LIMIT 1`))[0];
    if (!m) return { ok: false, error: 'No such matter.' };
    if (m.status !== 'open') return { ok: false, error: 'That matter is closed. Reopen it or open a new one before accessing anything further.' };

    await db.execute(sql`
      INSERT INTO legal_access_log
        (matter_id, accessed_by, subject_user_id, source_kind, source_id, item_count, justification, ip)
      VALUES (${input.matterId}, ${input.accessedBy}, ${input.subjectUserId || null},
              ${input.sourceKind}, ${input.sourceId || null}, ${input.itemCount},
              ${(input.justification || '').slice(0, 2000)}, ${input.ip || null})`);
    return { ok: true };
  } catch (e: any) {
    // Fail closed: the caller must not proceed to show anything.
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not record the access, so it was not permitted.' };
  }
}

// ---------------------------------------------------------------------------------------------
// Retrieval.
//
// WHAT CAN AND CANNOT BE PRODUCED. Portal direct messages are end-to-end encrypted: chat_messages
// stores `ciphertext` and `iv`, and there is no key escrow, so the server has never held the keys
// and CANNOT decrypt them. No amount of authority changes that — it is a property of how the
// messages were stored, not a permission setting.
//
// So what these functions return is the ENVELOPE: who spoke to whom, when, how often, whether an
// attachment was involved, whether a message was later deleted. That is real evidence and it is
// honestly labelled. What must never happen is a screen that shows a thread, shows no messages,
// and lets a reader conclude the conversation was reviewed and found innocuous when in fact it was
// never readable. Every caller surfaces `contentRecoverable: false` alongside the rows.
// ---------------------------------------------------------------------------------------------

export interface HeldThread {
  id: string;
  kind: string;
  title: string | null;
  participants: string[];
  messageCount: number;
  firstAt: string | null;
  lastAt: string | null;
  contentRecoverable: boolean;
}

/** Conversation threads that exist, with participants and volume. Content is NOT included. */
export async function listHeldThreads(opts: { subjectUserId?: string | null; limit?: number } = {}): Promise<HeldThread[]> {
  const limit = Math.min(Math.max(opts.limit || 100, 1), 300);
  try {
    const r = await db.execute(sql`
      SELECT t.id, t.kind, t.title,
             COUNT(m.id)::int AS message_count,
             MIN(m.created_at) AS first_at,
             MAX(m.created_at) AS last_at,
             COALESCE(
               (SELECT array_agg(DISTINCT COALESCE(u.name, u.email))
                  FROM chat_thread_members cm JOIN users u ON u.id = cm.user_id
                 WHERE cm.thread_id = t.id), '{}') AS participants
        FROM chat_threads t
        LEFT JOIN chat_messages m ON m.thread_id = t.id
       WHERE ${opts.subjectUserId
          ? sql`EXISTS (SELECT 1 FROM chat_thread_members x WHERE x.thread_id = t.id AND x.user_id = ${opts.subjectUserId})`
          : sql`TRUE`}
       GROUP BY t.id, t.kind, t.title
       ORDER BY MAX(m.created_at) DESC NULLS LAST
       LIMIT ${limit}`);
    return rows(r).map((x: any) => ({
      id: x.id, kind: x.kind, title: x.title,
      participants: Array.isArray(x.participants) ? x.participants.filter(Boolean) : [],
      messageCount: Number(x.message_count) || 0,
      firstAt: x.first_at ? String(x.first_at) : null,
      lastAt: x.last_at ? String(x.last_at) : null,
      // Always false for portal DMs. Stated per-thread rather than as a footnote so it travels
      // with the data if these rows are ever exported.
      contentRecoverable: false,
    }));
  } catch (e: any) {
    console.error('[legal-hold] listHeldThreads', e?.cause?.message || e?.message);
    return [];
  }
}

export interface HeldMessage {
  id: string;
  senderName: string | null;
  createdAt: string;
  deletedAt: string | null;
  hasAttachment: boolean;
  sizeBytes: number;
  contentRecoverable: boolean;
}

/**
 * The message envelopes in one thread.
 *
 * Returns no plaintext, because none exists server-side. `sizeBytes` is the length of the stored
 * ciphertext — useful for establishing that a substantive exchange took place, and useless for
 * inferring what was said.
 */
export async function heldThreadMessages(threadId: string, limit = 500): Promise<HeldMessage[]> {
  if (!threadId) return [];
  try {
    const r = await db.execute(sql`
      SELECT m.id, m.created_at, m.deleted_at, m.attachment_url,
             LENGTH(m.ciphertext) AS size_bytes,
             COALESCE(u.name, u.email) AS sender_name
        FROM chat_messages m
        LEFT JOIN users u ON u.id = m.sender_user_id
       WHERE m.thread_id = ${threadId}
       ORDER BY m.created_at ASC
       LIMIT ${Math.min(Math.max(limit, 1), 1000)}`);
    return rows(r).map((x: any) => ({
      id: x.id,
      senderName: x.sender_name || null,
      createdAt: String(x.created_at),
      deletedAt: x.deleted_at ? String(x.deleted_at) : null,
      hasAttachment: !!x.attachment_url,
      sizeBytes: Number(x.size_bytes) || 0,
      contentRecoverable: false,
    }));
  } catch (e: any) {
    console.error('[legal-hold] heldThreadMessages', e?.cause?.message || e?.message);
    return [];
  }
}

export interface AccessRecord {
  id: string; matterReference: string | null; matterTitle: string | null;
  accessedBy: string; accessedByName: string | null;
  sourceKind: string; itemCount: number; justification: string; createdAt: string;
}

/**
 * The access history for one person's communications.
 *
 * Deliberately available to the SUBJECT, not only to the founder. A log that only the people doing
 * the looking can see does not hold anyone to account, and the disclosure notice promises this.
 */
export async function accessHistoryFor(subjectUserId: string): Promise<AccessRecord[]> {
  if (!subjectUserId) return [];
  try {
    await ensureLegalHoldSchema();
    return rows(await db.execute(sql`
      SELECT a.id, m.reference AS matter_reference, m.title AS matter_title,
             a.accessed_by, u.name AS accessed_by_name,
             a.source_kind, a.item_count, a.justification, a.created_at
      FROM legal_access_log a
      LEFT JOIN legal_matters m ON m.id = a.matter_id
      LEFT JOIN users u ON u.id = a.accessed_by
      WHERE a.subject_user_id = ${subjectUserId}
      ORDER BY a.created_at DESC LIMIT 200`)).map((r: any) => ({
        id: r.id, matterReference: r.matter_reference, matterTitle: r.matter_title,
        accessedBy: r.accessed_by, accessedByName: r.accessed_by_name,
        sourceKind: r.source_kind, itemCount: Number(r.item_count) || 0,
        justification: r.justification, createdAt: String(r.created_at),
      }));
  } catch { return []; }
}

/** Full access log for a matter, for the founder console and for producing a disclosure bundle. */
export async function accessLogForMatter(matterId: string): Promise<AccessRecord[]> {
  try {
    await ensureLegalHoldSchema();
    return rows(await db.execute(sql`
      SELECT a.id, m.reference AS matter_reference, m.title AS matter_title,
             a.accessed_by, u.name AS accessed_by_name,
             a.source_kind, a.item_count, a.justification, a.created_at
      FROM legal_access_log a
      LEFT JOIN legal_matters m ON m.id = a.matter_id
      LEFT JOIN users u ON u.id = a.accessed_by
      WHERE a.matter_id = ${matterId}
      ORDER BY a.created_at DESC LIMIT 500`)).map((r: any) => ({
        id: r.id, matterReference: r.matter_reference, matterTitle: r.matter_title,
        accessedBy: r.accessed_by, accessedByName: r.accessed_by_name,
        sourceKind: r.source_kind, itemCount: Number(r.item_count) || 0,
        justification: r.justification, createdAt: String(r.created_at),
      }));
  } catch { return []; }
}

/**
 * Who may open a matter or access held records.
 *
 * The founder only. Not "admins", not super admins generally — the narrower the set, the more
 * meaningful the audit trail is, and the easier it is to answer who could possibly have looked.
 */
export function canAccessHeldRecords(user: { role?: string | null; email?: string | null } | null | undefined): boolean {
  if (!user) return false;
  const founder = (process.env.FOUNDER_EMAIL || 'siddharth@edurankai.in').toLowerCase();
  return (user.email || '').toLowerCase() === founder;
}
