// POST /api/mail/imap-test
// Body: { host, port, user, pass, secure? }
// Verifies an IMAP connection without saving. Used by the Verify button under
// the IMAP / inbound section of the admin settings page.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailSchema } from '@/lib/mail';
import { verifyImap } from '@/lib/mail-imap';
import { can } from '@/lib/auth/permissions';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  // Same swap as its four siblings, and deliberately made in the same commit so the six mail routes
  // cannot end up disagreeing about who administers mail. `mail.manage` is held by exactly the ten
  // non-applicant built-in roles — the population `role === 'applicant'` already excluded — so this
  // changes HOW the question is asked and not WHO may answer it.
  //
  // can() only: denyAdminApi()/hasPermission() would each move the set (see verify.ts). No database,
  // fails closed.
  if (!can((locals as any).user, 'mail.manage')) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  let pass = (body.pass || '').toString();
  if (!pass) {
    try {
      await ensureMailSchema();
      try { await db.execute(sql`ALTER TABLE mail_config ADD COLUMN IF NOT EXISTS imap_pass TEXT`); } catch (_) {}
      const r = rows(await db.execute(sql`SELECT imap_pass FROM mail_config WHERE id = 1 LIMIT 1`))[0] as any;
      pass = (r?.imap_pass || '').toString();
    } catch (_) {}
  }

  const res = await verifyImap({
    host: (body.host || '').toString().trim(),
    port: Number(body.port || 993),
    user: (body.user || '').toString().trim(),
    pass,
    secure: body.secure == null ? true : !!body.secure,
  });
  return json(res);
};
