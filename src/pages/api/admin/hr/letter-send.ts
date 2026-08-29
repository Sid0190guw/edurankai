// POST /api/admin/hr/letter-send — email an HR letter to the person it is about.
//
// =================================================================================================
// WHY AN ENDPOINT AND NOT A FORM POST ON THE PAGE
// =================================================================================================
//
// /admin/hr/recommendation and /admin/hr/offboarding compose the letter ENTIRELY IN THE BROWSER:
// every field is a plain input with no server binding, and the preview is built by the page's own
// refresh(). A form POST therefore reloads the page onto an empty form — the operator sends the
// letter, the screen blanks, and if the send failed (a typo in the address, SMTP refusing) every
// field they filled in is gone and the letter has to be typed again to retry.
//
// So the send is a fetch and the page never navigates. The letter stays on screen, the result
// appears beside the button, and a failure is one correction away from a retry rather than a
// re-entry. No-JS is not a lost case here: with JavaScript off those pages render no letter at all,
// so there is nothing for a fallback to submit.
//
// The offer letter at /admin/applications/[id]/offer-letter keeps its form POST, deliberately — that
// page re-renders from offer_letters, so a reload loses nothing.
//
// =================================================================================================
// WHAT THIS ROUTE IS AND IS NOT
// =================================================================================================
//
// It is a thin door. Every decision about what a letter email may contain lives in
// src/lib/hr/letter-mail.ts, which is pure and tested; this file authenticates, reads JSON, and
// reports. It holds no template, no sanitiser and no copy of the letter types.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { sendLetterEmail, LETTER_TYPES, MAX_LETTER_HTML, MAX_NOTE_HTML } from '@/lib/hr/letter-mail';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function str(v: unknown, cap = 300): string {
  return String(v ?? '').trim().slice(0, cap);
}

export const POST: APIRoute = async ({ request, locals }) => {
  // THE SAME KEY THE PAGES GATE THEIR BUTTON ON, asked again here because a disabled button is a
  // courtesy and this is the lock. denyAdminApi also consults the custom-role registry, so a role
  // created in the admin panel and granted `employee.manage` works without a code change.
  const denied = await denyAdminApi(locals, { permission: 'employee.manage', label: 'hr.letter.send' });
  if (denied) return denied;

  const user = (locals as any)?.user;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: 'That request was not readable, so nothing was sent.' }, 400);
  }

  const typeKey = str(body?.typeKey, 60);
  if (!LETTER_TYPES[typeKey]) {
    return json({ ok: false, message: 'That letter type is not one this desk can send, so nothing was sent.' }, 400);
  }

  const letterHtml = String(body?.letterHtml ?? '');
  const noteHtml = String(body?.noteHtml ?? '');

  // REFUSED HERE AS WELL AS INSIDE THE LIBRARY, because this is the boundary a hand-built request
  // arrives at and the size checks are the ones that protect the SMTP transport's send budget.
  if (letterHtml.length > MAX_LETTER_HTML) {
    return json({ ok: false, message: 'That letter is larger than a letter should be, so nothing was sent.' }, 413);
  }
  if (noteHtml.length > MAX_NOTE_HTML) {
    return json({ ok: false, message: 'That covering message is too long to send. Shorten it and try again.' }, 413);
  }
  // The letter IS the message on these two surfaces. Sending the covering note alone would deliver
  // an empty document under a subject line promising one.
  if (!letterHtml.trim() && !str(body?.letterUrl, 400)) {
    return json({ ok: false, message: 'The letter did not reach the server, so nothing was sent. Reload the page and try again.' }, 400);
  }

  const out = await sendLetterEmail({
    actorUserId: user?.id ? String(user.id) : null,
    typeKey,
    noteHtml,
    letterHtml,
    ctx: {
      recipientName: str(body?.recipientName),
      recipientEmail: str(body?.recipientEmail, 254),
      roleTitle: str(body?.roleTitle),
      department: str(body?.department),
      refNumber: str(body?.refNumber, 64),
      issueDate: str(body?.issueDate, 40),
      signatoryName: str(body?.signatoryName),
      signatoryTitle: str(body?.signatoryTitle),
      letterUrl: str(body?.letterUrl, 400) || undefined,
    },
  });

  // 200 EITHER WAY, WITH ok:false ON A REFUSAL. The request was understood and acted on; what
  // failed is the mail server, and the page needs the sentence rather than a status code it would
  // have to translate. sendLetterEmail never throws, so there is no third outcome.
  return json({ ok: out.sent, message: out.message, removed: out.removed });
};
