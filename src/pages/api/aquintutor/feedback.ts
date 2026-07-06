// Public lab feedback. Anyone using a lab (signed in or not) can leave a rating
// and a comment; it lands in a self-bootstrapping table for review in the
// admin. No auth required — the labs are open while we gather feedback.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const prerender = false;

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS aq_feedback (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        page TEXT,
        lab TEXT,
        rating INT,
        comment TEXT,
        name TEXT,
        email TEXT,
        user_id UUID,
        user_agent TEXT,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS aq_feedback_created_idx ON aq_feedback (created_at DESC)`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    await ensure();
    const body = await request.json().catch(() => ({}));
    const rating = Math.max(0, Math.min(5, parseInt(String(body.rating || 0)) || 0));
    const comment = String(body.comment || '').slice(0, 2000).trim();
    const page = String(body.page || '').slice(0, 300);
    const lab = String(body.lab || '').slice(0, 120);
    const name = String(body.name || '').slice(0, 120).trim() || null;
    const email = String(body.email || '').slice(0, 200).trim() || null;
    if (!rating && !comment) {
      return new Response(JSON.stringify({ ok: false, error: 'Add a rating or a comment.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const userId = (locals as any)?.user?.id || null;
    const ua = (request.headers.get('user-agent') || '').slice(0, 300);
    await db.execute(sql`
      INSERT INTO aq_feedback (page, lab, rating, comment, name, email, user_id, user_agent, ip)
      VALUES (${page}, ${lab}, ${rating || null}, ${comment || null}, ${name}, ${email}, ${userId}, ${ua}, ${clientAddress || null})
    `);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: 'Could not save feedback.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
