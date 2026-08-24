// GET /api/admin/notifications-recent
// Returns the current user's latest notifications for the bell dropdown.
// POST same path with { action: 'mark_read', id } marks one read.
// POST { action: 'mark_all_read' } clears the unread badge.
// POST { action: 'test' } inserts a test notification (proves the pipeline).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { ensureNotificationsSchema } from '@/lib/notifications-schema';
// A POLLED ENDPOINT WITH NO BOUND IS THE WORST SHAPE THERE IS.
//
// AdminLayout polls this from every open admin tab. Not one of its awaits was bounded and the GET
// had no try/catch at all, so a stalled connection did not answer 500 — it held the invocation
// until the platform killed it, and postgres-js kept the connection reserved the whole time. Every
// admin tab in the building doing that at once is how an instance runs out of connections for the
// pages somebody is actually reading.
//
// Bounded and NEVER retried: this polls again on its own, so a second ask inside one poll only
// doubles the load at the moment the database is already struggling. The next poll IS the retry.
import { withDbTimeout, isDbUnavailable } from '@/lib/db-timeout';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

// THE TABLE IS NOT CREATED HERE. A private ensureTable() used to sit on this spot with its own
// CREATE TABLE IF NOT EXISTS notifications, listing FEWER columns than src/lib/push.ts writes — no
// category, no priority, no is_archived, no seen_at/clicked_at. CREATE TABLE IF NOT EXISTS is a
// NO-OP on an existing table, so on a database where this 15-second poll got there first, every
// later `INSERT ... (category, priority)` in persistNotification() would have thrown forever while
// the bell simply stayed empty and nothing anywhere said why. One table, one CREATE:
// src/lib/notifications-schema.ts, which is additive and therefore safe on a live table.
//
// Still memoised — that is what ensureNotificationsSchema() does internally — so the poll does not
// fire DDL on every request and keep the database awake for nothing.
const ensureTable = ensureNotificationsSchema;

export const GET: APIRoute = async ({ locals }) => {
  // The admin bell feed, polled by AdminLayout on every admin page. Rows are already scoped to
  // user_id, so no capability is needed beyond "may open an admin surface" — but that question was
  // never asked: `role !== 'applicant'` admitted the AquinTutor partner/teacher/moderator scopes the
  // middleware bounces off /admin, and any wrongly-promoted intern.
  const denied = await denyAdminApi(locals, { label: 'notifications-recent.get' });
  if (denied) return denied;
  const user = (locals as any).user;
  try {
    await withDbTimeout(ensureTable(), 'notificationsRecent.ensure', 2500);
  } catch (e: any) {
    // Memoised and a no-op in production, so a failure here is not fatal to the read below - the
    // table has existed for as long as the bell has. Logged rather than thrown for that reason.
    console.error('[notifications-recent] ensure failed:', e?.cause?.message || e?.message);
  }
  try {
    // ONE ROUND TRIP, NOT TWO. The unread count is a scalar subquery on the same statement, and the
    // count is over the WHOLE feed rather than the ten rows returned, so it is still the badge's
    // number. Two awaits on a five-minute poll from every admin tab is a connection each, twice.
    const list = rows(await withDbTimeout(db.execute(sql`
      SELECT id, title, body, type, action_url, is_read, created_at,
             (SELECT COUNT(*)::int FROM notifications un
               WHERE un.user_id = ${user.id} AND un.is_read = false) AS unread_total
      FROM notifications WHERE user_id = ${user.id}
      ORDER BY created_at DESC LIMIT 10
    `), 'notificationsRecent.feed', 3000));
    // No rows means no notifications at all, which also means nothing unread. The subquery only
    // rides along on a row, so the empty case is answered here rather than by a second statement.
    const unread = list.length > 0 ? Number(list[0].unread_total || 0) : 0;
    return json({ ok: true, items: list.map((r: any) => {
      const { unread_total, ...item } = r;
      return item;
    }), unread });
  } catch (e: any) {
    // ok:false AND unreadKnown:false, so the bell can leave the badge alone instead of painting a
    // zero it did not read. A silent 500 here made the badge vanish, which an admin reads as
    // "nothing new" - the one thing this endpoint must never say when it does not know.
    console.error('[notifications-recent] feed read failed:', e?.cause?.message || e?.message);
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
  const denied = await denyAdminApi(locals, { label: 'notifications-recent.post' });
  if (denied) return denied;
  const user = (locals as any).user;
  let body: any = {}; try { body = await request.json(); } catch {}
  try {
    await withDbTimeout(ensureTable(), 'notificationsRecent.ensure.post', 2500);
  } catch (e: any) {
    console.error('[notifications-recent] ensure failed:', e?.cause?.message || e?.message);
  }
  // WRITES ARE BOUNDED AND NEVER RETRIED, and the answer distinguishes "it did not happen" from "we
  // could not confirm it". withDbTimeout sheds the WAIT and not the WORK, so a timed-out UPDATE may
  // still land — telling the reader it failed would send them to press the button again over a
  // change that had already been made.
  const writeFailed = (e: any) => {
    console.error('[notifications-recent] write failed:', e?.cause?.message || e?.message);
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
      await withDbTimeout(db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = ${body.id} AND user_id = ${user.id}`), 'notificationsRecent.markRead', 4000);
    } catch (e: any) { return writeFailed(e); }
    return json({ ok: true });
  }
  if (body.action === 'mark_all_read') {
    try {
      await withDbTimeout(db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = ${user.id} AND is_read = false`), 'notificationsRecent.markAllRead', 4000);
    } catch (e: any) { return writeFailed(e); }
    return json({ ok: true });
  }
  if (body.action === 'test') {
    try {
      await withDbTimeout(db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type, action_url)
      VALUES (${user.id}, ${'Test notification'}, ${'If you can see this in the bell dropdown, the in-app feed is wired correctly. ' + new Date().toLocaleTimeString()}, ${'test'}, ${'/admin/notifications'})
    `), 'notificationsRecent.test', 4000);
    } catch (e: any) { return writeFailed(e); }
    // Also try a push to confirm the browser channel.
    //
    // THE DIAGNOSTIC ANSWERED ok:true WHETHER OR NOT THE THING IT DIAGNOSES WORKED. This whole block
    // sat in `catch (_) {}` followed by an unconditional success, so the ONE button whose purpose is
    // to prove the push channel is wired reported the same result when the push threw — an operator
    // pressing it and seeing the in-app row appear concludes push delivery is healthy. The in-app
    // insert above is the part that genuinely succeeded and the response still says so; the push half
    // now reports itself separately instead of being erased.
    //
    // WHAT THIS CAN HONESTLY REPORT. sendPushToUser() swallows per-subscription failures internally
    // and returns void, so "it did not throw" is NOT evidence that a push arrived and this response
    // must not imply otherwise. What IS knowable here is whether this account has a browser
    // subscription at all — with none, no push can possibly have been delivered, and that is exactly
    // the state the button is pressed to detect. So the response reports the in-app write (which did
    // succeed, above), the subscription count, and whether the attempt threw. Nothing more.
    let attemptThrew = '';
    let subscriptions = 0;
    try {
      const subRows = rows(await withDbTimeout(db.execute(sql`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = ${user.id}`), 'notificationsRecent.subCount', 3000));
      subscriptions = Number((subRows[0] as any)?.n) || 0;
    } catch (e: any) {
      console.error('[api/admin/notifications-recent] subscription count failed:', String(e?.cause?.message || e?.message || 'unknown error'));
      subscriptions = -1; // unknown, and said so rather than reported as zero
    }
    try {
      const { sendPushToUser } = await import('@/lib/push');
      await sendPushToUser(user.id, {
        type: 'test',
        title: 'EduRankAI test notification',
        body: 'In-app + push delivery test.',
        url: '/admin/notifications',
        tag: 'admin-test',
      });
    } catch (e: any) {
      attemptThrew = String(e?.cause?.message || e?.message || 'unknown error');
      console.error('[api/admin/notifications-recent] test push threw:', attemptThrew);
    }
    return json({
      ok: true,
      inApp: true,
      pushSubscriptions: subscriptions,
      pushAttempted: !attemptThrew,
      pushError: attemptThrew || undefined,
      note: subscriptions === 0
        ? 'The in-app notification was written. No browser push subscription is registered for this account, so no push was delivered.'
        : 'The in-app notification was written and a push was attempted. Delivery to the browser cannot be confirmed from the server.',
    });
  }
  return json({ ok: false, error: 'unknown action' }, 400);
};
