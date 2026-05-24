// POST /api/help/start - get or create a help conversation for the current visitor.
// Sets a long-lived era_help_session cookie if missing. Optional initial message.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';

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

export const POST: APIRoute = async ({ request, cookies, locals }) => {
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
      await db.execute(sql`
        UPDATE help_conversations SET
          message_count = message_count + 1,
          unread_admin = unread_admin + 1,
          last_message_at = NOW(),
          last_message_by = 'visitor',
          last_message_preview = ${initialMessage.substring(0, 200)},
          updated_at = NOW()
        WHERE id = ${conv.id}
      `);
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
    return json({ ok: false, error: e?.message || 'db error' }, 500);
  }
};
