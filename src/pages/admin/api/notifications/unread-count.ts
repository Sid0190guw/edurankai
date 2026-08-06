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
    const r = await db.execute(sql`SELECT COUNT(*)::int as n FROM notifications WHERE user_id = ${user.id} AND is_read = false`);
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
