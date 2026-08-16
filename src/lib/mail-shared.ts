// src/lib/mail-shared.ts — A MAILBOX SEVERAL PEOPLE WORK OUT OF.
//
// WHAT A SHARED MAILBOX IS HERE, AND WHY IT IS AN OVERLAY RATHER THAN A NEW MAILBOX.
//
// support@edurankai.in already has to be a real, deliverable address for anything to arrive at it:
// src/lib/mail.ts resolves an incoming envelope address against `users.mailbox_address`, and the
// IMAP puller and the inbound webhook both go through that. So the shared mailbox IS an ordinary
// account, and this module is the layer that lets AUTHORISED COLLEAGUES work its queue — it adds
// membership, assignment, status and internal notes ON TOP of the mail_box rows that account
// already owns.
//
// The alternative — a second kind of mailbox with its own storage — would have needed its own
// inbound path, its own threading and its own search, which is how this product ended up with two
// mailboxes once already (/portal/mail, now a read-only archive). One mail system.
//
// INTERNAL NOTES NEVER LEAVE THE BUILDING, AND THE DESIGN IS WHAT GUARANTEES IT, NOT A CHECKBOX.
// A note is a row in `mail_shared_notes`. It is not a message, it has no recipients, it is not in
// mail_messages, and NOTHING on the send path can reach it: /api/mail/send and
// src/lib/mail-transport.ts do not import this module and have no join to this table. That is
// asserted by a test (src/lib/mail-shared.test.ts) which reads those two files, because "we
// remembered not to" is not a guarantee that survives the next person editing the composer.
//
// EVERY READ IS MEMBERSHIP-CHECKED, AND IT FAILS CLOSED. requireSharedAccess() is called at the top
// of every function that touches shared data. A database error there refuses the read; it never
// falls through to "probably fine".
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';

// Declared before anything that uses them — `const` is not hoisted.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) ? r : (r?.rows || [])) as T[];

/** A note is internal. This constant exists so the rule has a name that greps. */
export const NOTES_ARE_INTERNAL = true;

export type SharedRole = 'owner' | 'agent' | 'viewer';
export type SharedStatus = 'unassigned' | 'open' | 'pending' | 'resolved';
export const SHARED_STATUSES: SharedStatus[] = ['unassigned', 'open', 'pending', 'resolved'];

/** The five queues the shared inbox presents. `all` is the sixth, and it is not a queue, it is the
 *  absence of one. */
export type SharedQueue = 'unassigned' | 'mine' | 'others' | 'pending' | 'resolved' | 'all';
export const SHARED_QUEUES: { key: SharedQueue; label: string; hint: string }[] = [
  { key: 'unassigned', label: 'Unassigned', hint: 'Nobody has picked these up yet.' },
  { key: 'mine', label: 'Assigned to me', hint: 'Yours to answer.' },
  { key: 'others', label: 'Assigned to others', hint: 'Somebody else is on these.' },
  { key: 'pending', label: 'Pending', hint: 'Answered, waiting on somebody outside.' },
  { key: 'resolved', label: 'Resolved', hint: 'Closed, with a reason recorded.' },
  { key: 'all', label: 'Everything', hint: 'The whole mailbox, whatever its state.' },
];

export interface SharedMailbox {
  id: string;
  address: string;
  name: string;
  /** The account whose mail_box rows this mailbox is. */
  ownerUserId: string;
  isActive: boolean;
  createdAt: string;
}

export interface SharedThreadState {
  mailboxId: string;
  threadId: string;
  status: SharedStatus;
  assigneeUserId: string | null;
  assigneeName: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  noteCount: number;
  updatedAt: string;
}

export interface SharedNote {
  id: string;
  threadId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

// =================================================================================================
// SCHEMA
// =================================================================================================

let sharedSchemaReady: Promise<void> | null = null;

export function ensureSharedSchema(): Promise<void> {
  if (!sharedSchemaReady) sharedSchemaReady = bootstrapSharedSchema();
  return sharedSchemaReady;
}

async function bootstrapSharedSchema(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_shared_mailboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(160) NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_shared_members (
    mailbox_id UUID NOT NULL REFERENCES mail_shared_mailboxes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(12) NOT NULL DEFAULT 'agent',
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mailbox_id, user_id))`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_shared_members_user_idx ON mail_shared_members(user_id)`);

  // One row per conversation this mailbox is working. Created lazily on first assignment or status
  // change: a conversation nobody has touched is 'unassigned' by ABSENCE, which means the queue
  // needs no backfill and an arriving message is in the Unassigned queue the moment it lands.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_shared_threads (
    mailbox_id UUID NOT NULL REFERENCES mail_shared_mailboxes(id) ON DELETE CASCADE,
    thread_id UUID NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'unassigned',
    assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    resolution TEXT,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (mailbox_id, thread_id))`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_shared_threads_queue_idx ON mail_shared_threads(mailbox_id, status, updated_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_shared_threads_assignee_idx ON mail_shared_threads(mailbox_id, assignee_user_id)`);

  // INTERNAL. No recipients column, no message_id, no join to mail_messages — the shape itself is
  // what keeps these out of an outgoing message.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_shared_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id UUID NOT NULL REFERENCES mail_shared_mailboxes(id) ON DELETE CASCADE,
    thread_id UUID NOT NULL,
    author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_shared_notes_thread_idx ON mail_shared_notes(mailbox_id, thread_id, created_at ASC)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_shared_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id UUID NOT NULL REFERENCES mail_shared_mailboxes(id) ON DELETE CASCADE,
    thread_id UUID NOT NULL,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    kind VARCHAR(24) NOT NULL,
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_shared_events_thread_idx ON mail_shared_events(mailbox_id, thread_id, created_at DESC)`);
}

// =================================================================================================
// ACCESS
// =================================================================================================

export interface SharedAccess {
  allowed: boolean;
  role: SharedRole | null;
  mailbox: SharedMailbox | null;
  /** A sentence to render. Null when allowed. */
  denial: string | null;
}

/**
 * MAY THIS PERSON WORK THIS MAILBOX?
 *
 * Membership only. Holding a company mailbox of your own does not admit you to support@ — that is
 * the entire point of a shared mailbox having members. The owner account is admitted implicitly,
 * because it IS the mailbox.
 *
 * FAILS CLOSED: a lookup that throws refuses, and says the check did not run rather than implying
 * the person is not a member.
 */
export async function requireSharedAccess(userId: string, mailboxId: string): Promise<SharedAccess> {
  const no = (msg: string): SharedAccess => ({ allowed: false, role: null, mailbox: null, denial: msg });
  if (!userId || !UUID_RE.test(String(mailboxId || ''))) return no('That shared mailbox was not found.');
  try {
    await ensureSharedSchema();
    const r = await db.execute(sql`
      SELECT b.id, b.address, b.name, b.owner_user_id, b.is_active, b.created_at,
             m.role AS member_role
      FROM mail_shared_mailboxes b
      LEFT JOIN mail_shared_members m ON m.mailbox_id = b.id AND m.user_id = ${userId}::uuid
      WHERE b.id = ${mailboxId}::uuid
      LIMIT 1`);
    const row = rowsOf(r)[0];
    if (!row) return no('That shared mailbox was not found.');
    if (!row.is_active) return no('That shared mailbox has been switched off.');

    const isOwner = String(row.owner_user_id) === String(userId);
    const role: SharedRole | null = isOwner ? 'owner' : (row.member_role as SharedRole) || null;
    if (!role) return no('You are not a member of that shared mailbox. Ask one of its owners to add you.');

    return {
      allowed: true,
      role,
      mailbox: {
        id: String(row.id), address: String(row.address), name: String(row.name),
        ownerUserId: String(row.owner_user_id), isActive: !!row.is_active,
        createdAt: new Date(row.created_at).toISOString(),
      },
      denial: null,
    };
  } catch (e: any) {
    console.error('[mail-shared] access check failed:', reasonOf(e));
    logEvent('error', 'mail.shared.access-check-failed', { userId, mailboxId, message: reasonOf(e) });
    return no('We could not check your access to that mailbox just now. Nothing has been changed.');
  }
}

/** Writing needs owner or agent. A viewer reads the queue and cannot change anybody's work. */
export function canWriteShared(role: SharedRole | null): boolean {
  return role === 'owner' || role === 'agent';
}

/** Every shared mailbox this person may open. The rail is built from this. */
export async function listMySharedMailboxes(userId: string): Promise<(SharedMailbox & { role: SharedRole; unassigned: number; mine: number })[]> {
  if (!userId) return [];
  try {
    await ensureSharedSchema();
    const r = await db.execute(sql`
      SELECT b.id, b.address, b.name, b.owner_user_id, b.is_active, b.created_at,
             CASE WHEN b.owner_user_id = ${userId}::uuid THEN 'owner' ELSE m.role END AS role
      FROM mail_shared_mailboxes b
      LEFT JOIN mail_shared_members m ON m.mailbox_id = b.id AND m.user_id = ${userId}::uuid
      WHERE b.is_active = true AND (b.owner_user_id = ${userId}::uuid OR m.user_id IS NOT NULL)
      ORDER BY b.name ASC`);
    const boxes = rowsOf(r);
    const out: any[] = [];
    for (const b of boxes) {
      const counts = await queueCounts(String(b.id), String(b.owner_user_id), userId).catch(() => ({ unassigned: 0, mine: 0 } as any));
      out.push({
        id: String(b.id), address: String(b.address), name: String(b.name),
        ownerUserId: String(b.owner_user_id), isActive: !!b.is_active,
        createdAt: new Date(b.created_at).toISOString(),
        role: (b.role as SharedRole) || 'viewer',
        unassigned: counts.unassigned || 0,
        mine: counts.mine || 0,
      });
    }
    return out;
  } catch (e: any) {
    console.error('[mail-shared] mailbox list failed:', reasonOf(e));
    return [];
  }
}

// =================================================================================================
// QUEUES
// =================================================================================================

/**
 * The WHERE fragment for one queue.
 *
 * `unassigned` is the subtle one: a conversation with NO state row at all is unassigned, so the
 * predicate has to be "no row, or a row that says unassigned". Writing it as `status = 'unassigned'`
 * would have made the Unassigned queue permanently empty — every arriving message would land
 * nowhere and the mailbox would look like it was working while nobody was being shown anything.
 */
function queuePredicate(queue: SharedQueue, userId: string): any {
  switch (queue) {
    case 'unassigned':
      return sql`(st.thread_id IS NULL OR (st.status = 'unassigned' AND st.assignee_user_id IS NULL))`;
    case 'mine':
      return sql`(st.assignee_user_id = ${userId}::uuid AND st.status <> 'resolved')`;
    case 'others':
      return sql`(st.assignee_user_id IS NOT NULL AND st.assignee_user_id <> ${userId}::uuid AND st.status <> 'resolved')`;
    case 'pending':
      return sql`st.status = 'pending'`;
    case 'resolved':
      return sql`st.status = 'resolved'`;
    case 'all':
    default:
      return sql`true`;
  }
}

export interface SharedThreadRow {
  threadId: string;
  messageId: string;
  subject: string;
  snippet: string;
  fromName: string;
  fromEmail: string;
  createdAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  messageCount: number;
  status: SharedStatus;
  assigneeUserId: string | null;
  assigneeName: string | null;
  noteCount: number;
  resolution: string | null;
}

/**
 * One queue, one page.
 *
 * Reads the OWNER ACCOUNT's mail_box rows — that is what the shared mailbox's mail is — joined to
 * the overlay state. Ordered by the latest message in each conversation, newest first, and paged by
 * offset because a queue is a work list a person walks, not a hundred-thousand-row archive.
 */
export async function listSharedQueue(p: {
  userId: string;
  mailboxId: string;
  queue: SharedQueue;
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<{ rows: SharedThreadRow[]; total: number; error?: string }> {
  const access = await requireSharedAccess(p.userId, p.mailboxId);
  if (!access.allowed || !access.mailbox) return { rows: [], total: 0, error: access.denial || 'No access.' };

  const owner = access.mailbox.ownerUserId;
  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
  const offset = Math.max(Number(p.offset) || 0, 0);
  const term = String(p.search || '').trim().toLowerCase();
  const searchFrag = term
    ? sql` AND (lower(coalesce(m.subject,'')) LIKE ${'%' + term + '%'} OR lower(coalesce(m.from_email,'')) LIKE ${'%' + term + '%'} OR lower(coalesce(m.snippet,'')) LIKE ${'%' + term + '%'})`
    : sql``;

  try {
    // latest message per conversation in this mailbox, then the overlay, then the queue predicate.
    const r = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (b.thread_id)
               b.thread_id, b.message_id, b.is_read, b.created_at AS box_created,
               m.subject, m.snippet, m.from_name, m.from_email, m.has_attachments, m.created_at
        FROM mail_box b
        JOIN mail_messages m ON m.id = b.message_id
        WHERE b.user_id = ${owner}::uuid AND b.folder NOT IN ('trash','spam','drafts')${searchFrag}
        ORDER BY b.thread_id, b.created_at DESC
      ),
      counted AS (
        SELECT thread_id, COUNT(*)::int AS n FROM mail_box WHERE user_id = ${owner}::uuid GROUP BY thread_id
      )
      SELECT l.*, c.n AS message_count,
             COALESCE(st.status, 'unassigned') AS status,
             st.assignee_user_id, st.resolution,
             u.name AS assignee_name,
             (SELECT COUNT(*)::int FROM mail_shared_notes n WHERE n.mailbox_id = ${p.mailboxId}::uuid AND n.thread_id = l.thread_id) AS note_count,
             COUNT(*) OVER ()::int AS total_rows
      FROM latest l
      LEFT JOIN counted c ON c.thread_id = l.thread_id
      LEFT JOIN mail_shared_threads st ON st.mailbox_id = ${p.mailboxId}::uuid AND st.thread_id = l.thread_id
      LEFT JOIN users u ON u.id = st.assignee_user_id
      WHERE ${queuePredicate(p.queue, p.userId)}
      ORDER BY l.box_created DESC
      LIMIT ${limit} OFFSET ${offset}`);

    const list = rowsOf(r);
    return {
      total: Number(list[0]?.total_rows || 0),
      rows: list.map((x) => ({
        threadId: String(x.thread_id),
        messageId: String(x.message_id),
        subject: x.subject || '(no subject)',
        snippet: x.snippet || '',
        fromName: x.from_name || '',
        fromEmail: x.from_email || '',
        createdAt: new Date(x.created_at || x.box_created).toISOString(),
        isRead: !!x.is_read,
        hasAttachments: !!x.has_attachments,
        messageCount: Number(x.message_count) || 1,
        status: (x.status as SharedStatus) || 'unassigned',
        assigneeUserId: x.assignee_user_id ? String(x.assignee_user_id) : null,
        assigneeName: x.assignee_name ? String(x.assignee_name) : null,
        noteCount: Number(x.note_count) || 0,
        resolution: x.resolution || null,
      })),
    };
  } catch (e: any) {
    console.error('[mail-shared] queue read failed:', reasonOf(e));
    return { rows: [], total: 0, error: 'That queue could not be read: ' + reasonOf(e) };
  }
}

/** The badge numbers on the rail. One statement, not one per queue. */
export async function queueCounts(mailboxId: string, ownerUserId: string, userId: string): Promise<Record<SharedQueue, number>> {
  const empty: Record<SharedQueue, number> = { unassigned: 0, mine: 0, others: 0, pending: 0, resolved: 0, all: 0 };
  try {
    await ensureSharedSchema();
    const r = await db.execute(sql`
      WITH threads AS (
        SELECT DISTINCT b.thread_id FROM mail_box b
        WHERE b.user_id = ${ownerUserId}::uuid AND b.folder NOT IN ('trash','spam','drafts')
      )
      SELECT
        COUNT(*) FILTER (WHERE st.thread_id IS NULL OR (st.status = 'unassigned' AND st.assignee_user_id IS NULL))::int AS unassigned,
        COUNT(*) FILTER (WHERE st.assignee_user_id = ${userId}::uuid AND st.status <> 'resolved')::int AS mine,
        COUNT(*) FILTER (WHERE st.assignee_user_id IS NOT NULL AND st.assignee_user_id <> ${userId}::uuid AND st.status <> 'resolved')::int AS others,
        COUNT(*) FILTER (WHERE st.status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE st.status = 'resolved')::int AS resolved,
        COUNT(*)::int AS all
      FROM threads t
      LEFT JOIN mail_shared_threads st ON st.mailbox_id = ${mailboxId}::uuid AND st.thread_id = t.thread_id`);
    const row = rowsOf(r)[0];
    if (!row) return empty;
    return {
      unassigned: Number(row.unassigned) || 0,
      mine: Number(row.mine) || 0,
      others: Number(row.others) || 0,
      pending: Number(row.pending) || 0,
      resolved: Number(row.resolved) || 0,
      all: Number(row.all) || 0,
    };
  } catch (e: any) {
    console.error('[mail-shared] queue counts failed:', reasonOf(e));
    return empty;
  }
}

// =================================================================================================
// ASSIGNMENT AND STATUS
// =================================================================================================

/**
 * Take, hand over, or release a conversation.
 *
 * Assigning to somebody moves the conversation to `open` unless it is already pending or resolved —
 * picking work up is not the same as reopening it, and silently un-resolving a closed conversation
 * because somebody clicked a name is a change nobody asked for.
 *
 * `assigneeUserId: null` releases it back to Unassigned.
 */
export async function assignThread(p: {
  userId: string; mailboxId: string; threadId: string; assigneeUserId: string | null;
}): Promise<{ ok: boolean; message: string; state?: SharedThreadState }> {
  const access = await requireSharedAccess(p.userId, p.mailboxId);
  if (!access.allowed) return { ok: false, message: access.denial || 'No access.' };
  if (!canWriteShared(access.role)) return { ok: false, message: 'You can read this mailbox but not change who is working it.' };
  if (!UUID_RE.test(String(p.threadId || ''))) return { ok: false, message: 'That is not a conversation.' };
  if (p.assigneeUserId && !UUID_RE.test(p.assigneeUserId)) return { ok: false, message: 'That is not a person.' };

  try {
    // An assignee must be a member. Assigning work to somebody who cannot open the mailbox is a
    // conversation that disappears from every queue and reaches nobody.
    if (p.assigneeUserId) {
      const member = await requireSharedAccess(p.assigneeUserId, p.mailboxId);
      if (!member.allowed) return { ok: false, message: 'That person is not a member of this mailbox, so the conversation would reach nobody.' };
    }
    const nextStatus = p.assigneeUserId ? sql`CASE WHEN mail_shared_threads.status IN ('pending','resolved') THEN mail_shared_threads.status ELSE 'open' END` : sql`'unassigned'`;
    await db.execute(sql`
      INSERT INTO mail_shared_threads (mailbox_id, thread_id, status, assignee_user_id, updated_at, updated_by)
      VALUES (${p.mailboxId}::uuid, ${p.threadId}::uuid, ${p.assigneeUserId ? 'open' : 'unassigned'}, ${p.assigneeUserId}, NOW(), ${p.userId}::uuid)
      ON CONFLICT (mailbox_id, thread_id) DO UPDATE
        SET assignee_user_id = EXCLUDED.assignee_user_id,
            status = ${nextStatus},
            updated_at = NOW(), updated_by = EXCLUDED.updated_by`);
    await recordEvent(p.mailboxId, p.threadId, p.userId, p.assigneeUserId ? 'assigned' : 'released', p.assigneeUserId || null);
    const state = await getThreadState(p.mailboxId, p.threadId);
    return {
      ok: true,
      message: p.assigneeUserId
        ? (p.assigneeUserId === p.userId ? 'Assigned to you.' : 'Assigned to ' + (state?.assigneeName || 'that person') + '.')
        : 'Released back to Unassigned.',
      state: state || undefined,
    };
  } catch (e: any) {
    console.error('[mail-shared] assign failed:', reasonOf(e));
    return { ok: false, message: 'That did not go through, and the conversation is unchanged.' };
  }
}

/** Move a conversation between open / pending / resolved. A resolution is REQUIRED to resolve. */
export async function setThreadStatus(p: {
  userId: string; mailboxId: string; threadId: string; status: SharedStatus; resolution?: string;
}): Promise<{ ok: boolean; message: string; state?: SharedThreadState }> {
  const access = await requireSharedAccess(p.userId, p.mailboxId);
  if (!access.allowed) return { ok: false, message: access.denial || 'No access.' };
  if (!canWriteShared(access.role)) return { ok: false, message: 'You can read this mailbox but not change the state of its work.' };
  if (!SHARED_STATUSES.includes(p.status)) return { ok: false, message: 'That is not a state.' };
  if (!UUID_RE.test(String(p.threadId || ''))) return { ok: false, message: 'That is not a conversation.' };

  const resolution = String(p.resolution || '').trim().slice(0, 2000);
  if (p.status === 'resolved' && !resolution) {
    // A closed conversation with no reason is a conversation nobody can audit later.
    return { ok: false, message: 'Say what the resolution was before closing it — a closed conversation with no reason cannot be reviewed later.' };
  }

  try {
    await db.execute(sql`
      INSERT INTO mail_shared_threads (mailbox_id, thread_id, status, resolution, resolved_at, resolved_by, updated_at, updated_by)
      VALUES (${p.mailboxId}::uuid, ${p.threadId}::uuid, ${p.status},
              ${p.status === 'resolved' ? resolution : null},
              ${p.status === 'resolved' ? sql`NOW()` : sql`NULL`},
              ${p.status === 'resolved' ? sql`${p.userId}::uuid` : sql`NULL`},
              NOW(), ${p.userId}::uuid)
      ON CONFLICT (mailbox_id, thread_id) DO UPDATE
        SET status = EXCLUDED.status,
            resolution = CASE WHEN EXCLUDED.status = 'resolved' THEN EXCLUDED.resolution ELSE mail_shared_threads.resolution END,
            resolved_at = CASE WHEN EXCLUDED.status = 'resolved' THEN NOW() ELSE NULL END,
            resolved_by = CASE WHEN EXCLUDED.status = 'resolved' THEN EXCLUDED.updated_by ELSE NULL END,
            updated_at = NOW(), updated_by = EXCLUDED.updated_by`);
    await recordEvent(p.mailboxId, p.threadId, p.userId, 'status', p.status + (resolution ? ' — ' + resolution : ''));
    const state = await getThreadState(p.mailboxId, p.threadId);
    const said: Record<SharedStatus, string> = {
      unassigned: 'Back to Unassigned.',
      open: 'Marked open.',
      pending: 'Marked pending — waiting on somebody outside.',
      resolved: 'Resolved, with the reason recorded.',
    };
    return { ok: true, message: said[p.status], state: state || undefined };
  } catch (e: any) {
    console.error('[mail-shared] status change failed:', reasonOf(e));
    return { ok: false, message: 'That did not go through, and the conversation is unchanged.' };
  }
}

export async function getThreadState(mailboxId: string, threadId: string): Promise<SharedThreadState | null> {
  try {
    const r = await db.execute(sql`
      SELECT st.*, u.name AS assignee_name,
             (SELECT COUNT(*)::int FROM mail_shared_notes n WHERE n.mailbox_id = st.mailbox_id AND n.thread_id = st.thread_id) AS note_count
      FROM mail_shared_threads st
      LEFT JOIN users u ON u.id = st.assignee_user_id
      WHERE st.mailbox_id = ${mailboxId}::uuid AND st.thread_id = ${threadId}::uuid LIMIT 1`);
    const x = rowsOf(r)[0];
    if (!x) return null;
    return {
      mailboxId: String(x.mailbox_id),
      threadId: String(x.thread_id),
      status: (x.status as SharedStatus) || 'unassigned',
      assigneeUserId: x.assignee_user_id ? String(x.assignee_user_id) : null,
      assigneeName: x.assignee_name ? String(x.assignee_name) : null,
      resolution: x.resolution || null,
      resolvedAt: x.resolved_at ? new Date(x.resolved_at).toISOString() : null,
      resolvedByUserId: x.resolved_by ? String(x.resolved_by) : null,
      noteCount: Number(x.note_count) || 0,
      updatedAt: new Date(x.updated_at).toISOString(),
    };
  } catch (e: any) {
    console.error('[mail-shared] state read failed:', reasonOf(e));
    return null;
  }
}

// =================================================================================================
// INTERNAL NOTES
// =================================================================================================

/**
 * Add a note. INTERNAL, PERMANENTLY.
 *
 * There is no `send` on this function and no path from this row to a recipient. The one way a note
 * could ever reach outside is if somebody COPIED it into a reply, which is a thing a person did,
 * not a thing the system did — and the composer marks the notes panel accordingly.
 */
export async function addNote(p: { userId: string; mailboxId: string; threadId: string; body: string }): Promise<{ ok: boolean; message: string; note?: SharedNote }> {
  const access = await requireSharedAccess(p.userId, p.mailboxId);
  if (!access.allowed) return { ok: false, message: access.denial || 'No access.' };
  if (!canWriteShared(access.role)) return { ok: false, message: 'You can read this mailbox but not add notes to it.' };
  if (!UUID_RE.test(String(p.threadId || ''))) return { ok: false, message: 'That is not a conversation.' };
  const body = String(p.body || '').trim().slice(0, 8000);
  if (!body) return { ok: false, message: 'The note was empty, so nothing was saved.' };

  try {
    const r = await db.execute(sql`
      INSERT INTO mail_shared_notes (mailbox_id, thread_id, author_user_id, body)
      VALUES (${p.mailboxId}::uuid, ${p.threadId}::uuid, ${p.userId}::uuid, ${body})
      RETURNING id, created_at`);
    const row = rowsOf(r)[0];
    await recordEvent(p.mailboxId, p.threadId, p.userId, 'note', body.slice(0, 200));
    return {
      ok: true,
      message: 'Note added. It stays inside this mailbox and is never sent to anyone outside.',
      note: {
        id: String(row.id), threadId: p.threadId, authorUserId: p.userId, authorName: '',
        body, createdAt: new Date(row.created_at).toISOString(),
      },
    };
  } catch (e: any) {
    console.error('[mail-shared] note failed:', reasonOf(e));
    return { ok: false, message: 'That note was NOT saved: ' + reasonOf(e) };
  }
}

export async function listNotes(userId: string, mailboxId: string, threadId: string): Promise<{ notes: SharedNote[]; error?: string }> {
  const access = await requireSharedAccess(userId, mailboxId);
  if (!access.allowed) return { notes: [], error: access.denial || 'No access.' };
  if (!UUID_RE.test(String(threadId || ''))) return { notes: [] };
  try {
    const r = await db.execute(sql`
      SELECT n.id, n.thread_id, n.author_user_id, n.body, n.created_at, u.name AS author_name
      FROM mail_shared_notes n
      LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.mailbox_id = ${mailboxId}::uuid AND n.thread_id = ${threadId}::uuid
      ORDER BY n.created_at ASC`);
    return {
      notes: rowsOf(r).map((x) => ({
        id: String(x.id), threadId: String(x.thread_id),
        authorUserId: x.author_user_id ? String(x.author_user_id) : '',
        authorName: String(x.author_name || 'Someone'),
        body: String(x.body || ''),
        createdAt: new Date(x.created_at).toISOString(),
      })),
    };
  } catch (e: any) {
    console.error('[mail-shared] notes read failed:', reasonOf(e));
    return { notes: [], error: 'Those notes could not be read: ' + reasonOf(e) };
  }
}

/** The activity strip under a conversation: who took it, who closed it, who wrote a note. */
export async function threadActivity(userId: string, mailboxId: string, threadId: string, limit = 40): Promise<{ kind: string; detail: string; actor: string; at: string }[]> {
  const access = await requireSharedAccess(userId, mailboxId);
  if (!access.allowed || !UUID_RE.test(String(threadId || ''))) return [];
  try {
    const r = await db.execute(sql`
      SELECT e.kind, e.detail, e.created_at, u.name AS actor
      FROM mail_shared_events e
      LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.mailbox_id = ${mailboxId}::uuid AND e.thread_id = ${threadId}::uuid
      ORDER BY e.created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`);
    return rowsOf(r).map((x) => ({
      kind: String(x.kind), detail: String(x.detail || ''),
      actor: String(x.actor || 'Someone'), at: new Date(x.created_at).toISOString(),
    }));
  } catch (e: any) {
    console.error('[mail-shared] activity read failed:', reasonOf(e));
    return [];
  }
}

async function recordEvent(mailboxId: string, threadId: string, actorUserId: string, kind: string, detail: string | null): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO mail_shared_events (mailbox_id, thread_id, actor_user_id, kind, detail)
      VALUES (${mailboxId}::uuid, ${threadId}::uuid, ${actorUserId}::uuid, ${kind}, ${detail})`);
  } catch (e: any) {
    // The work already happened. Losing its audit line is worth a log entry, not a rollback.
    console.error('[mail-shared] activity NOT recorded:', reasonOf(e));
  }
}

// =================================================================================================
// ADMINISTRATION
// =================================================================================================

/**
 * Create a shared mailbox over an EXISTING account.
 *
 * The address must already be a real mailbox address on a real account, because that is what makes
 * mail arrive at it. Creating a "shared mailbox" for an address nothing delivers to would be a
 * queue that never fills — the kind of feature that looks finished and is not.
 */
export async function createSharedMailbox(p: { actorUserId: string; address: string; name: string }): Promise<{ ok: boolean; message: string; mailboxId?: string }> {
  const address = String(p.address || '').trim().toLowerCase();
  const name = String(p.name || '').trim().slice(0, 160);
  if (!address || !address.includes('@')) return { ok: false, message: 'That is not an address.' };
  if (!name) return { ok: false, message: 'Give the mailbox a name people will recognise.' };
  try {
    await ensureSharedSchema();
    const owner = rowsOf(await db.execute(sql`
      SELECT id FROM users WHERE lower(mailbox_address) = ${address} LIMIT 1`))[0];
    if (!owner) {
      return {
        ok: false,
        message: 'No account holds ' + address + ', so nothing would ever be delivered to it. Create the account and its mailbox address first.',
      };
    }
    const r = await db.execute(sql`
      INSERT INTO mail_shared_mailboxes (address, name, owner_user_id, created_by)
      VALUES (${address}, ${name}, ${String(owner.id)}::uuid, ${p.actorUserId}::uuid)
      ON CONFLICT (address) DO UPDATE SET name = EXCLUDED.name, is_active = true
      RETURNING id`);
    const id = String(rowsOf(r)[0].id);
    logEvent('info', 'mail.shared.created', { actorUserId: p.actorUserId, address, mailboxId: id });
    return { ok: true, message: name + ' is now a shared mailbox. Add its members next.', mailboxId: id };
  } catch (e: any) {
    console.error('[mail-shared] create failed:', reasonOf(e));
    return { ok: false, message: 'That mailbox was NOT created: ' + reasonOf(e) };
  }
}

export async function setMember(p: {
  actorUserId: string; mailboxId: string; userId: string; role: SharedRole | 'remove';
}): Promise<{ ok: boolean; message: string }> {
  const access = await requireSharedAccess(p.actorUserId, p.mailboxId);
  if (!access.allowed) return { ok: false, message: access.denial || 'No access.' };
  if (access.role !== 'owner') return { ok: false, message: 'Only an owner of this mailbox can change who is in it.' };
  if (!UUID_RE.test(String(p.userId || ''))) return { ok: false, message: 'That is not a person.' };
  try {
    if (p.role === 'remove') {
      await db.execute(sql`DELETE FROM mail_shared_members WHERE mailbox_id = ${p.mailboxId}::uuid AND user_id = ${p.userId}::uuid`);
      // Work already assigned to them would otherwise sit in a queue nobody can see.
      await db.execute(sql`
        UPDATE mail_shared_threads SET assignee_user_id = NULL, status = 'unassigned', updated_at = NOW(), updated_by = ${p.actorUserId}::uuid
        WHERE mailbox_id = ${p.mailboxId}::uuid AND assignee_user_id = ${p.userId}::uuid AND status <> 'resolved'`);
      return { ok: true, message: 'Removed. Anything that was assigned to them is back in Unassigned.' };
    }
    if (!['owner', 'agent', 'viewer'].includes(p.role)) return { ok: false, message: 'That is not a role.' };
    await db.execute(sql`
      INSERT INTO mail_shared_members (mailbox_id, user_id, role, added_by)
      VALUES (${p.mailboxId}::uuid, ${p.userId}::uuid, ${p.role}, ${p.actorUserId}::uuid)
      ON CONFLICT (mailbox_id, user_id) DO UPDATE SET role = EXCLUDED.role`);
    return { ok: true, message: 'Saved.' };
  } catch (e: any) {
    console.error('[mail-shared] membership failed:', reasonOf(e));
    return { ok: false, message: 'That did not go through: ' + reasonOf(e) };
  }
}

export async function listMembers(userId: string, mailboxId: string): Promise<{ userId: string; name: string; email: string; role: SharedRole }[]> {
  const access = await requireSharedAccess(userId, mailboxId);
  if (!access.allowed) return [];
  try {
    const r = await db.execute(sql`
      SELECT m.user_id, m.role, u.name, u.email
      FROM mail_shared_members m JOIN users u ON u.id = m.user_id
      WHERE m.mailbox_id = ${mailboxId}::uuid
      ORDER BY u.name ASC`);
    return rowsOf(r).map((x) => ({
      userId: String(x.user_id), name: String(x.name || ''), email: String(x.email || ''),
      role: (x.role as SharedRole) || 'agent',
    }));
  } catch (e: any) {
    console.error('[mail-shared] member list failed:', reasonOf(e));
    return [];
  }
}
