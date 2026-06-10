// POST /api/auth/save-id-doc  { url, idType?, idNumber? }
// Saves a self-uploaded government-ID document on the signed-in user and queues
// it for human review (shows up in the moderator / identity-verifications queue).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const url = (body?.url || '').toString().slice(0, 1000);
  if (!/^https?:\/\//i.test(url)) return json({ ok: false, error: 'invalid document url' }, 400);
  const idType = (body?.idType || '').toString().slice(0, 50);
  const idNumber = (body?.idNumber || '').toString().slice(0, 60);

  try {
    await db.execute(sql`
      UPDATE users SET id_doc_url = ${url}, id_card_type = COALESCE(${idType || null}, id_card_type),
        id_number = COALESCE(${idNumber || null}, id_number), updated_at = NOW()
      WHERE id = ${user.id}
    `);
    // Queue a pending verification for the reviewer (best-effort; columns self-heal).
    await db.execute(sql`ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS id_card_blob_url TEXT`).catch(() => {});
    await db.execute(sql`
      INSERT INTO identity_verifications (user_id, email, claimed_name, id_card_type, id_card_blob_url, verdict, method, created_at)
      VALUES (${user.id}, ${(user.email || '').toString()}, ${(user.name || '').toString()}, ${idType || null}, ${url}, 'pending', 'self_upload', NOW())
    `).catch(() => {});
    return json({ ok: true });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e).slice(0, 160) }, 500); }
};
