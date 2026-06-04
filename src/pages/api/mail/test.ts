// POST /api/mail/test - send a one-off test email to verify the outbound transport.
// Body: { to, host?, port?, user?, pass?, secure?, insecure?, fromName?, fromAddress? }
// If host is provided, an ad-hoc nodemailer transport is created from the body
// without touching the saved config — so admins can test BEFORE saving. If host
// is absent, falls back to the saved mail_config row.
import type { APIRoute } from 'astro';
import nodemailer from 'nodemailer';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { getMailboxAddress, getMailConfig, ensureMailSchema } from '@/lib/mail';
import { sendExternal } from '@/lib/mail-transport';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const to = (body.to || '').toString().trim();
  if (!/.+@.+\..+/.test(to)) return json({ ok: false, error: 'Enter a valid email address' }, 400);

  const userAddr = await getMailboxAddress(user.id);
  const inlineHost = (body.host || '').toString().trim();

  // Ad-hoc path: caller passed host/user/pass on the request — try those
  // directly without requiring a prior save. Fall back to saved password if
  // the inline pass is blank (so admins don't have to re-type it).
  if (inlineHost) {
    try {
      await ensureMailSchema();
      let inlinePass = (body.pass || '').toString();
      if (!inlinePass) {
        try {
          const r = rows(await db.execute(sql`SELECT smtp_pass FROM mail_config WHERE id = 1 LIMIT 1`))[0] as any;
          inlinePass = (r?.smtp_pass || '').toString();
        } catch (_) {}
      }
      const inlineUser = (body.user || '').toString().trim();
      const inlinePort = Number(body.port || 587);
      // Auto-correct the most common mis-config: port 587 ALWAYS uses STARTTLS
      // (secure:false), port 465 ALWAYS uses implicit TLS (secure:true). Other
      // ports honour the checkbox.
      const inlineSecure = inlinePort === 465 ? true : inlinePort === 587 ? false : !!body.secure;
      const inlineInsecure = !!body.insecure;
      const fromAddr = (body.fromAddress || '').toString().trim() || inlineUser || userAddr;
      const fromName = (body.fromName || '').toString().trim() || user.name || 'EduRankAI';

      const transport = nodemailer.createTransport({
        host: inlineHost,
        port: inlinePort,
        secure: inlineSecure,
        auth: inlineUser ? { user: inlineUser, pass: inlinePass } : undefined,
        tls: { rejectUnauthorized: !inlineInsecure },
        connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000,
      });
      const info = await transport.sendMail({
        from: `${fromName} <${fromAddr}>`,
        replyTo: userAddr, to,
        subject: 'EduRankAI mail test',
        html: `<div style="font-family:sans-serif"><h2>It works.</h2><p>Test email from ad-hoc config (not yet saved).</p><p>From: ${fromName} &lt;${fromAddr}&gt; · Reply-To: ${userAddr}</p></div>`,
        text: `It works. Test email from EduRankAI mail (ad-hoc), From: ${fromName} <${fromAddr}>, Reply-To: ${userAddr}.`,
      });
      return json({
        ok: true, provider: 'smtp', id: info.messageId,
        details: `Accepted by ${inlineHost} as ${fromAddr} → ${to}. Click "Save SMTP" to persist these values. If it isn't in the inbox in a minute, CHECK SPAM — without SPF/DKIM/DMARC on edurankai.in DNS, Gmail will often quarantine.`,
      });
    } catch (e: any) {
      const msg = (e?.message || 'send failed').toString();
      let hint: string | undefined;
      const low = msg.toLowerCase();
      if (low.includes('wrong version number') || low.includes('tlsv1') || low.includes('ssl routines')) hint = 'TLS mode mismatch. Port 587 uses STARTTLS — UNTICK "Use TLS/SSL" for port 587. Only tick it for port 465.';
      else if (low.includes('etimedout') || low.includes('econnrefused')) hint = 'Server did not respond — try port 587 (STARTTLS) or 465 (TLS). Confirm firewall allows outbound to the mail host.';
      else if (low.includes('self-signed') || low.includes('self signed') || low.includes('certificate')) hint = 'TLS certificate problem. Tick "Allow self-signed certs" and try again.';
      else if (low.includes('authentication') || low.includes('535') || low.includes('invalid login')) hint = 'Auth failed. For Office365 / GoDaddy use the FULL email as username and an app password if 2FA is on.';
      else if (low.includes('enotfound') || low.includes('getaddrinfo')) hint = 'Could not resolve host — check the spelling of the SMTP host.';
      return json({ ok: false, provider: 'smtp', error: msg, hint, from: (body.user || ''), to }, 502);
    }
  }

  // Saved-config path
  const cfg = await getMailConfig();
  if (cfg.source === 'none') {
    return json({ ok: false, error: 'No transport configured. Fill the SMTP host, username and password in the form above, then either click "Verify connection" or paste the values into Send test (it will use whatever is in the form, even before Save).' }, 400);
  }

  const fromAddr = cfg.fromAddress || cfg.smtpUser || userAddr;
  const fromName = cfg.fromName || user.name || 'EduRankAI';
  const result = await sendExternal({
    from: `${fromName} <${fromAddr}>`,
    replyTo: userAddr, to,
    subject: 'EduRankAI mail test',
    html: `<div style="font-family:sans-serif"><h2>It works.</h2><p>This is a test email from your EduRankAI mail system, sent via <b>${cfg.source === 'db' ? 'your saved settings' : 'environment config'}</b>.</p><p>From: ${fromName} &lt;${fromAddr}&gt; · Reply-To: ${userAddr}</p></div>`,
    text: `It works. Test email from EduRankAI mail, From: ${fromName} <${fromAddr}>, Reply-To: ${userAddr}.`,
  });

  if (result.ok) {
    return json({
      ok: true, provider: result.provider, id: result.id,
      details: `Accepted by ${cfg.smtpHost || 'transport'} as ${fromAddr} → ${to}. If it isn't in the inbox in a minute, CHECK SPAM. Without SPF/DKIM/DMARC on edurankai.in DNS, Gmail will often quarantine.`,
    });
  }
  return json({ ok: false, provider: result.provider, error: result.error || 'Send failed', from: fromAddr, to }, 502);
};
