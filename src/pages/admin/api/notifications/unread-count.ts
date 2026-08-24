// GET /admin/api/notifications/unread-count — the number on the admin bell.
//
// IT USED TO ANSWER `{ count: 0 }` TO EVERYTHING, INCLUDING FAILURE.
//
// A thrown query returned 200 with a zero, and a request with no session returned 200 with a zero
// too. So "nothing is waiting for you", "you are signed out" and "the notifications table could not
// be read" were one indistinguishable answer, and the badge stated the first of the three as a fact
// on all three. On a bell that is the only signal a person has that something arrived, silently
// asserting zero is worse than saying nothing.
//
// It now reports what actually happened, and the reason reaches the log — e.cause carries the real
// Postgres message, e.message is only the SQL that failed. The badge in src/layouts/AdminLayout.astro
// reads `data.count || 0`, so an error body without a `count` simply leaves the badge hidden rather
// than showing a wrong number; the layout is not edited here (it is off-limits without approval) and
// does not need to be for this to stop lying.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
// THE 503 BELOW WAS UNREACHABLE ON THE FAILURE THAT MATTERS.
//
// Everything this file's header says about not asserting zero was true of a query that FAILS. A
// query that never answers reached none of it: postgres-js has no query timeout, so the await never
// settled, the platform killed the invocation, and the badge got no response at all — which the
// client also renders as "nothing waiting". Worse, this is POLLED from every open admin tab, so
// each stalled poll held one of the instance's five pooler connections for the whole invocation.
//
// Bounded and deliberately NOT retried: it polls again on its own, and a second ask inside one poll
// only doubles the load at the moment the database is already struggling.
import { withDbTimeout } from '@/lib/db-timeout';

// Declared above the handler that uses them: `const` is not hoisted.
const json = (d: any, status = 200): Response =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const r = await withDbTimeout(
      db.execute(sql`SELECT COUNT(*)::int as n FROM notifications WHERE user_id = ${user.id} AND is_read = false`),
      'admin.unreadCount', 3000);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    const count = Number((rows[0] as any)?.n) || 0;
    return json({ ok: true, count });
  } catch (e: any) {
    logEvent('error', 'admin.notifications.unread-count-failed', {
      userId: String(user?.id || ''),
      message: reasonOf(e),
    });
    return json({ ok: false, error: 'the unread count could not be read' }, 503);
  }
};
