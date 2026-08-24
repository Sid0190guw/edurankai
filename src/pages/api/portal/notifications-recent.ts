// GET /api/portal/notifications-recent
// Returns latest 10 notifications + unread count for the signed-in user.
// Used by the BaseLayout toast poller. 401 for guests so the poll is cheap.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureNotificationsSchema } from '@/lib/notifications-schema';
// THE SAME TREATMENT ITS ADMIN SIBLING GOT, AND THE REASON IT WAS MISSED IS WORTH RECORDING.
//
// src/pages/api/admin/notifications-recent.ts and this file are the same endpoint twice, for two
// audiences. The admin one was found and bounded; this one was not, because the search was for
// broken SURFACES and this is an API. It is the more heavily polled of the two: BaseLayout drives
// it from every signed-in portal page.
//
// Not one of its awaits was bounded and the GET had no try/catch at all, so a stalled connection did
// not answer 500 — it held the invocation until the platform killed it, with postgres-js keeping the
// connection reserved throughout.
//
// Bounded and NEVER retried: it polls again on its own, so a second ask inside one poll only doubles
// the load at the moment the database is already struggling. The next poll is the retry.
import { withDbTimeout, isDbUnavailable } from '@/lib/db-timeout';

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
  try {
    await withDbTimeout(ensureTable(), 'portalNotifications.ensure', 2500);
  } catch (e: any) {
    // Memoised and a no-op in production, so a failure here does not stop the read below.
    console.error('[portal/notifications-recent] ensure failed:', e?.cause?.message || e?.message);
  }
  try {
    // ONE ROUND TRIP, NOT TWO. The unread count rides along as a scalar subquery over the WHOLE
    // feed, so it is still the badge's number and not a count of the ten rows returned.
    const list = rows(await withDbTimeout(db.execute(sql`
      SELECT id, title, body, type, action_url, is_read, created_at,
             (SELECT COUNT(*)::int FROM notifications un
               WHERE un.user_id = ${user.id} AND un.is_read = false) AS unread_total
      FROM notifications WHERE user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 10
    `), 'portalNotifications.feed', 3000));
    // No rows means no notifications at all, which also means nothing unread — the subquery only
    // rides along on a row, so the empty case is answered here rather than by a second statement.
    const unread = list.length > 0 ? Number((list[0] as any).unread_total || 0) : 0;
    return json({
      ok: true,
      items: list.map((r: any) => { const { unread_total, ...item } = r; return item; }),
      unread,
    });
  } catch (e: any) {
    // ok:false AND unreadKnown:false, so the caller can leave its badge alone rather than painting a
    // zero it never read. A silent 500 made the toast poller go quiet, which reads as "nothing new".
    console.error('[portal/notifications-recent] feed read failed:', e?.cause?.message || e?.message);
    return json({
      ok: false,
      unreadKnown: false,
      error: isDbUnavailable(e)
        ? 'The database did not answer, so notifications could not be read.'
        : 'Notifications could not be read.',
    }, 503);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch {}
  try {
    await withDbTimeout(ensureTable(), 'portalNotifications.ensure.post', 2500);
  } catch (e: any) {
    console.error('[portal/notifications-recent] ensure failed:', e?.cause?.message || e?.message);
  }
  // Bounded, never retried, and the answer distinguishes "it did not happen" from "we could not
  // confirm it": withDbTimeout sheds the WAIT and not the WORK, so a timed-out UPDATE may still
  // land, and telling the reader it failed would send them to do it again.
  const writeFailed = (e: any) => {
    console.error('[portal/notifications-recent] write failed:', e?.cause?.message || e?.message);
    return json({
      ok: false,
      confirmed: false,
      error: isDbUnavailable(e)
        ? 'The database did not answer, so this may or may not have been applied. Reload to see the current state.'
        : 'That change could not be applied.',
    }, isDbUnavailable(e) ? 503 : 500);
  };
  if (body.action === 'mark_read' && body.id) {
    try {
      await withDbTimeout(db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = ${body.id} AND user_id = ${user.id}`), 'portalNotifications.markRead', 4000);
    } catch (e: any) { return writeFailed(e); }
    return json({ ok: true });
  }
  if (body.action === 'mark_all_read') {
    try {
      await withDbTimeout(db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = ${user.id} AND is_read = false`), 'portalNotifications.markAllRead', 4000);
    } catch (e: any) { return writeFailed(e); }
    return json({ ok: true });
  }
  return json({ ok: false, error: 'unknown action' }, 400);
};
