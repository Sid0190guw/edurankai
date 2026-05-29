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

  const fromAddr = await getMailboxAddress(user.id);
  const fromName = cfg.fromName || user.name || 'EduRankAI';
  const result = await sendExternal({
    from: `${fromName} <${fromAddr}>`,
    to,
    subject: 'EduRankAI mail test',
    html: `<div style="font-family:sans-serif"><h2>It works.</h2><p>This is a test email from your EduRankAI mail system, sent via <b>${cfg.source === 'db' ? 'your saved settings' : 'environment config'}</b>.</p><p>Sent by ${fromName} (${fromAddr}).</p></div>`,
    text: `It works. Test email from EduRankAI mail, sent by ${fromName} (${fromAddr}).`,
    replyTo: fromAddr,
  });

  if (result.ok) return json({ ok: true, provider: result.provider, id: result.id });
  return json({ ok: false, provider: result.provider, error: result.error || 'Send failed' }, 502);
};
