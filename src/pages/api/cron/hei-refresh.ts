// GET /api/cron/hei-refresh — the automated HEI data pipeline.
//
// Keeps stored institution data fresh without anyone clicking anything. Runs DAILY
// (the Vercel plan here allows daily cron only — a sub-daily schedule in vercel.json
// silently fails every deploy, so this is deliberately daily).
//
// HOW IT STAYS CURRENT WITHOUT A HUGE CRAWL:
//  - A serverless invocation cannot walk tens of thousands of records, so each run
//    advances a ROLLING WINDOW: it mines the next batch, stores its offset in
//    hei_miner_state, and wraps to 0 at the end. Over successive days the whole set is
//    revisited continuously, so records are always being refreshed rather than frozen.
//  - The upsert is idempotent and never clobbers curated columns, so repeated runs are
//    safe (see /api/admin/hei/mine).
//  - Mined rows stay is_published = false. The pipeline never publishes on its own.
//
// Protected by CRON_SECRET when set (Vercel sends it as a Bearer token).
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { mineUniversities, countUniversities, slugify } from '@/lib/hei-miner';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const BATCH = 100;
// Each run sweeps as many batches as its time budget allows, then saves the offset for
// tomorrow (one batch/day would take ~22 days for India and ~222 worldwide — frozen, not
// continuous).
//
// WHY 8s AND NOT MORE: Vercel's default serverless limit is 10s. Raising it means setting
// maxDuration globally in astro.config, and if that ever exceeds the plan ceiling EVERY
// deploy fails — not worth the risk for a background refresh. So this cron is deliberately
// an INCREMENTAL top-up. Bulk loading is done from /admin/hei/crawlers -> "Mine
// continuously", which pages through the whole set from the browser in ~2 min (India) with
// no serverless limit at all. If maxDuration is ever raised, only this number changes.
const BUDGET_MS = 8000;
const COUNTRY = 'India';   // the index is Bharat-first; widen by editing hei_miner_state.country

async function ensureState() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS hei_miner_state (
    id TEXT PRIMARY KEY,
    country TEXT NOT NULL DEFAULT 'India',
    next_offset INTEGER NOT NULL DEFAULT 0,
    last_run_at TIMESTAMPTZ,
    last_report JSONB
  )`);
  await db.execute(sql`INSERT INTO hei_miner_state (id, country, next_offset) VALUES ('default', ${COUNTRY}, 0) ON CONFLICT (id) DO NOTHING`);
}

export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET || process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') || '';
    if (auth !== 'Bearer ' + secret) return j({ ok: false, error: 'unauthorized' }, 401);
  }
  const started = Date.now();
  try {
    await ensureState();
    const st = rows(await db.execute(sql`SELECT country, next_offset FROM hei_miner_state WHERE id = 'default'`))[0] || { country: COUNTRY, next_offset: 0 };
    const country = st.country || COUNTRY;
    let offset = Number(st.next_offset) || 0;

    const total = await countUniversities(country);
    if (total > 0 && offset >= total) offset = 0;              // wrap: start the sweep again

    const startOffset = offset;
    let inserted = 0, updated = 0, skipped = 0, mined = 0, batches = 0;

    // keep sweeping until the time budget is spent (or the sweep completes)
    while (Date.now() - started < BUDGET_MS) {
      const batch = await mineUniversities({ country, limit: BATCH, offset });
      batches++;
      if (!batch.length) { offset = 0; break; }               // reached the end -> wrap
      mined += batch.length;
      for (const m of batch) {
        if (!m.name) { skipped++; continue; }
        try {
          const r = rows(await db.execute(sql`
            INSERT INTO hei_institutions (slug, name, tier, country, city, website_url, established_year, student_count, is_published, created_at, updated_at)
            VALUES (${slugify(m.name)}, ${m.name}, 'university', ${m.country || country}, ${m.city}, ${m.websiteUrl}, ${m.establishedYear}, ${m.studentCount}, false, NOW(), NOW())
            ON CONFLICT (slug) DO UPDATE SET
              name             = EXCLUDED.name,
              country          = COALESCE(EXCLUDED.country, hei_institutions.country),
              city             = COALESCE(EXCLUDED.city, hei_institutions.city),
              website_url      = COALESCE(EXCLUDED.website_url, hei_institutions.website_url),
              established_year = COALESCE(EXCLUDED.established_year, hei_institutions.established_year),
              student_count    = COALESCE(EXCLUDED.student_count, hei_institutions.student_count),
              updated_at       = NOW()
            RETURNING (xmax = 0) AS inserted`));
          if (rows(r)[0]?.inserted) inserted++; else updated++;
        } catch { skipped++; }
      }
      offset += BATCH;
      if (total > 0 && offset >= total) { offset = 0; break; }  // completed a full sweep
    }

    const nextOffset = offset;
    const report = { country, total, startOffset, batches, mined, inserted, updated, skipped, ms: Date.now() - started };
    await db.execute(sql`UPDATE hei_miner_state SET next_offset = ${nextOffset}, last_run_at = NOW(), last_report = ${JSON.stringify(report)}::jsonb WHERE id = 'default'`);
    return j({ ok: true, ...report, nextOffset, sweepProgress: total ? Math.min(100, Math.round((nextOffset / total) * 100)) + '%' : 'n/a', wrapped: nextOffset === 0 });
  } catch (e: any) {
    return j({ ok: false, error: e?.cause?.message || e?.message || 'refresh failed', ms: Date.now() - started }, 200);
  }
};
