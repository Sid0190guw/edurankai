// POST /api/help/start - get or create a help conversation for the current visitor.
// Sets a long-lived era_help_session cookie if missing. Optional initial message.
//
// TWO THINGS WERE WRONG HERE, AND BOTH ENDED WITH A MEMBER OF THE PUBLIC WAITING FOR AN ANSWER THAT
// NOBODY KNEW THEY HAD ASKED FOR.
//
// 1. A MESSAGE INTO A CLOSED CONVERSATION VANISHED. This appended `initialMessage` to whatever
//    conversation the cookie pointed at, whatever its status, and bumped unread_admin. But
//    /admin/help lists `status = 'open'` by default (api/admin/help/list.ts), so a message written
//    into a closed conversation was invisible on the inbox anybody actually opens. The visitor,
//    meanwhile, cannot escape: /api/help/send.ts matches on `status = 'open'` and refuses, and this
//    endpoint only mints a NEW conversation when the token matches NO row - so a person whose chat
//    was closed had exactly one route to support left and it silently discarded everything they
//    wrote. A visitor writing again REOPENS the conversation now. That is not new authority: it is
//    the inverse of the Close button an agent already holds, it is what /api/admin/help/reply.ts's
//    `reopen` does from the other side, and the alternative is a support channel that swallows mail.
//
// 2. EVERY WAY OF TELLING STAFF WAS WRAPPED IN A BARE CATCH. Push, email and the in-app notifier
//    each failed in total silence, so a broken SMTP password or an absent VAPID key meant help chats
//    piled up unseen with nothing anywhere recording that the alert had been attempted. They are
//    still best-effort - a failed notification must never lose the visitor's message, which IS
//    saved by then - but the reason now reaches the log, which is the difference between a fault
//    somebody can find and one nobody can.
//
// The catch-all also stopped handing the caller `e.message`: that is the failed SQL, which describes
// this schema to an anonymous visitor and tells them nothing they can act on.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { clientIp, overPublicFormLimit } from '@/lib/public-form-limit';
import { logEvent } from '@/lib/logger';

// Declared above the handler that uses them: `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
const COOKIE_NAME = 'era_help_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days

function json(d: any, s = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  });
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  // COUNTED FIRST, before any of the work below, because the work is what costs.
  //
  // This route is unauthenticated by design and the conversation is keyed on a cookie the caller
  // controls, so omitting the cookie mints a fresh help_conversations row every time — there is
  // nothing to reuse and so nothing that bounds it. With initialMessage set, one anonymous request
  // also fans a web push out to every admin device and sends one mail through the site's OWN SMTP
  // identity — the same identity that carries campaigns, transactional mail and password recovery.
  // That is the one cost here that outlives a code fix: rows can be deleted and a bill can be
  // capped, but a sending domain that gets blocklisted stays blocklisted for days of delisting work.
  //
  // Fails CLOSED for that reason. Dropping a help chat during a database hiccup is recoverable —
  // the page shows the direct address — and running an unmetered mail relay is not.
  const limit = await overPublicFormLimit('help-start', clientIp(request.headers), { whenUnavailable: 'refuse' });
  if (limit.blocked) {
    return json({ ok: false, error: 'Too many messages from this connection just now. Please try again shortly, or email connect@edurankai.in.' }, 429);
  }

  let body: any = {};
  try { body = await request.json(); } catch {}
  const name = (body?.name || '').toString().trim().slice(0, 200);
  const email = (body?.email || '').toString().trim().slice(0, 255).toLowerCase();
  const phoneRaw = (body?.phone || '').toString().trim().slice(0, 40);
  const phone = phoneRaw.replace(/[^0-9+\-\s()]/g, '').slice(0, 40);
  const dobRaw = (body?.dob || '').toString().trim().slice(0, 20);
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(dobRaw) ? dobRaw : '';
  const path = (body?.path || '').toString().slice(0, 500);
  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const initialMessage = (body?.initialMessage || '').toString().trim().slice(0, 5000);
  const signedInUserId = (locals as any)?.user?.id || null;

  let token = cookies.get(COOKIE_NAME)?.value;

  try {
    let conv: any = null;
    if (token) {
      const r = await db.execute(sql`SELECT * FROM help_conversations WHERE visitor_token = ${token} LIMIT 1`);
      const rows = Array.isArray(r) ? r : (r?.rows || []);
      conv = rows[0] || null;
    }

    if (!conv) {
      token = newToken();
      cookies.set(COOKIE_NAME, token, {
        path: '/', maxAge: COOKIE_MAX_AGE, sameSite: 'lax', secure: true, httpOnly: false,
      });
      const r = await db.execute(sql`
        INSERT INTO help_conversations (
          visitor_token, visitor_name, visitor_email, visitor_phone, visitor_dob,
          visitor_path, visitor_user_agent, user_id, status
        ) VALUES (
          ${token}, ${name || null}, ${email || null}, ${phone || null}, ${dob || null},
          ${path || null}, ${ua || null}, ${signedInUserId}, 'open'
        )
        RETURNING *
      `);
      const rows = Array.isArray(r) ? r : (r?.rows || []);
      conv = rows[0];
    } else if (name || email || phone || dob) {
      // Refresh contact fields if visitor provided them
      await db.execute(sql`
        UPDATE help_conversations SET
          visitor_name = COALESCE(NULLIF(${name || null}, ''), visitor_name),
          visitor_email = COALESCE(NULLIF(${email || null}, ''), visitor_email),
          visitor_phone = COALESCE(NULLIF(${phone || null}, ''), visitor_phone),
          visitor_dob = COALESCE(${dob || null}::date, visitor_dob),
          updated_at = NOW()
        WHERE id = ${conv.id}
      `);
    }

    // If an initial message was sent, append it
    if (initialMessage) {
      await db.execute(sql`
        INSERT INTO help_messages (conversation_id, sender_role, sender_name, body)
        VALUES (${conv.id}, 'visitor', ${name || null}, ${initialMessage})
      `);
      // `status = 'open'` is the line that stops this message disappearing into a closed thread the
      // support inbox does not list. It is a no-op on the overwhelmingly common case (the
      // conversation was already open) and the only thing that makes the write reachable otherwise.
      await db.execute(sql`
        UPDATE help_conversations SET
          message_count = message_count + 1,
          unread_admin = unread_admin + 1,
          status = 'open',
          last_message_at = NOW(),
          last_message_by = 'visitor',
          last_message_preview = ${initialMessage.substring(0, 200)},
          updated_at = NOW()
        WHERE id = ${conv.id}
      `);
      // Notify admins of the new help conversation (push + email).
      try {
        const { sendPushToAdmins } = await import('@/lib/push');
        await sendPushToAdmins({ type: 'help_message', title: 'New help chat: ' + (name || 'visitor'), body: String(initialMessage).slice(0, 160), url: '/admin/help', tag: 'help-' + conv.id });
      } catch (e: any) {
        logEvent('error', 'help.start.push-failed', { conversationId: String(conv.id), message: reasonOf(e) });
      }
      try {
        const { sendEmail } = await import('@/lib/email');
        await sendEmail({ to: 'hr@edurankai.in', subject: 'New help chat from ' + (name || 'a visitor'), html: '<p><strong>' + (name || 'A visitor') + '</strong> started a help chat:</p><blockquote>' + String(initialMessage).replace(/[<>]/g, '') + '</blockquote><p><a href="https://edurankai.in/admin/help">Open the help inbox</a></p>', text: (name || 'A visitor') + ': ' + initialMessage + '\n\nOpen: https://edurankai.in/admin/help' });
      } catch (e: any) {
        logEvent('error', 'help.start.email-failed', { conversationId: String(conv.id), message: reasonOf(e) });
      }
    }

    // Return the conversation + recent messages
    const m = await db.execute(sql`
      SELECT id, sender_role, sender_name, body, created_at
      FROM help_messages WHERE conversation_id = ${conv.id}
      ORDER BY created_at ASC LIMIT 200
    `);
    const messages = Array.isArray(m) ? m : (m?.rows || []);

    return json({
      ok: true,
      conversationId: conv.id,
      visitorToken: token,
      messages,
    });
  } catch (e: any) {
    logEvent('error', 'help.start.failed', { message: reasonOf(e) });
    return json({ ok: false, error: 'The help chat could not be opened just now. Please try again.' }, 500);
  }
};
