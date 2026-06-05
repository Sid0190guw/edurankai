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

// Wrap pollImapInbox so it can NEVER crash the cron / external scheduler.
// Bad credentials, network drops, malformed messages, imapflow library
// throws — all caught here and returned as a 200 with structured error info.
// This stops GitHub Actions / Vercel cron from retrying-and-crashing-and-
// retrying in a loop.
async function safePollWithTimeout(limit: number) {
  const timeoutMs = 90_000; // 90s — longer than any real IMAP fetch
  let timer: any = null;
  const timeoutPromise = new Promise<{ ok: false; fetched: 0; delivered: 0; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, fetched: 0, delivered: 0, error: 'IMAP poll timed out after 90s' }), timeoutMs);
  });
  try {
    const result = await Promise.race([pollImapInbox({ limit }), timeoutPromise]);
    if (timer) clearTimeout(timer);
    return result;
  } catch (e: any) {
    if (timer) clearTimeout(timer);
    return { ok: false, fetched: 0, delivered: 0, error: 'IMAP poll threw: ' + (e?.message || 'unknown error') };
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  const isAdmin = user && user.role !== 'applicant';
  if (!isAdmin && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const result = await safePollWithTimeout(100);
  return json(result);
};

// GET form so Vercel cron (which sends GET) also works.
export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  const isAdmin = user && user.role !== 'applicant';
  if (!isAdmin && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const result = await safePollWithTimeout(100);
  return json(result);
};
