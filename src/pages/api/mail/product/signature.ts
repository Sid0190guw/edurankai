// POST /api/mail/product/signature — this person's own signature.
//
// It writes through setSignature() in src/lib/mail-advanced.ts, which is the mail engine's own
// store and is what /api/mail/send reads when it appends one. No second table, no second idea of
// what a signature is.
//
// SANITISED WITH THE OUTBOUND PROFILE. A signature is authored here and rendered in somebody else's
// mail client, so it goes through the same allow-list as everything else this system sends.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { setSignature } from '@/lib/mail-advanced';
import { sanitizeEmailHtmlString, OUTBOUND } from '@/lib/mailsec/html';
import { json, fail, reasonOf } from '@/lib/mail-product/common';

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.signature' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return fail('The request body was not valid JSON.'); }

  const raw = String(body.html ?? '').slice(0, 20000);
  const html = sanitizeEmailHtmlString(raw, OUTBOUND);
  const on = !!body.on;

  try {
    await setSignature(user.id, html, on);
    return json({
      ok: true,
      html,
      // Said, rather than left to be discovered when the signature arrives looking different.
      changed: html !== raw
        ? 'Some markup was removed because it is not safe to send. The text is unchanged.'
        : null,
    });
  } catch (e: any) {
    console.error('[api/mail/product/signature] save failed:', reasonOf(e));
    return fail('Your signature was NOT saved, and the previous one is still in use: ' + reasonOf(e), 500);
  }
};
