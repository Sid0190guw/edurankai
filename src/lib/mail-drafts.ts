// src/lib/mail-drafts.ts — A DRAFT THAT SURVIVES THE THING THAT DESTROYS DRAFTS.
//
// WHAT THE EXISTING SAVE DOES, AND WHY IT HAD TO CHANGE. /api/mail/draft.ts saves by DELETING the
// old draft and INSERTING a new one — its own comment calls this "simplest". It is simplest and it
// has a window in it:
//
//     DELETE FROM mail_box     ...   <- the draft is now gone
//     DELETE FROM mail_messages ...  <- and so is its body, and its attachments, by cascade
//     INSERT ...                     <- if ANYTHING fails here, the draft never existed
//
// A dropped connection between those statements loses the message. So does a serverless invocation
// being frozen. And because the autosave runs while somebody is typing, the moment of highest risk
// is the moment they have written the most. That is the failure this module exists to remove: the
// draft is now UPDATED IN PLACE, so an interrupted save leaves the previous version intact.
//
// FOUR THINGS THE OLD PATH HAD NO ANSWER FOR:
//
//   1. TWO TABS. Both autosave the same draft; the second write silently overwrites the first, and
//      whichever tab you were not looking at wins. Every save now carries the VERSION it was based
//      on, the UPDATE matches on that version, and a save built on stale state is REFUSED and
//      returned as a conflict with the server's copy attached — never merged by guesswork.
//   2. RECOVERY. There was no record of anything but the latest state, so a bad paste over a long
//      message was unrecoverable. Revisions are kept (MAX_REVISIONS), and restoreRevision() puts
//      one back.
//   3. CHURN. A debounce fires on a timer, not on a change, so an idle composer wrote a new row
//      every few seconds. A save whose content is identical to the stored version is now a no-op
//      that returns the same version number — the client cannot tell the difference and the
//      database is not asked to do the work.
//   4. ATTACHMENTS. The delete cascaded them away and the insert re-created them; a save that
//      failed half way left a draft with no attachments and no sign that it ever had any. They live
//      on the draft row now.
//
// THE DRAFTS FOLDER STILL WORKS. mail_messages keeps a mirrored row so /admin/mail's Drafts folder,
// which reads mail_box, shows what it always showed. The draft record is the authority; the mirror
// is kept in step and is rebuilt if it goes missing.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// Declared before anything that uses them — `const` is not hoisted.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) ? r : (r?.rows || [])) as T[];

/** How many earlier versions of a draft are kept. Enough to undo a bad paste, not an archive. */
export const MAX_REVISIONS = 20;
/** The shortest gap between two saved REVISIONS. Autosave writes constantly; history should not. */
export const REVISION_INTERVAL_MS = 60_000;

export interface DraftAttachment {
  filename: string;
  url: string;
  mime?: string | null;
  size?: number | null;
}

export interface DraftState {
  draftId: string;
  version: number;
  threadId: string | null;
  inReplyTo: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments: DraftAttachment[];
  updatedAt: string;
  /** The tab that wrote this version. Shown in a conflict so the person knows where the other
   *  copy came from. */
  clientId: string | null;
}

export interface SaveDraftInput {
  /** Absent for a new draft. */
  draftId?: string | null;
  /** The version this edit was made against. Required when draftId is given. */
  baseVersion?: number | null;
  threadId?: string | null;
  inReplyTo?: string | null;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: DraftAttachment[];
  /** A per-tab identifier the composer mints. Never trusted for authorisation. */
  clientId?: string | null;
}

export type SaveDraftResult =
  | { ok: true; conflict: false; draft: DraftState; unchanged: boolean }
  | { ok: false; conflict: true; server: DraftState; message: string }
  | { ok: false; conflict: false; message: string };

// =================================================================================================
// SCHEMA
// =================================================================================================

let draftSchemaReady: Promise<void> | null = null;

export function ensureDraftSchema(): Promise<void> {
  if (!draftSchemaReady) draftSchemaReady = bootstrapDraftSchema();
  return draftSchemaReady;
}

async function bootstrapDraftSchema(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID,
    thread_id UUID,
    in_reply_to TEXT,
    to_addrs TEXT NOT NULL DEFAULT '',
    cc_addrs TEXT NOT NULL DEFAULT '',
    bcc_addrs TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    version INT NOT NULL DEFAULT 1,
    client_id TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_drafts_user_idx ON mail_drafts(user_id, updated_at DESC) WHERE sent_at IS NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_drafts_msg_idx ON mail_drafts(message_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_draft_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id UUID NOT NULL REFERENCES mail_drafts(id) ON DELETE CASCADE,
    version INT NOT NULL,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    to_addrs TEXT,
    cc_addrs TEXT,
    bcc_addrs TEXT,
    attachments JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_draft_rev_idx ON mail_draft_revisions(draft_id, version DESC)`);
}

// =================================================================================================
// READ
// =================================================================================================

function toState(x: any): DraftState {
  return {
    draftId: String(x.id),
    version: Number(x.version) || 1,
    threadId: x.thread_id ? String(x.thread_id) : null,
    inReplyTo: x.in_reply_to || null,
    to: String(x.to_addrs || ''),
    cc: String(x.cc_addrs || ''),
    bcc: String(x.bcc_addrs || ''),
    subject: String(x.subject || ''),
    bodyText: String(x.body_text || ''),
    bodyHtml: String(x.body_html || ''),
    attachments: Array.isArray(x.attachments) ? x.attachments : (() => {
      try { return JSON.parse(x.attachments || '[]'); } catch { return []; }
    })(),
    updatedAt: new Date(x.updated_at).toISOString(),
    clientId: x.client_id || null,
  };
}

export async function getDraft(userId: string, draftId: string): Promise<DraftState | null> {
  if (!UUID_RE.test(String(draftId || ''))) return null;
  try {
    await ensureDraftSchema();
    const r = await db.execute(sql`
      SELECT * FROM mail_drafts WHERE id = ${draftId}::uuid AND user_id = ${userId}::uuid AND sent_at IS NULL LIMIT 1`);
    const x = rowsOf(r)[0];
    return x ? toState(x) : null;
  } catch (e: any) {
    console.error('[mail-drafts] read failed:', reasonOf(e));
    return null;
  }
}

/**
 * Unsent drafts, newest first — the "you were writing this when the browser closed" list.
 *
 * This is the whole of crash recovery, and it works because the draft is on the SERVER after the
 * last autosave rather than in a tab that no longer exists. Nothing here depends on localStorage,
 * which does not survive a different machine, a cleared profile or a private window.
 */
export async function listRecoverableDrafts(userId: string, limit = 25): Promise<(DraftState & { isEmpty: boolean })[]> {
  try {
    await ensureDraftSchema();
    const r = await db.execute(sql`
      SELECT * FROM mail_drafts
      WHERE user_id = ${userId}::uuid AND sent_at IS NULL
      ORDER BY updated_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`);
    return rowsOf(r).map((x) => {
      const s = toState(x);
      return { ...s, isEmpty: !s.subject.trim() && !s.bodyText.trim() && !s.to.trim() && !s.attachments.length };
    });
  } catch (e: any) {
    console.error('[mail-drafts] recovery list failed:', reasonOf(e));
    return [];
  }
}

export async function listRevisions(userId: string, draftId: string): Promise<{ version: number; subject: string; preview: string; at: string }[]> {
  if (!UUID_RE.test(String(draftId || ''))) return [];
  try {
    await ensureDraftSchema();
    const r = await db.execute(sql`
      SELECT rv.version, rv.subject, rv.body_text, rv.created_at
      FROM mail_draft_revisions rv
      JOIN mail_drafts d ON d.id = rv.draft_id
      WHERE rv.draft_id = ${draftId}::uuid AND d.user_id = ${userId}::uuid
      ORDER BY rv.version DESC LIMIT ${MAX_REVISIONS}`);
    return rowsOf(r).map((x) => ({
      version: Number(x.version),
      subject: String(x.subject || '(no subject)'),
      preview: String(x.body_text || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      at: new Date(x.created_at).toISOString(),
    }));
  } catch (e: any) {
    console.error('[mail-drafts] revision list failed:', reasonOf(e));
    return [];
  }
}

// =================================================================================================
// WRITE
// =================================================================================================

/** True when two drafts hold the same content. Used to make an idle autosave free. */
export function draftsEqual(a: Partial<DraftState>, b: SaveDraftInput): boolean {
  const norm = (s: any) => String(s == null ? '' : s);
  return norm(a.to) === norm(b.to)
    && norm(a.cc) === norm(b.cc)
    && norm(a.bcc) === norm(b.bcc)
    && norm(a.subject) === norm(b.subject)
    && norm(a.bodyText) === norm(b.bodyText)
    && norm(a.bodyHtml) === norm(b.bodyHtml)
    && JSON.stringify(a.attachments || []) === JSON.stringify(b.attachments || []);
}

/**
 * SAVE.
 *
 * The version check is the whole design. `WHERE id = ... AND version = <baseVersion>` either
 * matches one row and bumps it, or matches NOTHING — and matching nothing means somebody else
 * saved in between. There is no third outcome and no window between reading the version and
 * writing it, because both happen in the same statement.
 *
 * A conflict is REPORTED WITH THE SERVER'S COPY, never merged. Two people's sentences interleaved
 * by a machine is not a recovered draft, it is a new and worse draft that neither of them wrote.
 */
export async function saveDraft(userId: string, input: SaveDraftInput): Promise<SaveDraftResult> {
  if (!userId) return { ok: false, conflict: false, message: 'Not signed in.' };
  const clean = {
    to: String(input.to || '').slice(0, 4000),
    cc: String(input.cc || '').slice(0, 4000),
    bcc: String(input.bcc || '').slice(0, 4000),
    subject: String(input.subject || '').slice(0, 500),
    bodyText: String(input.bodyText || '').slice(0, 500_000),
    bodyHtml: String(input.bodyHtml || '').slice(0, 1_000_000),
    attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 50) : [],
    threadId: input.threadId && UUID_RE.test(String(input.threadId)) ? String(input.threadId) : null,
    inReplyTo: input.inReplyTo ? String(input.inReplyTo).slice(0, 400) : null,
    clientId: input.clientId ? String(input.clientId).slice(0, 64) : null,
  };

  try {
    await ensureDraftSchema();

    // ---- New draft -----------------------------------------------------------------------------
    if (!input.draftId) {
      const r = await db.execute(sql`
        INSERT INTO mail_drafts (user_id, thread_id, in_reply_to, to_addrs, cc_addrs, bcc_addrs, subject, body_text, body_html, attachments, version, client_id)
        VALUES (${userId}::uuid, ${clean.threadId}, ${clean.inReplyTo}, ${clean.to}, ${clean.cc}, ${clean.bcc},
                ${clean.subject}, ${clean.bodyText}, ${clean.bodyHtml}, ${JSON.stringify(clean.attachments)}::jsonb, 1, ${clean.clientId})
        RETURNING *`);
      const state = toState(rowsOf(r)[0]);
      await mirrorToMailbox(userId, state).catch(() => {});
      return { ok: true, conflict: false, draft: state, unchanged: false };
    }

    if (!UUID_RE.test(String(input.draftId))) return { ok: false, conflict: false, message: 'That is not a draft.' };

    // ---- Existing draft ------------------------------------------------------------------------
    const current = await getDraft(userId, String(input.draftId));
    if (!current) {
      // The draft is gone — sent, discarded, or belonged to somebody else. Saying so is better than
      // silently creating a second one the person did not ask for and will not find.
      return { ok: false, conflict: false, message: 'That draft is no longer here. It may have been sent or discarded in another tab.' };
    }

    // An autosave that changes nothing does nothing, and reports the version it already had.
    if (draftsEqual(current, clean)) {
      return { ok: true, conflict: false, draft: current, unchanged: true };
    }

    const base = Number(input.baseVersion || 0);
    if (!base) return { ok: false, conflict: false, message: 'This save did not say which version it was based on, so it was refused rather than risk overwriting newer text.' };

    // The revision is written BEFORE the update, from the row that is about to be replaced, so a
    // failed update leaves a revision of a state that still exists rather than one that never did.
    await maybeWriteRevision(current).catch((e) => console.error('[mail-drafts] revision NOT kept:', reasonOf(e)));

    const upd = await db.execute(sql`
      UPDATE mail_drafts
         SET to_addrs = ${clean.to}, cc_addrs = ${clean.cc}, bcc_addrs = ${clean.bcc},
             subject = ${clean.subject}, body_text = ${clean.bodyText}, body_html = ${clean.bodyHtml},
             attachments = ${JSON.stringify(clean.attachments)}::jsonb,
             thread_id = COALESCE(${clean.threadId}, thread_id),
             in_reply_to = COALESCE(${clean.inReplyTo}, in_reply_to),
             version = version + 1, client_id = ${clean.clientId}, updated_at = NOW()
       WHERE id = ${String(input.draftId)}::uuid AND user_id = ${userId}::uuid
         AND sent_at IS NULL AND version = ${base}
      RETURNING *`);
    const row = rowsOf(upd)[0];

    if (!row) {
      // Nothing matched. The draft exists (we read it above), so the version moved: another tab.
      const server = await getDraft(userId, String(input.draftId));
      if (!server) return { ok: false, conflict: false, message: 'That draft is no longer here.' };
      return {
        ok: false,
        conflict: true,
        server,
        message: 'This draft was changed somewhere else while you were writing — probably another tab or another device. Nothing has been overwritten. Compare the two and keep the one you want.',
      };
    }

    const state = toState(row);
    await mirrorToMailbox(userId, state).catch(() => {});
    return { ok: true, conflict: false, draft: state, unchanged: false };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[mail-drafts] save failed:', reason);
    return { ok: false, conflict: false, message: 'This draft was NOT saved: ' + reason };
  }
}

/** Keep a revision, but not one per keystroke — at most one per REVISION_INTERVAL_MS. */
async function maybeWriteRevision(current: DraftState): Promise<void> {
  const last = rowsOf(await db.execute(sql`
    SELECT created_at FROM mail_draft_revisions WHERE draft_id = ${current.draftId}::uuid
    ORDER BY version DESC LIMIT 1`))[0];
  if (last && Date.now() - new Date(last.created_at).getTime() < REVISION_INTERVAL_MS) return;

  await db.execute(sql`
    INSERT INTO mail_draft_revisions (draft_id, version, subject, body_text, body_html, to_addrs, cc_addrs, bcc_addrs, attachments)
    VALUES (${current.draftId}::uuid, ${current.version}, ${current.subject}, ${current.bodyText}, ${current.bodyHtml},
            ${current.to}, ${current.cc}, ${current.bcc}, ${JSON.stringify(current.attachments)}::jsonb)`);
  // Trim, so a long-lived draft does not grow an unbounded history.
  await db.execute(sql`
    DELETE FROM mail_draft_revisions
    WHERE draft_id = ${current.draftId}::uuid
      AND version NOT IN (
        SELECT version FROM mail_draft_revisions WHERE draft_id = ${current.draftId}::uuid
        ORDER BY version DESC LIMIT ${MAX_REVISIONS})`);
}

/** Put an earlier version back. It becomes a NEW version rather than rewriting history. */
export async function restoreRevision(userId: string, draftId: string, version: number): Promise<SaveDraftResult> {
  if (!UUID_RE.test(String(draftId || ''))) return { ok: false, conflict: false, message: 'That is not a draft.' };
  try {
    await ensureDraftSchema();
    const current = await getDraft(userId, draftId);
    if (!current) return { ok: false, conflict: false, message: 'That draft is no longer here.' };
    const rev = rowsOf(await db.execute(sql`
      SELECT rv.* FROM mail_draft_revisions rv JOIN mail_drafts d ON d.id = rv.draft_id
      WHERE rv.draft_id = ${draftId}::uuid AND rv.version = ${Number(version)} AND d.user_id = ${userId}::uuid
      LIMIT 1`))[0];
    if (!rev) return { ok: false, conflict: false, message: 'That version is no longer kept.' };

    return await saveDraft(userId, {
      draftId,
      baseVersion: current.version,
      to: rev.to_addrs || '', cc: rev.cc_addrs || '', bcc: rev.bcc_addrs || '',
      subject: rev.subject || '', bodyText: rev.body_text || '', bodyHtml: rev.body_html || '',
      attachments: Array.isArray(rev.attachments) ? rev.attachments : [],
      clientId: current.clientId,
    });
  } catch (e: any) {
    console.error('[mail-drafts] restore failed:', reasonOf(e));
    return { ok: false, conflict: false, message: 'That version could not be restored: ' + reasonOf(e) };
  }
}

/**
 * Throw a draft away.
 *
 * Both statements name the owner. The old endpoint's second DELETE did not, and because
 * mail_box.message_id cascades from mail_messages, anybody who could reach the endpoint could
 * destroy another person's unsent draft by posting its id. That fix is kept here.
 */
export async function discardDraft(userId: string, draftId: string): Promise<{ ok: boolean; message: string }> {
  if (!UUID_RE.test(String(draftId || ''))) return { ok: false, message: 'That is not a draft.' };
  try {
    await ensureDraftSchema();
    const d = rowsOf(await db.execute(sql`
      SELECT message_id FROM mail_drafts WHERE id = ${draftId}::uuid AND user_id = ${userId}::uuid LIMIT 1`))[0];
    await db.execute(sql`DELETE FROM mail_drafts WHERE id = ${draftId}::uuid AND user_id = ${userId}::uuid`);
    if (d?.message_id) {
      await db.execute(sql`DELETE FROM mail_box WHERE user_id = ${userId}::uuid AND message_id = ${String(d.message_id)}::uuid AND folder = 'drafts'`);
      await db.execute(sql`DELETE FROM mail_messages WHERE id = ${String(d.message_id)}::uuid AND is_draft = true AND from_user_id = ${userId}::uuid`);
    }
    return { ok: true, message: 'Draft discarded.' };
  } catch (e: any) {
    console.error('[mail-drafts] discard failed:', reasonOf(e));
    return { ok: false, message: 'That draft was NOT discarded: ' + reasonOf(e) };
  }
}

/**
 * Called after the message has actually been sent.
 *
 * The draft is marked sent rather than deleted, so its revisions survive long enough to answer
 * "what did I actually send?" — and the mirrored Drafts row is removed, because the message now
 * lives in Sent and having it in both places is how people send the same thing twice.
 */
export async function markDraftSent(userId: string, draftId: string): Promise<void> {
  if (!UUID_RE.test(String(draftId || ''))) return;
  try {
    await ensureDraftSchema();
    const d = rowsOf(await db.execute(sql`
      UPDATE mail_drafts SET sent_at = NOW() WHERE id = ${draftId}::uuid AND user_id = ${userId}::uuid AND sent_at IS NULL
      RETURNING message_id`))[0];
    if (d?.message_id) {
      await db.execute(sql`DELETE FROM mail_box WHERE user_id = ${userId}::uuid AND message_id = ${String(d.message_id)}::uuid AND folder = 'drafts'`);
      await db.execute(sql`DELETE FROM mail_messages WHERE id = ${String(d.message_id)}::uuid AND is_draft = true AND from_user_id = ${userId}::uuid`);
    }
  } catch (e: any) {
    // The message went. Failing to tidy the draft must not report the send as failed.
    console.error('[mail-drafts] draft NOT marked sent (message was sent):', reasonOf(e));
  }
}

/**
 * Keep the Drafts FOLDER in step with the draft record.
 *
 * The folder reads mail_box/mail_messages, so a draft that existed only in mail_drafts would be
 * invisible in the mailbox it belongs to. This UPDATEs the mirror in place and INSERTs it only when
 * it is missing — never delete-then-insert, which is the pattern this whole module replaced.
 *
 * Best-effort by design: a failed mirror leaves the authoritative draft saved and logs why. The
 * caller is never told the draft was lost when it was not.
 */
async function mirrorToMailbox(userId: string, draft: DraftState): Promise<void> {
  const snippet = (draft.bodyText || draft.subject || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const existing = draft.draftId ? rowsOf(await db.execute(sql`
    SELECT message_id FROM mail_drafts WHERE id = ${draft.draftId}::uuid AND user_id = ${userId}::uuid LIMIT 1`))[0] : null;

  if (existing?.message_id) {
    const updated = rowsOf(await db.execute(sql`
      UPDATE mail_messages
         SET subject = ${draft.subject}, body_text = ${draft.bodyText}, body_html = ${draft.bodyHtml},
             snippet = ${snippet}, has_attachments = ${draft.attachments.length > 0}
       WHERE id = ${String(existing.message_id)}::uuid AND is_draft = true AND from_user_id = ${userId}::uuid
      RETURNING id`));
    if (updated.length) {
      await syncMirrorRecipients(String(existing.message_id), draft);
      return;
    }
    // The mirror was deleted underneath us. Fall through and build a new one.
  }

  const me = rowsOf(await db.execute(sql`
    SELECT COALESCE(mailbox_address, email) AS addr, name FROM users WHERE id = ${userId}::uuid LIMIT 1`))[0];
  const threadId = draft.threadId || null;
  const ins = rowsOf(await db.execute(sql`
    INSERT INTO mail_messages (thread_id, subject, from_user_id, from_email, from_name, body_html, body_text, snippet, direction, has_attachments, is_draft, in_reply_to)
    VALUES (COALESCE(${threadId}::uuid, gen_random_uuid()), ${draft.subject}, ${userId}::uuid,
            ${String(me?.addr || '')}, ${String(me?.name || '')}, ${draft.bodyHtml}, ${draft.bodyText}, ${snippet},
            'internal', ${draft.attachments.length > 0}, true, ${draft.inReplyTo})
    RETURNING id, thread_id`))[0];
  if (!ins) return;

  await db.execute(sql`
    INSERT INTO mail_box (user_id, message_id, thread_id, folder, is_read)
    VALUES (${userId}::uuid, ${String(ins.id)}::uuid, ${String(ins.thread_id)}::uuid, 'drafts', true)
    ON CONFLICT (user_id, message_id) DO UPDATE SET folder = 'drafts'`);
  await db.execute(sql`
    UPDATE mail_drafts SET message_id = ${String(ins.id)}::uuid, thread_id = COALESCE(thread_id, ${String(ins.thread_id)}::uuid)
    WHERE id = ${draft.draftId}::uuid AND user_id = ${userId}::uuid`);
  await syncMirrorRecipients(String(ins.id), draft);
}

/** Recipients and attachments on the mirror, replaced wholesale — they are a derived view. */
async function syncMirrorRecipients(messageId: string, draft: DraftState): Promise<void> {
  await db.execute(sql`DELETE FROM mail_recipients WHERE message_id = ${messageId}::uuid`);
  const kinds: [string, string][] = [['to', draft.to], ['cc', draft.cc], ['bcc', draft.bcc]];
  for (const [kind, raw] of kinds) {
    for (const addr of String(raw || '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'))) {
      await db.execute(sql`
        INSERT INTO mail_recipients (message_id, kind, email) VALUES (${messageId}::uuid, ${kind}, ${addr})`);
    }
  }
  await db.execute(sql`DELETE FROM mail_attachments WHERE message_id = ${messageId}::uuid`);
  for (const a of draft.attachments) {
    if (!a?.url) continue;
    await db.execute(sql`
      INSERT INTO mail_attachments (message_id, filename, url, mime, size_bytes)
      VALUES (${messageId}::uuid, ${String(a.filename || 'attachment').slice(0, 300)}, ${String(a.url)}, ${a.mime || null}, ${a.size || null})`);
  }
}
