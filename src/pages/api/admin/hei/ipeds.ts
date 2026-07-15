// POST /api/admin/hei/ipeds — REAL ingester for the official US institution directory.
//   POST { year?:2023, limit?:300, offset?:0, dryRun?:false } -> upserts a slice.
//   GET  -> what is stored, and the years available.
//
// Batched by necessity, honestly: the source is a single 1.1MB zip that inflates to 4.5MB
// and holds ~6,163 institutions. A serverless invocation cannot download, parse and upsert
// all of them inside its time limit, so each call parses the file and writes one slice,
// returning nextOffset. The caller (or the admin's "Ingest all" loop) pages through.
//
// Same safety rules as every other HEI pipeline:
//  - rows land is_published = false (a human publishes them);
//  - COALESCE upsert never clobbers curated columns or an admin's correction;
//  - idempotent — re-running updates in place;
//  - telemetry is written only by a real run.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { fetchIpeds } from '@/lib/hei-ipeds';
import { slugify } from '@/lib/hei-miner';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function guard(locals: any) {
  const u = locals?.user;
  if (!u) return 'sign in required';
  if (u.role === 'applicant') return 'not permitted';
  return null;
}

export const GET: APIRoute = async ({ locals }) => {
  const bad = guard(locals); if (bad) return j({ ok: false, error: bad }, 403);
  let us = 0;
  try { us = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM hei_institutions WHERE country = 'United States'`))[0]?.c || 0; } catch (_) {}
  return j({ ok: true, years: [2023, 2022, 2021], storedUS: us, note: 'Official directory: identity + location, not quality metrics.' });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const bad = guard(locals); if (bad) return j({ ok: false, error: bad }, 403);
  let b: any = {};
  try { b = await request.json(); } catch { /* defaults */ }
  const year = parseInt(b.year, 10) || 2023;
  const limit = Math.min(Math.max(parseInt(b.limit, 10) || 300, 1), 1000);
  const offset = Math.max(parseInt(b.offset, 10) || 0, 0);
  const started = Date.now();

  let all;
  try { all = await fetchIpeds(year); }
  catch (e: any) { return j({ ok: false, stage: 'fetch', error: e?.message || 'source unreachable' }, 200); }
  if (!all.length) return j({ ok: false, stage: 'parse', error: 'no rows parsed — the publisher may have changed the file' }, 200);

  const slice = all.slice(offset, offset + limit);
  if (b.dryRun) return j({ ok: true, dryRun: true, year, total: all.length, offset, sliceSize: slice.length, sample: slice.slice(0, 10), ms: Date.now() - started });

  // The survey files (enrolment, graduation) key on UNITID, so the directory must store it
  // or the metrics can never be joined to an institution. Idempotent bootstrap.
  try {
    await db.execute(sql`ALTER TABLE hei_institutions ADD COLUMN IF NOT EXISTS ipeds_unit_id TEXT`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS hei_institutions_ipeds_idx ON hei_institutions(ipeds_unit_id)`);
  } catch (_) {}

  let inserted = 0, updated = 0, skipped = 0;
  const errors: string[] = [];
  for (const r of slice) {
    if (!r.name) { skipped++; continue; }
    try {
      const res = rows(await db.execute(sql`
        INSERT INTO hei_institutions (slug, name, tier, country, city, state_region, website_url, type, ipeds_unit_id, is_published, created_at, updated_at)
        VALUES (${slugify(r.name)}, ${r.name}, 'university', 'United States', ${r.city}, ${r.state}, ${r.websiteUrl}, ${r.control}, ${r.unitId || null}, false, NOW(), NOW())
        ON CONFLICT (slug) DO UPDATE SET
          name          = EXCLUDED.name,
          country       = COALESCE(EXCLUDED.country, hei_institutions.country),
          city          = COALESCE(EXCLUDED.city, hei_institutions.city),
          state_region  = COALESCE(EXCLUDED.state_region, hei_institutions.state_region),
          website_url   = COALESCE(EXCLUDED.website_url, hei_institutions.website_url),
          type          = COALESCE(EXCLUDED.type, hei_institutions.type),
          ipeds_unit_id = COALESCE(EXCLUDED.ipeds_unit_id, hei_institutions.ipeds_unit_id),
          updated_at    = NOW()
        RETURNING (xmax = 0) AS inserted`));
      if (rows(res)[0]?.inserted) inserted++; else updated++;
    } catch (e: any) {
      skipped++;
      if (errors.length < 5) errors.push(slugify(r.name) + ': ' + (e?.cause?.message || e?.message || 'db error'));
    }
  }

  try {
    await db.execute(sql`INSERT INTO hei_crawlers (code, name, description, status, sources_count, records_24h, updated_at)
      VALUES ('IPEDS', 'US official directory (live)', 'Official institution directory (HD file). Counters are measured from real runs.', 'active', 1, ${inserted + updated}, NOW())
      ON CONFLICT (code) DO UPDATE SET
        records_24h = CASE WHEN hei_crawlers.updated_at > NOW() - INTERVAL '24 hours'
                           THEN hei_crawlers.records_24h + ${inserted + updated}
                           ELSE ${inserted + updated} END,
        sources_count = 1, status = 'active', updated_at = NOW()`);
  } catch (_) {}

  const nextOffset = offset + limit;
  return j({
    ok: true, year, total: all.length, offset, processed: slice.length,
    inserted, updated, skipped, errors,
    nextOffset: nextOffset < all.length ? nextOffset : null,
    done: nextOffset >= all.length,
    progress: Math.min(100, Math.round((nextOffset / all.length) * 100)) + '%',
    note: 'Stored unpublished — review and publish from /admin/hei/institutions.',
    ms: Date.now() - started
  });
};
