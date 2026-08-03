// POST /api/mail/imap-poll
// Triggers a one-shot IMAP fetch. Two auth modes:
//   1. Admin clicked "Check now" in the UI -> session cookie auth.
//   2. Cron (Vercel cron / external scheduler) -> Authorization: Bearer <CRON_SECRET>
//      env (or x-cron-secret header).
// Returns { ok, fetched, delivered, detail|error }.
import type { APIRoute } from 'astro';
import { pollImapInbox } from '@/lib/mail-imap';
import { can } from '@/lib/auth/permissions';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// THE ABILITY, ASKED FOR BY NAME. Declared once, above both handlers, because `const` is not hoisted
// and a handler reaching a later declaration has taken pages down on this project.
//
// This replaces `user && user.role !== 'applicant'` — the exact test canAccessSection()'s docblock in
// src/lib/auth/permissions.ts warns against. MECHANISM, NOT POLICY: `mail.manage` is granted in
// PERMS_BY_ROLE to all TEN non-applicant built-in roles and withheld from `applicant`, which is
// precisely the population that passes today, so nobody gains or loses this endpoint.
//
// can(), NEVER denyAdminApi() OR hasPermission(). denyAdminApi runs canOpenAdmin() first, which would
// remove partner, teacher, technical_moderator (bounced off /admin by the middleware) and every
// intern-flagged account; hasPermission() additionally admits any custom role holding a matching
// section row. Both move the set. can() reads the compiled matrix alone.
//
// It FAILS CLOSED with no database at all: no session, an inactive account or a role absent from the
// matrix all answer false, and there is no exception path that can answer true.
//
// REPORTED, NOT FIXED: the population this preserves is too wide. partner/teacher/
// technical_moderator and every intern-flagged account can pull the company mailbox with stored
// credentials. Narrowing it is a policy decision for a human; the grant is now the one place to make
// it, instead of six role-name tests.
const mayManageMail = (user: any): boolean => can(user, 'mail.manage');

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
  // The CRON_SECRET arm is untouched: a shared secret is not a role and no capability replaces it.
  if (!mayManageMail((locals as any).user) && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const result = await safePollWithTimeout(100);
  return json(result);
};

// GET form so Vercel cron (which sends GET) also works.
export const GET: APIRoute = async ({ request, locals }) => {
  if (!mayManageMail((locals as any).user) && !cronAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const result = await safePollWithTimeout(100);
  return json(result);
};
