// Cloudflare Email Worker — receives mail sent to @edurankai.in and forwards it
// into the EduRankAI mail system via the inbound webhook.
//
// Deploy (from this cloudflare/ folder):
//   npm install
//   npx wrangler secret put MAIL_INBOUND_SECRET   (paste the secret from /admin/mail/settings)
//   npx wrangler deploy
// Then in Cloudflare dashboard: Email > Email Routing > Routes > Catch-all
//   -> action "Send to a Worker" -> select this worker.
import PostalMime from 'postal-mime';

const WEBHOOK_URL = 'https://edurankai.in/api/mail/inbound';

export default {
  async email(message, env) {
    let parsed = {};
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (e) {
      parsed = {};
    }

    const payload = {
      to: message.to,                                   // the @edurankai.in recipient
      from: (parsed.from && parsed.from.address) || message.from,
      fromName: (parsed.from && parsed.from.name) || '',
      subject: parsed.subject || message.headers.get('subject') || '(no subject)',
      text: parsed.text || '',
      html: parsed.html || '',
      messageId: parsed.messageId || message.headers.get('message-id') || '',
      inReplyTo: parsed.inReplyTo || message.headers.get('in-reply-to') || '',
    };

    const resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mail-secret': env.MAIL_INBOUND_SECRET,
      },
      body: JSON.stringify(payload),
    });

    // If the app couldn't accept it, bounce so the sender knows (optional).
    if (!resp.ok) {
      message.setReject('Mailbox temporarily unavailable');
    }
  },
};
