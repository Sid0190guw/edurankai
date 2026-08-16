// POST /api/mail/send - compose / reply / forward. Internal delivery + external via SMTP/Resend.
// Supports the @group:slug token in To/Cc/Bcc — see /lib/mail-groups.ts.
// Groups marked hidden_recipients=true ALWAYS route to BCC so members never
// see each other's addresses.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { deliverMessage, parseAddressList, getMailboxAddress, logOutbound, getMailConfig, deliveryWording, type DeliveryStatus } from '@/lib/mail';
import { sendExternal } from '@/lib/mail-transport';
import { expandGroupTokens } from '@/lib/mail-groups';
import { getSignature, scheduleMessage, rewriteLinksForTracking } from '@/lib/mail-advanced';
import { describeLinkList } from '@/lib/mail-links';
import { denyMailApi } from '@/lib/auth/mail-access';
// Rate ceilings, recipient caps, suppression and HTML sanitisation, in one call. See the block
// above guardOutboundSend() below for why it runs where it runs.
import { guardOutboundSend } from '@/lib/mailsec/sending';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function escapeHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// The real Postgres reason lives on e.cause; e.message is only the SQL that failed. Declared above
// the handler on purpose — `const` is not hoisted and that has taken pages down here before.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, locals }) => {
  // `if (!user) return 401` was the ENTIRE gate on sending mail from the company mailbox to
  // arbitrary external addresses — so any signed-in account, including an applicant, could send as
  // EduRankAI, and could expand `@group:slug` tokens that resolve internal distribution lists.
  //
  // The one thing in the product that calls this is the composer in src/components/MailClient.astro,
  // which used to be rendered by exactly one page: /admin/mail. So canOpenAdmin (through
  // denyAdminApi) was the gate that surface already had. Mail is deliberately absent from
  // PATH_SECTION (middleware.ts:46-47 calls it a universal path), so there is no section key to ask
  // for; that omission is what left this URL with nothing at all in front of it.
  //
  // THE GATE NOW ASKS THE MAILBOX QUESTION, NOT THE CONSOLE QUESTION. MailClient is mounted at a
  // second surface — /portal/employee/mail — and "may you open the admin console" is the wrong
  // question to put in front of an employee's own outbox. canUseMailbox() still contains
  // canOpenAdmin() as one of its three arms, so nobody who could compose before loses the ability;
  // it adds the internal roles that already send through /api/mail/test and anyone with an active
  // employee record. See the header of src/lib/auth/mail-access.ts for exactly what moved.
  const denied = await denyMailApi(locals, { label: 'mail.send' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  // Pull tokens BEFORE parseAddressList strips display names — so we can spot
  // @group:slug entries that wouldn't match the email regex.
  function splitTokens(input: any): string[] {
    if (!input) return [];
    const raw = Array.isArray(input) ? input.join(',') : String(input);
    return raw.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
  const toTokens = splitTokens(body.to);
  const ccTokens = splitTokens(body.cc);
  const bccTokens = splitTokens(body.bcc);

  // Expand @group:slug tokens. Hidden-recipient groups go into BCC regardless
  // of which field the token was placed in.
  const expanded = await expandGroupTokens({ to: toTokens, cc: ccTokens, bcc: bccTokens });
  // A NAMED GROUP THAT RESOLVED TO NOBODY IS NOT A RECIPIENT LIST THAT SHRANK QUIETLY.
  // expandGroupTokens() used to delete an unrecognised `@group:slug` token and carry on, so a
  // mistyped list plus one ordinary address sent to that one address and answered "Sent". Refused
  // before anything is written: the message is still in the composer and the operator is told which
  // name did not resolve.
  if (expanded.unknownGroups.length) {
    return json({
      ok: false,
      error: 'No distribution list is called ' + expanded.unknownGroups.map((g) => '@group:' + g).join(' or ')
        + '. Nothing has been sent. Check the slug on /admin/mail/groups.',
    }, 400);
  }
  let to = parseAddressList(expanded.to);
  let cc = parseAddressList(expanded.cc);
  let bcc = parseAddressList(expanded.bcc);
  if (to.length + cc.length + bcc.length === 0) return json({ ok: false, error: 'at least one recipient required' }, 400);

  let subject = (body.subject || '').toString().slice(0, 500);
  let bodyText = (body.bodyText ?? body.body ?? '').toString();
  if (bodyText.length > 100000) return json({ ok: false, error: 'message too long' }, 400);
  let bodyHtml = (body.bodyHtml || '').toString();
  if (!bodyHtml) bodyHtml = '<div>' + escapeHtml(bodyText).replace(/\n/g, '<br/>') + '</div>';
  if (!bodyText) bodyText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // ATTACHMENTS ARE LINKS — there is no upload path in mail and there never was one (no
  // multipart parse, no blob write, nothing in mail_attachments but a URL). describeLink() is the
  // authority on the name and the type, so a hand-crafted POST cannot label a link as something it
  // is not, and a link we refuse is REPORTED rather than quietly dropped from the message.
  const linkList = describeLinkList(body.attachments);
  if (linkList.rejected.length) {
    return json({
      ok: false,
      error: 'That attachment is not a link: ' + linkList.rejected[0].reason,
      rejectedAttachments: linkList.rejected,
    }, 400);
  }
  const attachments = linkList.attachments.map((a) => ({ filename: a.filename, url: a.url, mime: a.mime }));

  // Append the composer's signature (unless this is a no-signature send).
  if (body.signature !== false) {
    try {
      const sig = await getSignature(user.id);
      if (sig.on && sig.html) {
        bodyHtml = bodyHtml + '<br/><br/><div class="era-sig">' + sig.html + '</div>';
        bodyText = bodyText + '\n\n' + sig.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    } catch (e: any) {
      // Still tolerated — a missing signature must not stop a message leaving — but no longer
      // silent. The real Postgres reason is on e.cause; e.message is only the failed SQL.
      console.error('[api/mail/send] signature', e?.cause?.message || e?.message);
    }
  }

  // ═══ THE SENDING RULES, IN ONE CALL, AFTER THE MESSAGE IS FULLY ASSEMBLED ═══
  //
  // Until now this endpoint had NO volume control of any kind: no per-account rate limit, no cap on
  // recipients per message, no daily ceiling, and — the one that actually cost something — no
  // suppression check. `mail_suppression` is the table /api/mail/unsubscribe writes to and the
  // campaign path (src/lib/mail-recipients.ts) has enforced all along; this path never read it. So
  // an address that hard-bounced, reported us for spam, or clicked unsubscribe was still deliverable
  // from the composer. Two send paths, one of them following the rules.
  //
  // AFTER the signature, deliberately. The signature is HTML this endpoint appends on the sender's
  // behalf, and a body that is sanitised before something else is glued onto it has been sanitised
  // for nothing.
  //
  // TRANSACTIONAL IS DECIDED BY THE SHAPE OF THE SEND, NOT BY A REQUEST FIELD a caller could set.
  // A directly-addressed message is a person writing to a person: a bounce or a complaint still
  // blocks it, an unsubscribe does not, because unsubscribing from a mailing list is not a request
  // to stop receiving a reply. The moment a `@group:` list is expanded it is a mailing, and every
  // suppression reason applies.
  const guard = await guardOutboundSend({
    userId: user.id,
    to, cc, bcc,
    subject,
    bodyHtml,
    inReplyTo: body.inReplyTo || null,
    transactional: expanded.expandedGroups.length === 0,
  });
  if (!guard.allowed) {
    // 429 when it is a ceiling (retry later), 400 when it is the message itself (retrying will not
    // help). The composer shows `error` verbatim, so it has to be a sentence, not a code.
    const isCeiling = /limit|faster than|resets in/i.test(guard.error || '');
    return json({ ok: false, error: guard.error, droppedRecipients: guard.dropped }, isCeiling ? 429 : 400);
  }
  to = guard.to; cc = guard.cc; bcc = guard.bcc;
  subject = guard.subject;
  // The stored body and the sent body must be the same bytes: /api/mail/click proves a click is
  // legitimate by looking the destination up in the STORED body, so a body that is sanitised on the
  // way out but not on the way in would start refusing its own links.
  bodyHtml = guard.bodyHtml;

  // Scheduled send: stash it and return; the scheduled-send cron delivers it.
  const schedRaw = body.scheduledAt ? new Date(body.scheduledAt) : null;
  if (schedRaw && !isNaN(schedRaw.getTime()) && schedRaw.getTime() > Date.now() + 30000) {
    try {
      const sid = await scheduleMessage({ userId: user.id, to, cc, bcc, subject, bodyHtml, bodyText, threadId: body.threadId || null, inReplyTo: body.inReplyTo || null, scheduledAt: schedRaw });
      return json({ ok: true, scheduled: true, scheduledId: sid, scheduledAt: schedRaw.toISOString() });
    } catch (e: any) {
      console.error('[api/mail/send] schedule failed:', reasonOf(e));
      return json({ ok: false, error: 'This message was NOT scheduled and has not been saved: ' + reasonOf(e) }, 500);
    }
  }

  try {
    const fromEmail = await getMailboxAddress(user.id);
    const fromName = user.name || fromEmail;

    const result = await deliverMessage({
      fromUserId: user.id, fromEmail, fromName,
      to, cc, bcc, subject, bodyHtml, bodyText,
      threadId: body.threadId || null,
      inReplyTo: body.inReplyTo || null,
      attachments,
    });

    // Delete the draft this was sent from. The composer now SENDS draftId (it never used to), so
    // "save draft, then send" stops leaving a permanent twin of the message sitting in Drafts.
    //
    // BOTH statements name the owner. The second one did not: `WHERE id = <draftId> AND is_draft`
    // matched any account's draft, and mail_box cascades off mail_messages, so posting somebody
    // else's draft id as `draftId` on a send of your own deleted THEIR unsent message. Same defect,
    // same fix, as /api/mail/draft.ts — kept identical on purpose so the two cannot drift.
    if (body.draftId) {
      try {
        await db.execute(sql`DELETE FROM mail_box WHERE user_id = ${user.id} AND message_id = ${body.draftId} AND folder = 'drafts'`);
        await db.execute(sql`DELETE FROM mail_messages WHERE id = ${body.draftId} AND is_draft = true AND from_user_id = ${user.id}`);
      } catch (e: any) {
        // The message HAS been sent by this point; a stranded draft is a nuisance, not a loss, and
        // must not turn a successful send into a failure. Logged, never silent.
        console.error('[api/mail/send] draft cleanup failed:', reasonOf(e));
      }
    }

    // External delivery
    if (result.external.length) {
      const extTo = result.external.filter(e => e.kind === 'to').map(e => e.email);
      const extCc = result.external.filter(e => e.kind === 'cc').map(e => e.email);
      const extBcc = result.external.filter(e => e.kind === 'bcc').map(e => e.email);
      // The SMTP server typically only allows sending AS the authenticated
      // mailbox, so use the configured From address (fallback to SMTP user);
      // set Reply-To to the actual composer so replies route back to them.
      const cfg = await getMailConfig();
      const envFromAddr = cfg.fromAddress || cfg.smtpUser || fromEmail;
      const envFrom = `${cfg.fromName || fromName} <${envFromAddr}>`;
      // Inject a 1x1 read-receipt pixel before sending so we know when the
      // recipient opens. Inserted at the bottom of the HTML so it loads after
      // body content; falls through silently if their client blocks images.
      const trackingPixel = `<img src="https://edurankai.in/api/mail/track/${result.messageId}.gif" width="1" height="1" alt="" style="display:none;border:0;width:1px;height:1px;" />`;
      // Rewrite links through the click redirector so opens AND clicks are measured.
      const htmlTracked = rewriteLinksForTracking(bodyHtml || '', result.messageId);
      const htmlWithPixel = htmlTracked + trackingPixel;
      const send = await sendExternal({
        from: envFrom,
        to: extTo.length ? extTo : (extCc[0] ? extCc : extBcc),
        cc: extCc, bcc: extBcc,
        subject, html: htmlWithPixel, text: bodyText,
        replyTo: fromEmail,
        messageId: result.rfcMessageId,
        inReplyTo: body.inReplyTo || undefined,
        // Link attachments travel as links in the body; nodemailer must not try to fetch and
        // embed them, which is what `path` did — a private document link fetched by the server
        // becomes a 0-byte "attachment" named after a query string.
        attachments: [],
        // We log one row PER RECIPIENT below, which is the granularity the thread badge and
        // /admin/mail/analytics both read. Letting the transport log a second row per send would
        // double every status count on that page.
        logToDb: false,
      });
      // ONE ROW PER EXTERNAL RECIPIENT, keyed by the mail_messages UUID — which is what the
      // reading pane looks the delivery state up by. The rfc id goes in its own column.
      for (const e of result.external) {
        try {
          await logOutbound({
            messageId: result.messageId, rfcMessageId: result.rfcMessageId,
            to: e.email, from: fromEmail, subject,
            status: send.ok ? 'sent' : (send.provider === 'none' ? 'no_transport' : 'failed'),
            provider: send.provider, error: send.error,
          });
        } catch (le: any) {
          // A lost log line means the thread will say "Delivery unknown" — which is the honest
          // answer when we cannot prove delivery. It must never say "Delivered" instead.
          console.error('[api/mail/send] delivery log failed:', reasonOf(le));
        }
      }
      // Mark the message as outbound now it has left the platform. Best-effort ON PURPOSE - the
      // mail has already gone and refusing the response would tell the sender it had not - but not
      // SILENT: `direction` is what /admin/mail/analytics filters every campaign figure on and what
      // decides which folder the copy sits in, so a row stuck on the wrong side is a sent message
      // that no report can see, and `.catch(() => {})` left no line anywhere saying why.
      await db.execute(sql`UPDATE mail_messages SET direction = 'outbound' WHERE id = ${result.messageId}`)
        .catch((de: any) => console.error('[api/mail/send] outbound flag not set for ' + result.messageId + ':', reasonOf(de)));

      const status: DeliveryStatus = {
        state: send.ok ? 'sent' : (send.provider === 'none' ? 'no_transport' : 'failed'),
        externalCount: result.external.length,
        sent: send.ok ? result.external.length : 0,
        failed: send.ok ? 0 : result.external.length,
        provider: send.provider,
        error: send.error || null,
      };
      return json({
        ok: true,
        threadId: result.threadId,
        messageId: result.messageId,
        // An EXISTING group with no members is not an error - the message still went to everyone
        // else named - but it must be said, because "it went to the list" is what the sender
        // otherwise assumes.
        // What the sending rules removed or rewrote. Said out loud on a SUCCESSFUL send too: a
        // composer that quietly drops a suppressed recipient is a composer whose sender believes
        // the message reached somebody it did not.
        sendingNotices: guard.warnings.length ? guard.warnings : null,
        droppedRecipients: guard.dropped.length ? guard.dropped : null,
        groupWarning: expanded.emptyGroups.length
          ? expanded.emptyGroups.map((g) => '@group:' + g).join(' and ') + ' has no members, so nobody received it through that list.'
          : null,
        delivery: { ...status, ...deliveryWording(status) },
        // kept for any older caller reading this shape
        external: { attempted: result.external.length, delivered: send.ok, provider: send.provider, error: send.error },
      });
    }

    const internal: DeliveryStatus = { state: 'internal', externalCount: 0, sent: 0, failed: 0, provider: null, error: null };
    return json({
      ok: true, threadId: result.threadId, messageId: result.messageId,
      sendingNotices: guard.warnings.length ? guard.warnings : null,
      droppedRecipients: guard.dropped.length ? guard.dropped : null,
      groupWarning: expanded.emptyGroups.length
        ? expanded.emptyGroups.map((g) => '@group:' + g).join(' and ') + ' has no members, so nobody received it through that list.'
        : null,
      delivery: { ...internal, ...deliveryWording(internal) },
    });
  } catch (e: any) {
    // NEVER SWALLOWED, AND NEVER SOFTENED. If this throws, the message did not go: say so in the
    // words the composer will show, and log the real Postgres reason rather than the failed SQL.
    console.error('[api/mail/send] send failed:', reasonOf(e));
    return json({ ok: false, error: 'This message was NOT sent: ' + reasonOf(e) }, 500);
  }
};
