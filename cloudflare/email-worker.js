// Cloudflare Email Worker — forwards mail sent to @edurankai.in into the
// EduRankAI mail system. No npm packages needed: it just streams the raw message
// to the app, which parses it. You can paste this straight into the Cloudflare
// dashboard (Email > Email Routing > Email Workers > Create).
//
// Set a variable/secret named MAIL_INBOUND_SECRET on the Worker, matching the
// secret shown in /admin/mail/settings.
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).text();
    const resp = await fetch('https://edurankai.in/api/mail/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'x-mail-secret': env.MAIL_INBOUND_SECRET,
        'x-mail-to': message.to,
        'x-mail-from': message.from,
      },
      body: raw,
    });
    if (!resp.ok) {
      message.setReject('Mailbox temporarily unavailable');
    }
  },
};
