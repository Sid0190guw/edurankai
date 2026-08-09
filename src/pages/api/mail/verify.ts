// POST /api/mail/verify
// Body: { host, port, user, pass, secure, insecure }
// Runs nodemailer's transport.verify() so the admin can test connectivity +
// auth without committing values. Falls back to the saved password (DB) when
// the body omits one.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailSchema } from '@/lib/mail';
import { verifySmtp } from '@/lib/mail-transport';
import { can } from '@/lib/auth/permissions';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  // `!user || user.role === 'applicant'` -> the ability, asked for by name. MECHANISM, NOT POLICY:
  // `mail.manage` is granted in PERMS_BY_ROLE to exactly the ten non-applicant built-in roles, which
  // is exactly who passed the role-name test, so this endpoint's population is unchanged.
  //
  // can(), never denyAdminApi()/hasPermission() — canOpenAdmin() would remove partner, teacher,
  // technical_moderator and interns; the registry would add custom roles. Both move the set. can()
  // needs no database and fails closed on a missing session, an inactive account or an unknown role.
  //
  // The width is REPORTED, not fixed here: verifySmtp() answers whether a username and password
  // worked, so this is a credential-probing oracle held by every internal role. Narrow it by
  // changing the grant, which is now the single place that decides it.
  if (!can((locals as any).user, 'mail.manage')) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  // AN UNREADABLE SAVED PASSWORD BECAME AN EMPTY PASSWORD, AND THE SERVER BLAMED THE OPERATOR.
  // This is the same fault already repaired in /api/mail/test.ts and left standing here. The form
  // omits the password when the operator is re-testing saved settings, so this fallback IS the
  // credential on the ordinary path; `catch (_) {}` turned a pooler timeout into pass = '', SMTP
  // answered "authentication failed", and the only thing the admin is told is that their username
  // or app password is wrong. It is neither, and the natural response - rotating a working app
  // password - breaks mail for real. A read that failed is now said out loud instead of tested.
  let pass = (body.pass || '').toString();
  if (!pass) {
    try {
      await ensureMailSchema();
      const r = rows(await db.execute(sql`SELECT smtp_pass FROM mail_config WHERE id = 1 LIMIT 1`))[0] as any;
      pass = (r?.smtp_pass || '').toString();
    } catch (e: any) {
      const reason = String(e?.cause?.message || e?.message || 'unknown error');
      console.error('[api/mail/verify] saved password read failed:', reason);
      return json({
        ok: false,
        error: 'The saved SMTP password could not be read (' + reason + '), so nothing was tested. '
          + 'This is NOT an authentication failure - do not change the password on the strength of it.',
      }, 503);
    }
  }

  const res = await verifySmtp({
    host: (body.host || '').toString().trim(),
    port: Number(body.port || 587),
    user: (body.user || '').toString().trim(),
    pass,
    secure: !!body.secure,
    insecure: !!body.insecure,
  });
  return json(res);
};
