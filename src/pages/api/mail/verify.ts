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

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  let pass = (body.pass || '').toString();
  if (!pass) {
    try {
      await ensureMailSchema();
      const r = rows(await db.execute(sql`SELECT smtp_pass FROM mail_config WHERE id = 1 LIMIT 1`))[0] as any;
      pass = (r?.smtp_pass || '').toString();
    } catch (_) {}
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
