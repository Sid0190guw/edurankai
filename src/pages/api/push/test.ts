// POST /api/push/test - send a test notification to the current user's devices.
// Returns a clear diagnostic so the user can tell if (a) they have no
// subscription, (b) VAPID keys are missing on the server, or (c) it worked.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { pushSubscriptions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';

const VAPID_PUBLIC = import.meta.env.VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = import.meta.env.VAPID_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = import.meta.env.VAPID_SUBJECT || process.env.VAPID_SUBJECT || 'mailto:hr@edurankai.in';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); } catch (_) {}
}

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false, error: 'Sign in first.' }, 401);

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return json({ ok: false, error: 'Server VAPID keys missing. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in Vercel.' }, 503);
  }

  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id));
  if (subs.length === 0) {
    return json({
      ok: false,
      noSubscription: true,
      error: 'No push subscription on file for this account. Click "Enable" on the portal or this page first, then run the test.',
    }, 400);
  }

  const payload = JSON.stringify({
    type: 'test',
    title: 'EduRankAI test notification',
    body: 'If you can see this, push is working on this device. ' + new Date().toLocaleTimeString(),
    url: '/admin/profile',
    tag: 'push-test',
    requireInteraction: false,
  });

  const results = await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 60 }
      );
      return { ok: true, endpoint: sub.endpoint.slice(-40) };
    } catch (err: any) {
      // Clean up dead subscriptions on the way through
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        return { ok: false, endpoint: sub.endpoint.slice(-40), expired: true, error: 'Subscription expired and was removed - re-enable on this device.' };
      }
      return { ok: false, endpoint: sub.endpoint.slice(-40), error: (err && err.message) || 'send failed', statusCode: err && err.statusCode };
    }
  }));

  const okCount = results.filter(r => r.ok).length;
  return json({
    ok: okCount > 0,
    subscriptions: subs.length,
    delivered: okCount,
    results,
    hint: okCount === 0
      ? 'Push API accepted no devices. Common cause: this device shows "Allowed" in the browser but the SW that received the message is stale - hard-refresh once (Ctrl+Shift+R) and try again.'
      : 'Sent. If the notification does not appear, your OS or browser may be blocking notifications globally (Windows Focus Assist, Do Not Disturb, etc).',
  });
};
