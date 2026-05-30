// POST /api/mail/test - send a one-off test email to verify the outbound transport.
import type { APIRoute } from 'astro';
import { getMailboxAddress, getMailConfig } from '@/lib/mail';
import { sendExternal } from '@/lib/mail-transport';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const to = (body.to || '').toString().trim();
  if (!/.+@.+\..+/.test(to)) return json({ ok: false, error: 'Enter a valid email address' }, 400);

  const cfg = await getMailConfig();
  if (cfg.source === 'none') return json({ ok: false, error: 'No transport configured. Add SMTP details or a Resend key first.' }, 400);

  const userAddr = await getMailboxAddress(user.id);
  // CRITICAL: GoDaddy/M365/most SMTP servers only let you send AS the
  // authenticated mailbox. If you send From a different address they accept
  // the message and silently drop it OR Gmail marks it as spam. So the From
  // address must default to the SMTP user, NOT the composer.
  const fromAddr = cfg.fromAddress || cfg.smtpUser || userAddr;
  const fromName = cfg.fromName || user.name || 'EduRankAI';
  const result = await sendExternal({
    from: `${fromName} <${fromAddr}>`,
    replyTo: userAddr,
    to,
    subject: 'EduRankAI mail test',
    html: `<div style="font-family:sans-serif"><h2>It works.</h2><p>This is a test email from your EduRankAI mail system, sent via <b>${cfg.source === 'db' ? 'your saved settings' : 'environment config'}</b>.</p><p>From: ${fromName} &lt;${fromAddr}&gt; · Reply-To: ${userAddr}</p></div>`,
    text: `It works. Test email from EduRankAI mail, From: ${fromName} <${fromAddr}>, Reply-To: ${userAddr}.`,
  });

  if (result.ok) {
    return json({
      ok: true,
      provider: result.provider,
      id: result.id,
      details: `Accepted by ${cfg.smtpHost || 'transport'} as ${fromAddr} -> ${to}. If it isn't in the inbox in a minute, CHECK SPAM. Without SPF/DKIM/DMARC on edurankai.in DNS, Gmail will often quarantine.`,
    });
  }
  return json({ ok: false, provider: result.provider, error: result.error || 'Send failed', from: fromAddr, to }, 502);
};
