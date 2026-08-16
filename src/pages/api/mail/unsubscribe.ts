// POST /api/mail/unsubscribe — one-click opt-out.
//
// THIS ENDPOINT IS DELIBERATELY THE LEAST CLEVER THING IN THE SYSTEM. It takes a contact id and that
// contact's own random token, and it stops the mail. No session, no CSRF token, no confirmation
// step, no rate limit that could refuse a real person.
//
//   * NO SESSION, because the recipient is almost never a user of this platform and demanding a
//     sign-in to stop marketing mail is both a dark pattern and a legal problem.
//   * NO CSRF TOKEN, because RFC 8058 one-click unsubscribe means the RECIPIENT'S MAIL PROVIDER
//     POSTS here on their behalf, with no page load and no cookie. A CSRF check would make the
//     header we advertise fail silently — and the provider would then judge us for advertising it.
//   * THE WORST A FORGED REQUEST CAN DO is unsubscribe somebody who did not ask. That is
//     recoverable by a human (unsuppress on the contact record) and is enormously less harmful than
//     an opt-out that does not work. Given a token that is a random uuid tied to one contact, a
//     forger already had to be handed the link.
//
// It answers 200 in HTML for a browser and JSON for a provider, so the same URL serves both.
import type { APIRoute } from 'astro';
import { unsubscribeByToken } from '@/lib/mail-campaigns';
import { dbReason } from '@/lib/mail-contacts';

function html(body: string, status = 200): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Email preferences</title>'
    + '<style>body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#1c1917}'
    + 'h1{font-size:1.35rem;margin:0 0 .5rem}p{margin:.5rem 0}a{color:#b45309}</style>' + body,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

function json(d: any, s = 200): Response {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

export const POST: APIRoute = async ({ request, url, clientAddress }) => {
  let contactId = url.searchParams.get('c') || '';
  let token = url.searchParams.get('t') || '';
  let campaignId = url.searchParams.get('k') || '';

  // A mail provider's one-click POST carries `List-Unsubscribe=One-Click` as a form body and keeps
  // the ids in the query string; our own page posts a form with all three fields. Read both.
  const contentType = String(request.headers.get('content-type') || '');
  if (contentType.includes('form') || contentType.includes('json')) {
    try {
      if (contentType.includes('json')) {
        const b = await request.json() as any;
        contactId = b?.c || b?.contactId || contactId;
        token = b?.t || b?.token || token;
        campaignId = b?.k || b?.campaignId || campaignId;
      } else {
        const fd = await request.formData();
        contactId = String(fd.get('c') || contactId);
        token = String(fd.get('t') || token);
        campaignId = String(fd.get('k') || campaignId);
      }
    } catch {
      // A body we could not read is not a reason to refuse — the query string may still carry them.
    }
  }

  const wantsHtml = String(request.headers.get('accept') || '').includes('text/html');

  try {
    const r = await unsubscribeByToken(contactId, token, campaignId || null, {
      ip: clientAddress || request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
    });
    if (!r.ok) {
      return wantsHtml
        ? html('<h1>That link did not work</h1><p>' + r.error + '</p>', 400)
        : json(r, 400);
    }
    const body = r.already
      ? '<h1>You are already unsubscribed</h1><p>' + r.email + ' is not on any of our mailing lists. Nothing further is needed.</p>'
      : '<h1>Unsubscribed</h1><p>' + r.email + ' has been removed from our mailing lists. It may take a few minutes for anything already in the queue to stop.</p>'
      + '<p>This does not affect messages about an application, an account or a payment you have with us — those are not marketing and are sent separately.</p>';
    return wantsHtml ? html(body) : json(r);
  } catch (e: any) {
    console.error('[api/mail/unsubscribe]', dbReason(e));
    const msg = 'Something went wrong on our side, so we could not complete that. Please reply to any message from us and we will remove you by hand.';
    return wantsHtml ? html('<h1>We could not do that</h1><p>' + msg + '</p>', 500) : json({ ok: false, error: msg }, 500);
  }
};

/** A GET here means somebody followed the link in a browser; hand them the confirmation page. */
export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.toString();
  return new Response(null, { status: 302, headers: { Location: '/mail/unsubscribe' + (q ? '?' + q : ''), 'cache-control': 'no-store' } });
};
