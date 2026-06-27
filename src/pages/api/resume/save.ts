// POST /api/resume/save
// Stores a resume builder submission. Works WITHOUT login (the resume tool is
// public) — we capture the data to improve template quality and for security/
// abuse review, attaching the user id when one is present. Best-effort: a
// storage failure never blocks the user from downloading their resume.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS resume_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        email TEXT,
        full_name TEXT,
        template TEXT,
        data JSONB NOT NULL,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS resume_submissions_created_idx ON resume_submissions(created_at DESC)`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const data = body && body.data;
  if (!data || typeof data !== 'object') return json({ ok: false, error: 'no data' }, 400);
  // Cap payload so the public endpoint can't be used to dump large blobs.
  const serialized = JSON.stringify(data);
  if (serialized.length > 60000) return json({ ok: false, error: 'too large' }, 413);

  const user = (locals as any).user;
  const email = (data.email || '').toString().slice(0, 200) || null;
  const fullName = (data.fullName || data.name || '').toString().slice(0, 200) || null;
  const template = (body.template || '').toString().slice(0, 40) || null;

  try {
    await ensure();
    await db.execute(sql`
      INSERT INTO resume_submissions (user_id, email, full_name, template, data, ip)
      VALUES (${user?.id || null}, ${email}, ${fullName}, ${template}, ${serialized}::jsonb, ${clientAddress || null})
    `);
  } catch (_) { /* never block the download */ }
  return json({ ok: true });
};
