// GET /api/v1/email/track/click/<messageId>?u=<base64url target>&s=<signature>
//
// PUBLIC BY NECESSITY, AND SIGNED FOR EXACTLY THAT REASON. The signature covers the message id AND
// the destination together, so neither can be swapped independently. Without that this endpoint is
// an open redirect wearing our domain — anyone could mail a link to /track/click?u=<phishing page>
// and inherit our reputation for it. An unsigned or altered target is refused, not followed.
//
// A tracking failure never costs the recipient their click: if the event cannot be recorded, the
// redirect still happens.
import type { APIRoute } from 'astro';
import { verifyParts, b64urlDecode } from '@/lib/mailapi/tracking';
import { recordEventById } from '@/lib/mailapi/messages';

const SECRET = String(process.env.MAILAPI_TRACK_SECRET || process.env.SESSION_SECRET || '').trim();

function refuse(reason: string): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Link not verified</title>' +
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#1a1712;">' +
    '<h1 style="font-size:1.25rem;margin:0 0 .5rem;">This link could not be verified</h1>' +
    '<p style="color:#57534e;line-height:1.6;">' + reason + ' For your safety it was not followed. If you received this link in an email from us, open the message again and use the link there.</p>' +
    '</body>',
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

export const GET: APIRoute = async ({ params, url, request, clientAddress }) => {
  const id = String(params.id || '').trim();
  const encoded = url.searchParams.get('u') || '';
  const sig = url.searchParams.get('s') || '';
  const target = b64urlDecode(encoded);

  if (!SECRET) return refuse('Link signing is not configured on this deployment.');
  if (!id || !target) return refuse('The link is incomplete.');
  if (!verifyParts(SECRET, sig, 'click', id, target)) return refuse('Its signature does not match the destination.');

  let destination: URL;
  try {
    destination = new URL(target);
  } catch {
    return refuse('The destination is not a valid address.');
  }
  // Signed or not, only ordinary web links are followed. A `javascript:` or `data:` destination that
  // somehow acquired a valid signature would still be a scripting vector in the recipient's browser.
  if (destination.protocol !== 'https:' && destination.protocol !== 'http:') {
    return refuse('Only http and https links are followed.');
  }

  try {
    await recordEventById(id, 'email.clicked', {
      data: {
        url: destination.toString(),
        user_agent: (request.headers.get('user-agent') || '').slice(0, 300),
        ip: (request.headers.get('x-forwarded-for') || clientAddress || '').toString().split(',')[0].trim().slice(0, 64) || null,
      },
      dedupeWindowSec: 5,
    });
  } catch (e: any) {
    console.error('[mailapi] click tracking failed for ' + id + ':', e?.cause?.message || e?.message);
  }

  return new Response(null, { status: 302, headers: { Location: destination.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
};
