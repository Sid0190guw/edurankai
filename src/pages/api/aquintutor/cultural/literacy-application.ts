// POST /api/aquintutor/cultural/literacy-application — apply to the cultural literacy programme.
//
// The form used to write the application into localStorage under `aquin_cultural_literacy_apps` and
// then say "Application received. We will write back within five working days." Nothing read that
// key — not a sync job, not an admin screen, nothing. The application existed only in the browser
// of the person who wrote it, and it died with their cache. Nobody was ever going to write back.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { json, text, email, tooFast, logFail, bodyOf } from '@/lib/campus-intake';
import { ensureOnce } from '@/lib/ensure-once';

export const prerender = false;

async function ensureSchema(): Promise<void> {
  await ensureOnce('cultural_literacy_applications', async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS cultural_literacy_applications (
        id            BIGSERIAL PRIMARY KEY,
        full_name     TEXT NOT NULL,
        email         TEXT NOT NULL,
        year_of_study TEXT,
        track         TEXT,
        reason        TEXT,
        status        TEXT NOT NULL DEFAULT 'received',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const b = await bodyOf(request);
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400);

  const fullName = text(b.full_name, 120);
  const addr = email(b.email);
  if (!fullName) return json({ ok: false, error: 'a name is required' }, 400);
  if (!addr) return json({ ok: false, error: 'that email address does not look right' }, 400);
  if (await tooFast('literacy', clientAddress || addr)) return json({ ok: false, error: 'that went through several times just now — give it a minute' }, 429);

  try {
    await ensureSchema();
    await db.execute(sql`
      INSERT INTO cultural_literacy_applications (full_name, email, year_of_study, track, reason)
      VALUES (${fullName}, ${addr}, ${text(b.year, 40)}, ${text(b.track, 120)}, ${text(b.reason, 1500)})`);
    return json({ ok: true, status: 'received' });
  } catch (e: any) {
    logFail('literacy-application', e);
    return json({ ok: false, error: 'could not record that just now' }, 500);
  }
};
