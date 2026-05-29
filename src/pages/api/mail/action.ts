// POST /api/mail/action - mailbox state changes (read/star/move/label/delete) scoped to the user.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailSchema } from '@/lib/mail';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'];

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const action = (body.action || '').toString();
  const threadIds: string[] = []
    .concat(body.threadId ? [body.threadId] : [])
    .concat(Array.isArray(body.threadIds) ? body.threadIds : []);
  if (!threadIds.length) return json({ ok: false, error: 'threadId(s) required' }, 400);

  // build a thread filter (cast bound text[] to uuid[] for the uuid column)
  const filter = sql`user_id = ${user.id} AND thread_id = ANY(${threadIds}::uuid[])`;

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
    return json({ ok: false, error: e?.message || 'action failed' }, 500);
  }
};
