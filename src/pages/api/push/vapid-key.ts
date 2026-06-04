// GET /api/push/vapid-key
// Returns the VAPID public key so the browser can create a push subscription.
// Public information — safe to return unauthenticated.
import type { APIRoute } from 'astro';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const GET: APIRoute = async () => {
  const key = import.meta.env.VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || '';
  if (!key) return json({ ok: false, error: 'VAPID not configured' }, 503);
  return json({ ok: true, key });
};
