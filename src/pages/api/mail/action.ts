// POST /api/mail/action - mailbox state changes (read/star/move/label/delete) scoped to the user.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailSchema } from '@/lib/mail';
import { denyMailApi } from '@/lib/auth/mail-access';
import { uuidIn } from '@/lib/pg-array';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The real Postgres reason is on e.cause; e.message is only the failed SQL. Declared above the
// handler that reads it — `const` is not hoisted.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, locals }) => {
  // The SAME question its two siblings ask, so the three endpoints one composer calls cannot answer
  // differently. Every statement below is already narrowed to `user_id = <caller>`, so this is not
  // closing a leak — it is refusing to write mailbox rows for an account that has no mailbox, and
  // it authorises BEFORE the body is read and before ensureMailSchema() runs any DDL.
  const denied = await denyMailApi(locals, { label: 'mail.action' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const action = (body.action || '').toString();
  const threadIds: string[] = ([] as string[])
    .concat(body.threadId ? [body.threadId] : [])
    .concat(Array.isArray(body.threadIds) ? body.threadIds : []);
  if (!threadIds.length) return json({ ok: false, error: 'threadId(s) required' }, 400);

  // EVERY ACTION ON THIS ENDPOINT WAS DEAD, AND THIS ONE LINE IS WHY.
  //
  //     thread_id = ANY(${threadIds}::uuid[])
  //
  // postgres-js serialises a JS array as a RECORD literal, so Postgres answers "cannot cast type
  // record to uuid[]" and the statement never runs — src/lib/pg-array.ts documents this exact fault
  // and the four other modules it had already silently broken. This fragment is spliced into all
  // thirteen branches below, so read, unread, star, archive, trash, restore, move, permanent delete
  // and both label actions threw on every request, and the catch handed the mailbox the database's
  // own complaint. `IN ${uuidIn(...)}` is the repaired idiom used everywhere else in this codebase.
  //
  // Non-uuid ids are refused BEFORE the statement rather than inside it: uuidIn() casts each element
  // to ::uuid, and one junk value would otherwise throw 22P02 and fail the whole batch.
  const bad = threadIds.filter((t) => !UUID_RE.test(String(t || '')));
  if (bad.length) return json({ ok: false, error: 'threadId must be a uuid' }, 400);
  const filter = sql`user_id = ${user.id} AND thread_id IN ${uuidIn(threadIds.map(String))}`;

  try {
    await ensureMailSchema();
    switch (action) {
      case 'read':
        await db.execute(sql`UPDATE mail_box SET is_read = true WHERE ${filter}`); break;
      case 'unread':
        await db.execute(sql`UPDATE mail_box SET is_read = false WHERE ${filter}`); break;
      case 'star':
        await db.execute(sql`UPDATE mail_box SET is_starred = true WHERE ${filter}`); break;
      case 'unstar':
        await db.execute(sql`UPDATE mail_box SET is_starred = false WHERE ${filter}`); break;
      case 'important':
        await db.execute(sql`UPDATE mail_box SET is_important = NOT is_important WHERE ${filter}`); break;
      case 'archive':
        await db.execute(sql`UPDATE mail_box SET folder = 'archive' WHERE ${filter} AND folder NOT IN ('sent','drafts')`); break;
      case 'trash':
        await db.execute(sql`UPDATE mail_box SET folder = 'trash' WHERE ${filter}`); break;
      case 'spam':
        await db.execute(sql`UPDATE mail_box SET folder = 'spam' WHERE ${filter} AND folder NOT IN ('sent','drafts')`); break;
      case 'restore':
      case 'inbox':
        await db.execute(sql`UPDATE mail_box SET folder = 'inbox' WHERE ${filter}`); break;
      case 'move': {
        const folder = (body.folder || '').toString();
        if (!FOLDERS.includes(folder)) return json({ ok: false, error: 'bad folder' }, 400);
        await db.execute(sql`UPDATE mail_box SET folder = ${folder} WHERE ${filter}`); break;
      }
      case 'delete': // permanent (only from trash)
        await db.execute(sql`DELETE FROM mail_box WHERE ${filter} AND folder = 'trash'`); break;
      case 'label-add': {
        const label = (body.label || '').toString().slice(0, 80);
        if (!label) return json({ ok: false, error: 'label required' }, 400);
        await db.execute(sql`UPDATE mail_box SET labels = (SELECT ARRAY(SELECT DISTINCT unnest(labels || ${[label]}::text[]))) WHERE ${filter}`); break;
      }
      case 'label-remove': {
        const label = (body.label || '').toString();
        await db.execute(sql`UPDATE mail_box SET labels = array_remove(labels, ${label}) WHERE ${filter}`); break;
      }
      default:
        return json({ ok: false, error: 'unknown action' }, 400);
    }
    return json({ ok: true });
  } catch (e: any) {
    // e.message is only the failed SQL — schema names handed to whoever posted, and nothing at all
    // written down for whoever has to work out why the mailbox stopped responding.
    console.error('[api/mail/action] ' + action + ' failed:', reasonOf(e));
    return json({ ok: false, error: 'That did not go through, and your mailbox is unchanged.' }, 500);
  }
};
