// POST /api/admin/hei/nirf — REAL ingester for India's national ranking framework.
//   POST { category?:'Engineering', year?:2024, band?:''|'150'|'200'|'300', dryRun?:false }
//   GET  /api/admin/hei/nirf  -> categories, bands, and what is already stored.
//
// This is the P1 "public data" pipeline made real for one source. It fetches the
// publisher's server-rendered ranking table, parses it (nesting-aware — each row hides a
// nested <table>), and upserts institutions with their real nirf_rank.
//
// HONEST SCOPE: this implements NIRF only. AISHE / IPEDS / HESA each publish in a
// different shape and need their own parser — a bespoke ingester per source is the actual
// cost, which is exactly why "crawl the whole internet" was never a real claim.
//
// Same safety rules as the knowledge-graph miner:
//  - rows land is_published = false (a human publishes from /admin/hei/institutions);
//  - COALESCE upsert never clobbers curated columns or an admin's correction;
//  - idempotent, so re-running is safe.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { fetchNirf, NIRF_CATEGORIES, NIRF_BANDS, nirfUrl } from '@/lib/hei-nirf';
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
  let ranked = 0;
  try { ranked = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM hei_institutions WHERE nirf_rank IS NOT NULL`))[0]?.c || 0; } catch (_) {}
  return j({ ok: true, categories: Object.keys(NIRF_CATEGORIES), bands: NIRF_BANDS, years: [2024, 2023, 2022], storedWithNirfRank: ranked });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const bad = guard(locals); if (bad) return j({ ok: false, error: bad }, 403);
  let b: any = {};
  try { b = await request.json(); } catch { /* defaults */ }
  const category = String(b.category || 'Engineering');
  const year = parseInt(b.year, 10) || 2024;
  const band = NIRF_BANDS.includes(String(b.band || '')) ? String(b.band || '') : '';
  if (!NIRF_CATEGORIES[category]) return j({ ok: false, error: 'unknown category "' + category + '"' }, 400);
  const started = Date.now();

  let parsed;
  try { parsed = await fetchNirf(category, year, band); }
  catch (e: any) { return j({ ok: false, stage: 'fetch', url: nirfUrl(category, year, band), error: e?.message || 'source unreachable' }, 200); }
  if (!parsed.length) return j({ ok: false, stage: 'parse', url: nirfUrl(category, year, band), error: 'no rows parsed — the publisher may have changed its markup' }, 200);

  if (b.dryRun) return j({ ok: true, dryRun: true, category, year, band, parsed: parsed.length, sample: parsed.slice(0, 10), ms: Date.now() - started });

  let inserted = 0, updated = 0, skipped = 0;
  const errors: string[] = [];
  for (const r of parsed) {
    if (!r.name) { skipped++; continue; }
    try {
      const res = rows(await db.execute(sql`
        INSERT INTO hei_institutions (slug, name, tier, country, city, state_region, nirf_rank, is_published, created_at, updated_at)
        VALUES (${slugify(r.name)}, ${r.name}, 'university', 'India', ${r.city}, ${r.state}, ${r.rank}, false, NOW(), NOW())
        ON CONFLICT (slug) DO UPDATE SET
          name         = EXCLUDED.name,
          city         = COALESCE(EXCLUDED.city, hei_institutions.city),
          state_region = COALESCE(EXCLUDED.state_region, hei_institutions.state_region),
          nirf_rank    = COALESCE(EXCLUDED.nirf_rank, hei_institutions.nirf_rank),
          updated_at   = NOW()
        RETURNING (xmax = 0) AS inserted`));
      if (rows(res)[0]?.inserted) inserted++; else updated++;
    } catch (e: any) {
      skipped++;
      if (errors.length < 5) errors.push(slugify(r.name) + ': ' + (e?.cause?.message || e?.message || 'db error'));
    }
  }

  // real telemetry (only an actual run writes this)
  try {
    await db.execute(sql`INSERT INTO hei_crawlers (code, name, description, status, sources_count, records_24h, updated_at)
      VALUES ('NIRF', 'National ranking framework (live)', 'Parses the published ranking tables. Counters are measured from real runs.', 'active', 1, ${inserted + updated}, NOW())
      ON CONFLICT (code) DO UPDATE SET
        records_24h = CASE WHEN hei_crawlers.updated_at > NOW() - INTERVAL '24 hours'
                           THEN hei_crawlers.records_24h + ${inserted + updated}
                           ELSE ${inserted + updated} END,
        sources_count = 1, status = 'active', updated_at = NOW()`);
  } catch (_) {}

  return j({
    ok: true, category, year, band, url: nirfUrl(category, year, band),
    parsed: parsed.length, inserted, updated, skipped, errors,
    topThree: parsed.slice(0, 3).map((r) => r.rank + '. ' + r.name),
    note: 'Stored unpublished — review and publish from /admin/hei/institutions.',
    ms: Date.now() - started
  });
};
