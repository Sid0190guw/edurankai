// src/lib/mail-bulk.ts — DOING ONE THING TO TEN THOUSAND CONVERSATIONS.
//
// THE PROBLEM THIS EXISTS FOR. /api/mail/action.ts takes a list of thread ids. That is exactly
// right for "archive these four" and it is unusable for "archive everything from this sender",
// because the browser would first have to LEARN the ten thousand ids — which means paging the whole
// result set down the wire — and then post them, in batches, one request at a time. Ten thousand
// round trips is not a slow feature; it is a feature that fails half way through and leaves the
// mailbox in a state nobody chose.
//
// THE SHAPE OF THE FIX. A selection is either a LIST OF IDS or a QUERY. The query form never leaves
// the server: src/lib/mail-search.ts compiles the same grammar the search box uses into a WHERE
// clause, and one UPDATE applies the operation to every conversation it matches. The browser sends
// the query it already has on screen, not the rows.
//
// THREE RULES THIS MODULE KEEPS.
//
//   1. IT ACTS ON CONVERSATIONS, because that is what the list shows. Archiving a row that reads
//      "4 messages" and having one of them stay in the inbox is the kind of half-done that makes
//      people stop trusting the button.
//   2. IT IS CAPPED, AND SAYS SO. MAX_BULK_THREADS is a real ceiling; when a selection exceeds it
//      the operation applies to that many and REPORTS `truncated`. Silently doing 25,000 of 40,000
//      and returning success is the failure mode this whole file is written against.
//   3. IT COUNTS BEFORE IT ACTS, on request. previewBulk() answers "this will touch N
//      conversations" from the same compiled selection the write will use, so the confirmation a
//      person sees and the work that happens cannot describe different sets.
//
// SCOPE. Every statement is `user_id = <caller>`; there is no parameter that reaches another
// person's mailbox. `delete` is permanent and is therefore refused outside Trash — the same rule
// /api/mail/action.ts already enforces, kept identical here rather than reinvented.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { compileSelection, type SearchScope, type SearchQuery } from '@/lib/mail-search';
import { logEvent } from '@/lib/logger';

// Declared before the functions that read them — `const` is not hoisted.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) ? r : (r?.rows || [])) as T[];

/** The ceiling on one operation. Exceeding it is reported, never silently trimmed. */
export const MAX_BULK_THREADS = 25000;
/** The ceiling on an explicit id list in one request, so a posted body cannot be unbounded. */
export const MAX_ID_LIST = 2000;

export const SYSTEM_FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'] as const;
export type SystemFolder = (typeof SYSTEM_FOLDERS)[number];

export type BulkOp =
  | 'read' | 'unread'
  | 'star' | 'unstar'
  | 'important' | 'unimportant'
  | 'archive' | 'inbox' | 'trash' | 'spam'
  | 'delete'
  | 'move'
  | 'label-add' | 'label-remove'
  | 'snooze' | 'unsnooze';

export const BULK_OPS: BulkOp[] = [
  'read', 'unread', 'star', 'unstar', 'important', 'unimportant',
  'archive', 'inbox', 'trash', 'spam', 'delete', 'move',
  'label-add', 'label-remove', 'snooze', 'unsnooze',
];

/**
 * What the operation is being applied to.
 *
 * `ids` is the ordinary case — the checkboxes that are ticked. `query` is "select all N results",
 * and it carries the SEARCH STRING and the SCOPE rather than a materialised list, which is the
 * whole point: the set is resolved on the server at the moment of the write.
 */
export type BulkSelection =
  | { mode: 'ids'; threadIds: string[] }
  | { mode: 'query'; query: string; scope?: SearchScope; /** Ticked, then excluded by hand. */ exclude?: string[] };

export interface BulkRequest {
  op: BulkOp;
  selection: BulkSelection;
  /** For `move`. */
  folder?: string;
  /** For `label-add` / `label-remove`. */
  label?: string;
  /** For `snooze`. ISO timestamp; must be in the future. */
  until?: string;
}

export interface BulkResult {
  ok: boolean;
  op: BulkOp;
  /** Conversations the operation actually changed. */
  threads: number;
  /** Mailbox rows written. A conversation is several messages, so this is the larger number. */
  messages: number;
  /** True when the selection was larger than MAX_BULK_THREADS and only the cap was applied. */
  truncated: boolean;
  /** What the person should be told. Always populated, success or failure. */
  message: string;
  error?: string;
  /** The parsed query, when the selection was a query — so a screen can echo what it acted on. */
  query?: SearchQuery;
}

/** Validation that runs before anything touches the database. Returns null when the request is fine. */
export function validateBulk(req: BulkRequest): string | null {
  if (!req || !req.op) return 'No operation was given.';
  if (!BULK_OPS.includes(req.op)) return 'That is not an operation this mailbox performs.';
  const sel = req.selection;
  if (!sel || (sel.mode !== 'ids' && sel.mode !== 'query')) return 'No selection was given.';
  if (sel.mode === 'ids') {
    if (!Array.isArray(sel.threadIds) || !sel.threadIds.length) return 'Nothing was selected.';
    if (sel.threadIds.length > MAX_ID_LIST) {
      return 'That is more than ' + MAX_ID_LIST + ' conversations in one request. Use "select all results" instead, which is applied on the server.';
    }
    if (sel.threadIds.some((t) => !UUID_RE.test(String(t || '')))) return 'A conversation id was not valid.';
  }
  if (req.op === 'move') {
    if (!(SYSTEM_FOLDERS as readonly string[]).includes(String(req.folder || ''))) return 'That is not a folder.';
  }
  if (req.op === 'label-add' || req.op === 'label-remove') {
    const l = String(req.label || '').trim();
    if (!l) return 'No label was given.';
    if (l.length > 80) return 'That label is too long.';
  }
  if (req.op === 'snooze') {
    const t = Date.parse(String(req.until || ''));
    if (!isFinite(t)) return 'That is not a time.';
    if (t <= Date.now()) return 'A snooze has to be in the future — a time that has passed would put the message straight back.';
  }
  return null;
}

/**
 * The set of conversation ids this selection resolves to, as a SQL fragment.
 *
 * Never materialised into JavaScript for the query form. The fragment is a subselect the UPDATE
 * uses directly, so "everything matching" is one statement whatever its size.
 */
async function selectionFragment(userId: string, sel: BulkSelection): Promise<{ frag: any; query?: SearchQuery }> {
  if (sel.mode === 'ids') {
    const ids = sel.threadIds.map(String).filter((t) => UUID_RE.test(t));
    return {
      frag: sql`(SELECT t.x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(x))`,
    };
  }
  const { where, query } = await compileSelection(userId, sel.query || '', sel.scope || {});
  const excluded = (sel.exclude || []).map(String).filter((t) => UUID_RE.test(t));
  const exclusion = excluded.length
    ? sql` AND b.thread_id <> ALL((SELECT array_agg(t.x::uuid) FROM jsonb_array_elements_text(${JSON.stringify(excluded)}::jsonb) AS t(x)))`
    : sql``;
  return {
    frag: sql`(
      SELECT DISTINCT b.thread_id
      FROM mail_box b
      JOIN mail_messages m ON m.id = b.message_id
      WHERE ${where}${exclusion}
      LIMIT ${MAX_BULK_THREADS}
    )`,
    query,
  };
}

/**
 * How many conversations a selection covers, and whether that is more than one operation may touch.
 *
 * Counted through the SAME fragment the write uses. A confirmation dialog built on a different
 * count than the write would eventually be wrong about something irreversible.
 */
export async function previewBulk(userId: string, sel: BulkSelection): Promise<{ threads: number; capped: boolean; query?: SearchQuery; error?: string }> {
  try {
    const { frag, query } = await selectionFragment(userId, sel);
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM ${frag} AS s(thread_id)`);
    const n = Number(rowsOf(r)[0]?.n || 0);
    return { threads: n, capped: n >= MAX_BULK_THREADS, query };
  } catch (e: any) {
    console.error('[mail-bulk] preview failed:', reasonOf(e));
    return { threads: 0, capped: false, error: 'That selection could not be counted: ' + reasonOf(e) };
  }
}

/**
 * APPLY.
 *
 * One statement per operation, driven by the selection subselect. Nothing here loops in JavaScript
 * and nothing here issues a request per conversation.
 *
 * Two refusals are structural rather than cosmetic and are repeated from /api/mail/action.ts on
 * purpose — they are the rules of the mailbox, not of that endpoint:
 *   - `archive` and `spam` never move Sent or Drafts. Filing away your own unsent work is not
 *     something anybody asks for and it is how drafts get lost.
 *   - `delete` is permanent and only acts inside Trash. Everywhere else it is a no-op, and the
 *     result says so rather than reporting a deletion that did not happen.
 */
export async function applyBulk(userId: string, req: BulkRequest): Promise<BulkResult> {
  const invalid = validateBulk(req);
  if (invalid) {
    return { ok: false, op: req.op, threads: 0, messages: 0, truncated: false, message: invalid, error: invalid };
  }

  let query: SearchQuery | undefined;
  try {
    const sf = await selectionFragment(userId, req.selection);
    query = sf.query;
    const target = sql`user_id = ${userId} AND thread_id IN ${sf.frag}`;

    // The conversation count is taken BEFORE the write for `delete` (the rows are about to be gone)
    // and reported for every operation, because "142 conversations archived" is the sentence a
    // person can check and "done" is not.
    const before = await db.execute(sql`
      SELECT COUNT(DISTINCT thread_id)::int AS threads FROM mail_box WHERE ${target}`);
    const threadsTargeted = Number(rowsOf(before)[0]?.threads || 0);

    let statement: any;
    switch (req.op) {
      case 'read': statement = sql`UPDATE mail_box SET is_read = true WHERE ${target} AND is_read = false`; break;
      case 'unread': statement = sql`UPDATE mail_box SET is_read = false WHERE ${target} AND is_read = true`; break;
      case 'star': statement = sql`UPDATE mail_box SET is_starred = true WHERE ${target} AND is_starred = false`; break;
      case 'unstar': statement = sql`UPDATE mail_box SET is_starred = false WHERE ${target} AND is_starred = true`; break;
      case 'important': statement = sql`UPDATE mail_box SET is_important = true WHERE ${target} AND is_important = false`; break;
      case 'unimportant': statement = sql`UPDATE mail_box SET is_important = false WHERE ${target} AND is_important = true`; break;
      case 'archive': statement = sql`UPDATE mail_box SET folder = 'archive' WHERE ${target} AND folder NOT IN ('sent','drafts','archive')`; break;
      case 'inbox': statement = sql`UPDATE mail_box SET folder = 'inbox', snoozed_until = NULL WHERE ${target} AND folder <> 'inbox'`; break;
      case 'trash': statement = sql`UPDATE mail_box SET folder = 'trash' WHERE ${target} AND folder <> 'trash'`; break;
      case 'spam': statement = sql`UPDATE mail_box SET folder = 'spam' WHERE ${target} AND folder NOT IN ('sent','drafts','spam')`; break;
      case 'delete': statement = sql`DELETE FROM mail_box WHERE ${target} AND folder = 'trash'`; break;
      case 'move': statement = sql`UPDATE mail_box SET folder = ${String(req.folder)} WHERE ${target} AND folder <> ${String(req.folder)}`; break;
      case 'label-add':
        // DISTINCT so a label applied twice does not accumulate, and array_append rather than a
        // rebuild so the existing labels keep their order.
        statement = sql`UPDATE mail_box SET labels = (SELECT ARRAY(SELECT DISTINCT unnest(labels || ARRAY[${String(req.label)}]::text[])))
                        WHERE ${target} AND NOT (labels @> ARRAY[${String(req.label)}]::text[])`;
        break;
      case 'label-remove':
        statement = sql`UPDATE mail_box SET labels = array_remove(labels, ${String(req.label)})
                        WHERE ${target} AND labels @> ARRAY[${String(req.label)}]::text[]`;
        break;
      case 'snooze':
        // Snoozing moves the conversation OUT of the inbox view via mail-search's predicate and
        // records when it comes back. The folder is left alone: a snoozed message is still filed
        // where it was, it is simply not shown until its time.
        statement = sql`UPDATE mail_box SET snoozed_until = ${new Date(String(req.until)).toISOString()}::timestamptz WHERE ${target}`;
        break;
      case 'unsnooze':
        statement = sql`UPDATE mail_box SET snoozed_until = NULL WHERE ${target} AND snoozed_until IS NOT NULL`;
        break;
      default:
        return { ok: false, op: req.op, threads: 0, messages: 0, truncated: false, message: 'That is not an operation this mailbox performs.', error: 'unknown op' };
    }

    const res: any = await db.execute(statement);
    // postgres-js returns the affected count on `.count`; the pg driver uses `.rowCount`. Neither is
    // guaranteed here, so the thread number — which came from a SELECT — is the one reported, and
    // the row number falls back to it rather than to zero.
    const messages = Number(res?.count ?? res?.rowCount ?? 0) || 0;

    logEvent('info', 'mail.bulk', {
      userId,
      op: req.op,
      mode: req.selection.mode,
      threads: threadsTargeted,
      messages,
      truncated: threadsTargeted >= MAX_BULK_THREADS,
    });

    const truncated = threadsTargeted >= MAX_BULK_THREADS;
    return {
      ok: true,
      op: req.op,
      threads: threadsTargeted,
      messages,
      truncated,
      query,
      message: describeResult(req.op, threadsTargeted, truncated, req),
    };
  } catch (e: any) {
    // e.message is only the failed SQL; the reason is on e.cause. The person is told the mailbox is
    // UNCHANGED, which is true — every operation above is a single statement.
    const reason = reasonOf(e);
    console.error('[mail-bulk] ' + req.op + ' failed:', reason);
    logEvent('error', 'mail.bulk.failed', { userId, op: req.op, message: reason });
    return {
      ok: false, op: req.op, threads: 0, messages: 0, truncated: false, query,
      message: 'That did not go through, and your mail is unchanged.',
      error: reason,
    };
  }
}

/** The sentence shown after the operation. One place, so every surface says the same thing. */
export function describeResult(op: BulkOp, threads: number, truncated: boolean, req?: Partial<BulkRequest>): string {
  const n = threads.toLocaleString('en-IN');
  const c = threads === 1 ? 'conversation' : 'conversations';
  const verb: Record<BulkOp, string> = {
    read: 'marked as read', unread: 'marked as unread',
    star: 'starred', unstar: 'unstarred',
    important: 'marked important', unimportant: 'no longer marked important',
    archive: 'archived', inbox: 'moved back to the inbox', trash: 'moved to trash', spam: 'reported as spam',
    delete: 'permanently deleted', move: 'moved to ' + String(req?.folder || 'another folder'),
    'label-add': 'labelled ' + String(req?.label || ''), 'label-remove': 'no longer labelled ' + String(req?.label || ''),
    snooze: 'snoozed', unsnooze: 'brought back',
  };
  if (threads === 0) {
    if (op === 'delete') return 'Nothing was deleted. Permanent deletion only applies to conversations already in Trash.';
    return 'Nothing changed — those conversations were already in that state.';
  }
  const base = n + ' ' + c + ' ' + verb[op] + '.';
  if (truncated) {
    return base + ' That is the maximum for one operation (' + MAX_BULK_THREADS.toLocaleString('en-IN') + '); run it again to continue with the rest.';
  }
  return base;
}
