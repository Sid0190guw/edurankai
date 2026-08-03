// GET /api/portal/notifications-recent
// Returns latest 10 notifications + unread count for the signed-in user.
// Used by the BaseLayout toast poller. 401 for guests so the poll is cheap.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureNotificationsSchema } from '@/lib/notifications-schema';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

// THE TABLE IS NOT CREATED HERE — see the same note in the admin sibling. A private ensureTable()
// with a narrower CREATE than src/lib/push.ts writes was the fourth copy of this DDL; on a fresh
// database the 20-second portal poll could easily have been the statement that won, and every later
// INSERT naming category/priority would then have thrown forever with nothing on screen to show it.
// One table, one CREATE: src/lib/notifications-schema.ts, additive and safe on a live table.
// Still memoised internally, so this poll does not re-run DDL on every request.
const ensureTable = ensureNotificationsSchema;

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  await ensureTable();
  const list = rows(await db.execute(sql`
    SELECT id, title, body, type, action_url, is_read, created_at
    FROM notifications WHERE user_id = ${user.id}
    ORDER BY created_at DESC LIMIT 10
  `));
  const unreadRow = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${user.id} AND is_read = false`))[0] as any;
  return json({ ok: true, items: list, unread: unreadRow?.n || 0 });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch {}
  await ensureTable();
  if (body.action === 'mark_read' && body.id) {
    await db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = ${body.id} AND user_id = ${user.id}`);
    return json({ ok: true });
  }
  if (body.action === 'mark_all_read') {
    await db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = ${user.id} AND is_read = false`);
    return json({ ok: true });
  }
  return json({ ok: false, error: 'unknown action' }, 400);
};
