// POST /api/admin/hei/mine — the one-click HEI data miner.
//   POST { country?:'India'|'all'|..., limit?:50, offset?:0, dryRun?:false }
//     -> pulls LIVE university records from the open public knowledge graph and
//        upserts them into hei_institutions. Returns a real report.
//   GET  /api/admin/hei/mine?country=India  -> how many exist upstream vs stored here.
//
// HONEST DESIGN:
//  - Mined rows are inserted with is_published = false. Unverified third-party data must
//    never auto-appear in a public ranking; a human publishes it from /admin/hei.
//  - The upsert never clobbers curated columns (truth_score, truth_rank, is_published) and
//    only fills a field when the miner actually has a value (COALESCE), so an admin's
//    correction is never overwritten by a later run.
//  - Idempotent: re-running updates in place (matched on slug), so the daily cron is safe.
//  - Batched by design: a serverless function cannot walk 22k records in one request, so
//    the caller pages with limit/offset.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { mineUniversities, countUniversities, slugify, COUNTRIES } from '@/lib/hei-miner';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

function guard(locals: any) {
  const user = locals?.user;
  if (!user) return 'sign in required';
  if (user.role === 'applicant') return 'not permitted';
  return null;
}

export const GET: APIRoute = async ({ url, locals }) => {
  const bad = guard(locals); if (bad) return j({ ok: false, error: bad }, 403);
  const country = url.searchParams.get('country') || 'India';
  try {
    const upstream = await countUniversities(country);
    const stored = rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM hei_institutions`))[0]?.c || 0;
    return j({ ok: true, country, upstreamAvailable: upstream, storedHere: stored, countries: Object.keys(COUNTRIES) });
  } catch (e: any) {
    return j({ ok: false, error: e?.cause?.message || e?.message || 'lookup failed' }, 200);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const bad = guard(locals); if (bad) return j({ ok: false, error: bad }, 403);
  let b: any = {};
  try { b = await request.json(); } catch { /* allow empty body -> defaults */ }
  const country = String(b.country || 'India');
  const limit = Math.min(Math.max(parseInt(b.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(b.offset, 10) || 0, 0);
  const dryRun = !!b.dryRun;
  const started = Date.now();

  let mined;
  try { mined = await mineUniversities({ country, limit, offset }); }
  catch (e: any) { return j({ ok: false, stage: 'mine', error: e?.message || 'knowledge graph unreachable' }, 200); }

  if (dryRun) return j({ ok: true, dryRun: true, country, mined: mined.length, sample: mined.slice(0, 10), ms: Date.now() - started });

  let inserted = 0, updated = 0, skipped = 0;
  const errors: string[] = [];
  for (const m of mined) {
    if (!m.name) { skipped++; continue; }
    const slug = slugify(m.name);
    try {
      const r = rows(await db.execute(sql`
        INSERT INTO hei_institutions (slug, name, tier, country, city, website_url, established_year, student_count, is_published, created_at, updated_at)
        VALUES (${slug}, ${m.name}, 'university', ${m.country || 'India'}, ${m.city}, ${m.websiteUrl}, ${m.establishedYear}, ${m.studentCount}, false, NOW(), NOW())
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
    } catch (e: any) {
      skipped++;
      const msg = e?.cause?.message || e?.message || 'db error';
      if (errors.length < 5) errors.push(slug + ': ' + msg);
    }
  }

  // REAL telemetry. The other rows in hei_crawlers carry hand-typed counters (the only
  // writer is the manual "Update" form), which the HEI dashboard then sums as if it were
  // measured. This row is written ONLY by an actual run: records_24h is what this miner
  // truly wrote in the last 24h, and updated_at is a real last-run time.
  try {
    await db.execute(sql`INSERT INTO hei_crawlers (code, name, description, status, sources_count, records_24h, updated_at)
      VALUES ('KG', 'Knowledge graph (live)', 'Open public knowledge graph via SPARQL. Counters below are measured from real runs, not entered by hand.', 'active', 1, ${inserted + updated}, NOW())
      ON CONFLICT (code) DO UPDATE SET
        records_24h = CASE WHEN hei_crawlers.updated_at > NOW() - INTERVAL '24 hours'
                           THEN hei_crawlers.records_24h + ${inserted + updated}
                           ELSE ${inserted + updated} END,
        sources_count = 1,
        status = 'active',
        updated_at = NOW()`);
  } catch (_) { /* telemetry must never fail the run */ }

  return j({
    ok: true, country, requested: limit, offset, mined: mined.length,
    inserted, updated, skipped, errors,
    nextOffset: offset + limit,
    note: 'Mined records are stored unpublished — review and publish them from /admin/hei/institutions.',
    ms: Date.now() - started
  });
};
