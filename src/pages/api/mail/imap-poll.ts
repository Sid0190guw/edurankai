// POST /api/mail/imap-poll
// Triggers a one-shot IMAP fetch. Two auth modes:
//   1. Admin clicked "Check now" in the UI -> session cookie auth.
//   2. Cron (Vercel cron / external scheduler) -> Authorization: Bearer <CRON_SECRET>
//      env (or x-cron-secret header).
// Returns { ok, fetched, delivered, detail|error }.
import type { APIRoute } from 'astro';
import { pollImapInbox } from '@/lib/mail-imap';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = request.headers.get('authorization') || '';
  if (a === `Bearer ${secret}`) return true;
  const x = request.headers.get('x-cron-secret') || '';
  return x === secret;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  const isAdmin = user && user.role !== 'applicant';
  if (!isAdmin && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const result = await pollImapInbox({ limit: 100 });
  return json(result);
};

// GET form so Vercel cron (which sends GET) also works.
export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  const isAdmin = user && user.role !== 'applicant';
  if (!isAdmin && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const result = await pollImapInbox({ limit: 100 });
  return json(result);
};
