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
  await ensureTable();
  const list = rows(await db.execute(sql`
    SELECT id, title, body, type, action_url, is_read, created_at
    FROM notifications WHERE user_id = ${user.id}
    ORDER BY created_at DESC LIMIT 10
  `));
  const unread = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${user.id} AND is_read = false`))[0]?.n || 0;
  return json({ ok: true, items: list, unread });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { label: 'notifications-recent.post' });
  if (denied) return denied;
  const user = (locals as any).user;
  let body: any = {}; try { body = await request.json(); } catch {}
  await ensureTable();
  if (body.action === 'mark_read' && body.id) {
    await db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = ${body.id} AND user_id = ${user.id}`);
    return json({ ok: true });
  }
  if (body.action === 'mark_all_read') {
    await db.execute(sql`UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = ${user.id} AND is_read = false`);
    return json({ ok: true });
  }
  if (body.action === 'test') {
    await db.execute(sql`
      INSERT INTO notifications (user_id, title, body, type, action_url)
      VALUES (${user.id}, ${'Test notification'}, ${'If you can see this in the bell dropdown, the in-app feed is wired correctly. ' + new Date().toLocaleTimeString()}, ${'test'}, ${'/admin/notifications'})
    `);
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
      const subRows = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = ${user.id}`));
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
