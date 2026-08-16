// GET  /api/v1/email/unsubscribe/<messageId>?r=<base64url address>&s=<signature> — the page.
// POST same URL — RFC 8058 one-click, fired by the recipient's mail client. Unsubscribes immediately.
//
// GET DOES NOT UNSUBSCRIBE ANYBODY. Mail clients, security scanners and link previewers fetch every
// URL in a message; a GET that changed state would silently opt people out of mail they still want,
// and there would be no way to tell that from a real click. The GET shows a page with a button; the
// POST is the action. The one exception is the mail client's own one-click button, which sends a
// POST — exactly the shape RFC 8058 defines for this.
//
// AN UNSUBSCRIBE IS HONOURED EVEN WHEN THE PAGE FAILS TO SAY SO. The suppression write happens first
// and the confirmation is rendered from its result.
import type { APIRoute } from 'astro';
import { verifyParts, b64urlDecode } from '@/lib/mailapi/tracking';
import { getMessage, recordEventById } from '@/lib/mailapi/messages';
import { suppress } from '@/lib/mailapi/suppression';
import { mirrorSuppression } from '@/lib/mailapi/bridge';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const SECRET = String(process.env.MAILAPI_TRACK_SECRET || process.env.SESSION_SECRET || '').trim();

function page(title: string, body: string, status = 200): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title>' +
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1a1712;background:#fbfaf4;">' +
    body +
    '</body>',
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } },
  );
}

function check(id: string, encoded: string, sig: string): { ok: boolean; recipient: string } {
  const recipient = b64urlDecode(encoded).toLowerCase();
  if (!SECRET || !id || !recipient) return { ok: false, recipient };
  return { ok: verifyParts(SECRET, sig, 'unsub', id, recipient), recipient };
}

async function doUnsubscribe(id: string, recipient: string): Promise<boolean> {
  const message = await getMessage(id);
  if (!message) return false;
  const done = await suppress({
    orgId: message.orgId, environment: message.environment, email: recipient,
    reason: 'unsubscribe', source: 'one-click', detail: 'message ' + id,
  });
  await recordEventById(id, 'email.unsubscribed', { recipient, data: { method: 'one-click' } }).catch(() => {});
  // Mirrored to the campaign platform, so "stop mailing me" means everything and not just the kind of
  // message this link happened to be attached to.
  try {
    const r: any = await db.execute(sql`SELECT mp_org_id FROM mailapi_orgs WHERE id = ${message.orgId} LIMIT 1`);
    const mpOrgId = (Array.isArray(r) ? r : r?.rows || [])[0]?.mp_org_id || null;
    await mirrorSuppression(mpOrgId, recipient, 'unsubscribe', 'transactional one-click');
  } catch (e: any) {
    console.error('[mailapi] could not mirror the unsubscribe to the campaign platform:', e?.cause?.message || e?.message);
  }
  return done;
}

export const GET: APIRoute = async ({ params, url }) => {
  const id = String(params.id || '').trim();
  const { ok, recipient } = check(id, url.searchParams.get('r') || '', url.searchParams.get('s') || '');
  if (!ok) {
    return page('Link not verified',
      '<h1 style="font-size:1.25rem;margin:0 0 .5rem;">This unsubscribe link could not be verified</h1>' +
      '<p style="color:#57534e;line-height:1.7;">Open the original message and use the link there. If you keep receiving mail you did not ask for, reply to the message and we will stop it by hand.</p>', 400);
  }
  return page('Unsubscribe',
    '<h1 style="font-size:1.35rem;margin:0 0 .5rem;">Stop sending to ' + escapeHtml(recipient) + '?</h1>' +
    '<p style="color:#57534e;line-height:1.7;">You will no longer receive messages of this kind. Account and security messages, such as a password reset you request yourself, are still delivered.</p>' +
    '<form method="post" style="margin-top:1.5rem;">' +
    '<button type="submit" style="background:#1a1712;color:#fbfaf4;border:0;border-radius:8px;padding:.75rem 1.5rem;font-size:.95rem;font-weight:600;cursor:pointer;">Unsubscribe</button>' +
    '</form>');
};

export const POST: APIRoute = async ({ params, url, request }) => {
  const id = String(params.id || '').trim();
  const { ok, recipient } = check(id, url.searchParams.get('r') || '', url.searchParams.get('s') || '');
  if (!ok) return page('Link not verified', '<p style="color:#57534e;">This unsubscribe link could not be verified.</p>', 400);

  let done = false;
  try {
    done = await doUnsubscribe(id, recipient);
  } catch (e: any) {
    console.error('[mailapi] unsubscribe failed for ' + id + ':', e?.cause?.message || e?.message);
  }

  // A mail client firing List-Unsubscribe-Post wants a status code, not a page.
  const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
  if (!wantsHtml) {
    return new Response(JSON.stringify({ unsubscribed: done, email: recipient }), {
      status: done ? 200 : 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  return done
    ? page('Unsubscribed',
        '<h1 style="font-size:1.35rem;margin:0 0 .5rem;">Done</h1>' +
        '<p style="color:#57534e;line-height:1.7;">We have stopped sending this kind of message to ' + escapeHtml(recipient) + '.</p>')
    : page('Not completed',
        '<h1 style="font-size:1.35rem;margin:0 0 .5rem;">That did not go through</h1>' +
        '<p style="color:#57534e;line-height:1.7;">Nothing was changed. Please reply to the message you received and we will stop it by hand.</p>', 500);
};

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}
