// POST /api/aquintutor/notifications-read — mark the signed-in user's notifications read (Prompt 18).
//
// IT USED TO BE `try { await markAllRead(user.id); } catch {}` FOLLOWED BY `ok: true`.
//
// That is a swallowed error in a write path reporting success, and its only caller — the "Mark all
// read" button on /aquintutor/alerts — reloaded the page on the response whatever it said. So a
// failed UPDATE produced: no error, a full page reload, and every notification still unread. The
// person presses the button again. And again. Nothing anywhere records that the write threw.
//
// The reason now reaches the log (e.cause carries the real Postgres message; e.message is only the
// SQL) and the caller gets a 500 it can say something true about.
import type { APIRoute } from 'astro';
import { markAllRead } from '@/lib/edu-notify';
import { logEvent } from '@/lib/logger';

// Declared above the handler that uses them: `const` is not hoisted.
const json = (d: any, status = 200): Response =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    await markAllRead(user.id);
  } catch (e: any) {
    logEvent('error', 'aquintutor.notifications.mark-all-failed', {
      userId: String(user.id),
      message: reasonOf(e),
    });
    return json(
      { ok: false, error: 'These could not be marked as read just now. Nothing has been lost.' },
      500,
    );
  }
  return json({ ok: true });
};
