// POST /api/admin/applications/invite — create, re-send or withdraw an invitation to apply.
//
// WHY "RESEND" CREATES A NEW INVITATION RATHER THAN RE-SENDING THE OLD ONE. The token is stored as a
// hash and nothing else, so the original link is unrecoverable the moment the create response is
// gone from the administrator's screen. A "resend" that pretended otherwise would have to keep the
// plaintext somewhere, which is the one thing this module is built not to do. So resend issues a
// fresh invitation and withdraws the previous one, and says so.
//
// GATED AS `applications` EDIT, the same section that guards /admin/applications — an invitation can
// carry a fee waiver, which is a financial decision, and it puts our name in somebody's inbox.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { logAudit } from '@/lib/audit';
import { sendEmail, brandedEmail } from '@/lib/email';
import { sanitizeEmailHtmlString, htmlToPlainText, OUTBOUND } from '@/lib/mailsec/html';
import {
  parseInvite, createInvitation, revokeInvitation, recordSend, inviteUrl,
  ensureInvitationSchema, type CleanInvite, type Invitation,
} from '@/lib/hiring/invitations';
import { publicOrigin } from '@/lib/public-origin';

export const prerender = false;

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Escape before anything a person typed goes into an HTML email. */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The posting this invitation names, if it names one. Missing is allowed and means "any role". */
async function lookupRole(slug: string): Promise<{ id: string | null; title: string }> {
  if (!slug) return { id: null, title: '' };
  try {
    const r = await db.execute(sql`SELECT id, title FROM roles WHERE slug = ${slug} LIMIT 1`);
    const row = rows(r)[0];
    return row ? { id: String(row.id), title: String(row.title || '') } : { id: null, title: '' };
  } catch (e: any) {
    console.error('[invite] lookupRole:', e?.cause?.message || e?.message);
    return { id: null, title: '' };
  }
}

function invitationEmail(inv: Invitation, url: string, code: string, fromName: string): { subject: string; html: string; text: string } {
  const forRole = inv.roleTitle ? ' for ' + inv.roleTitle : '';
  const subject = inv.roleTitle
    ? 'You are invited to apply — ' + inv.roleTitle
    : 'You are invited to apply at EduRankAI';

  const greeting = inv.fullName ? 'Hello ' + esc(inv.fullName) + ',' : 'Hello,';
  const who = fromName ? esc(fromName) : 'Somebody on the team';

  const bodyParts = [
    '<p style="margin:0 0 14px;">' + greeting + '</p>',
    '<p style="margin:0 0 14px;">' + who + ' has invited you to apply' + esc(forRole) +
      ' at EduRankAI. Opening the link below takes you straight to the application.</p>',
  ];
  if (inv.note) {
    // SANITISED, NOT ESCAPED. esc() here meant an administrator who wrote or pasted formatted text
    // got their markup delivered as literal angle brackets in somebody's inbox. The note is now
    // written in a composer, so it goes through the same OUTBOUND profile every other outgoing body
    // uses - which strips script, style, iframes, event handlers and javascript: URLs, and is a
    // stricter control than escaping was, not a looser one.
    //
    // A div, not a p: the note may now hold block elements of its own, and a list inside a
    // paragraph is invalid markup that mail clients lay out inconsistently.
    bodyParts.push(
      '<div style="margin:0 0 14px;padding:12px 14px;background:#f6f5f1;border-left:3px solid #FF4F00;' +
      'border-radius:4px;">' + sanitizeEmailHtmlString(inv.note, OUTBOUND) + '</div>',
    );
  }
  if (inv.waiveFee) {
    bodyParts.push('<p style="margin:0 0 14px;">The application fee has been waived for you.</p>');
  }
  bodyParts.push(
    '<p style="margin:0 0 14px;">You still fill in the application and it is read by a person. An ' +
    'invitation is not an offer, and it does not decide the outcome.</p>',
  );
  // THE CODE IS IN THE MAIL, NOT ONLY THE LINK. A button is useless to somebody whose mail client
  // mangled it, or who read this on a phone and wants to apply on a laptop. Both open the same
  // invitation, so neither is a fallback for the other — they are two ways in.
  if (code) {
    bodyParts.push(
      '<p style="margin:18px 0 6px;font-size:13px;color:#555;">If the button does not work, go to ' +
      '<strong>' + esc(publicOrigin()) + '/invite</strong> and enter this code:</p>' +
      '<p style="margin:0 0 14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px;' +
      'font-weight:700;letter-spacing:0.06em;color:#0f0f14;background:#f6f5f1;border:1px solid rgba(0,0,0,0.08);' +
      'border-radius:8px;padding:12px 14px;text-align:center;">' + esc(code) + '</p>',
    );
  }

  const html = brandedEmail({
    preheader: 'An invitation to apply' + forRole + '.',
    heading: 'An invitation to apply',
    body: bodyParts.join(''),
    ctaText: 'Open the application',
    ctaUrl: url,
    footerNote:
      'This link is personal to you and stops working on ' +
      new Date(inv.expiresAt).toISOString().slice(0, 10) +
      '. EduRankAI is the technology platform; accredited partners award credentials. If you were ' +
      'not expecting this, you can ignore it and nothing happens.',
  });

  const text = [
    greeting,
    '',
    (fromName || 'Somebody on the team') + ' has invited you to apply' + forRole + ' at EduRankAI.',
    // The text part gets the same note with its markup flattened, rather than quoting raw source
    // back at a plain-text client.
    inv.note ? '\n"' + htmlToPlainText(inv.note) + '"\n' : '',
    inv.waiveFee ? 'The application fee has been waived for you.' : '',
    '',
    'Open the application: ' + url,
    code ? '\nOr go to ' + publicOrigin() + '/invite and enter this code: ' + code : '',
    '',
    'You still fill in the application and it is read by a person. An invitation is not an offer.',
    'This link stops working on ' + new Date(inv.expiresAt).toISOString().slice(0, 10) + '.',
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

async function issue(
  clean: CleanInvite,
  user: any,
  wantEmail: boolean,
): Promise<Response> {
  const role = await lookupRole(clean.roleSlug);
  const invitedByName = String(user?.name || user?.email || '').slice(0, 160);

  const created = await createInvitation({
    clean,
    roleId: role.id,
    roleTitle: role.title,
    invitedBy: user?.id ? String(user.id) : null,
    invitedByName,
  });
  if (!created.ok || !created.invitation || !created.token) {
    return json({ ok: false, error: created.error || 'The invitation could not be saved.' }, 500);
  }

  const url = inviteUrl(created.token);

  // THE SEND IS RECORDED AS WHAT IT ACTUALLY WAS. A failed send still returns ok:true with the link,
  // because the invitation exists and the administrator can pass the link on by hand — but the
  // screen is told the mail did not go, rather than being left to assume it did.
  let emailed = false;
  let emailError = '';
  if (wantEmail) {
    try {
      const msg = invitationEmail(created.invitation, url, created.code || '', invitedByName);
      const r = await sendEmail({ to: created.invitation.email, subject: msg.subject, html: msg.html, text: msg.text });
      emailed = r.ok;
      emailError = r.ok ? '' : (r.error || 'The mail server did not accept it.');
    } catch (e: any) {
      emailError = e?.cause?.message || e?.message || 'The mail server could not be reached.';
    }
    await recordSend(created.invitation.id, emailed, emailError);
  }

  await logAudit({
    userId: user?.id ? String(user.id) : null,
    action: 'application.invited',
    entity: 'application_invitation',
    entityId: created.invitation.id,
    diff: {
      email: created.invitation.email,
      role: created.invitation.roleSlug || '(any)',
      waiveFee: created.invitation.waiveFee,
      emailed,
    },
  });

  return json({
    ok: true,
    url,
    code: created.code || '',
    emailed,
    emailError,
    invitation: { ...created.invitation, emailSent: emailed, emailError },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { section: 'applications', action: 'edit', label: 'applications.invite' });
  if (denied) return denied;
  const user = (locals as any)?.user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request body.' }, 400); }

  const action = String(body.action || 'create');

  // Local development creates the table on demand; production has it from the hand-run .sql. A
  // failure here is not fatal to the request — the query below reports the real problem.
  try { await ensureInvitationSchema(); } catch { /* reported by the operation itself */ }

  if (action === 'revoke') {
    const id = String(body.id || '').trim();
    if (!id) return json({ ok: false, error: 'Which invitation?' }, 400);
    const done = await revokeInvitation(id, user?.id ? String(user.id) : null);
    if (done) {
      await logAudit({
        userId: user?.id ? String(user.id) : null,
        action: 'application.invitation_withdrawn',
        entity: 'application_invitation', entityId: id, diff: {},
      });
    }
    return json(done
      ? { ok: true, message: 'Invitation withdrawn. The link no longer works.' }
      : { ok: false, error: 'That invitation was already used, withdrawn or expired.' },
      done ? 200 : 409);
  }

  if (action === 'create' || action === 'resend') {
    const parsed = parseInvite(body);
    if ('error' in parsed) return json({ ok: false, error: parsed.error }, 400);
    return issue(parsed.value, user, body.sendEmail !== false);
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
