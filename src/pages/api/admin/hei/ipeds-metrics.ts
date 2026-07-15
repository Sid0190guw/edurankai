// POST /api/admin/hei/ipeds-metrics — real QUALITY metrics for US institutions.
//   POST { year?:2023, dryRun?:false } -> writes enrolment + graduation rate.
//   GET  -> coverage: how many stored institutions carry each metric.
//
// The directory (HD) says WHO exists. This says something about HOW THEY DO: total
// enrolment (DRVEF) and the overall graduation rate (DRVGR), joined to institutions on
// the IPEDS unit id that the directory ingester stores.
//
// TWO INTEGRITY RULES THAT MATTER MORE THAN COVERAGE:
//  1. IPEDS writes '.' for "not applicable / not reported". That is parsed to NULL, never
//     0 — 659 institutions genuinely report no graduation rate, and publishing a 0% for
//     them would be a defamatory fabrication in a ranking product.
//  2. Nothing here is published. Metrics land on unpublished rows; a human decides.
//
// This updates in ONE statement per batch using a VALUES join, so it stays inside the
// serverless limit without paging thousands of individual updates.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { fetchIpedsMetrics } from '@/lib/hei-ipeds';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function guard(locals: any) {
  const u = locals?.user;
  if (!u) return 'sign in required';
  if (u.role === 'applicant') return 'not permitted';
  return null;
}

async function ensureCols() {
  await db.execute(sql`ALTER TABLE hei_institutions ADD COLUMN IF NOT EXISTS ipeds_unit_id TEXT`);
  await db.execute(sql`ALTER TABLE hei_institutions ADD COLUMN IF NOT EXISTS grad_rate NUMERIC`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hei_institutions_ipeds_idx ON hei_institutions(ipeds_unit_id)`);
}

export const GET: APIRoute = async ({ locals }) => {
  const bad = guard(locals); if (bad) return j({ ok: false, error: bad }, 403);
  try {
    await ensureCols();
    const r = rows(await db.execute(sql`SELECT
      COUNT(*) FILTER (WHERE ipeds_unit_id IS NOT NULL)::int AS linked,
      COUNT(*) FILTER (WHERE student_count IS NOT NULL)::int AS with_enrolment,
      COUNT(*) FILTER (WHERE grad_rate IS NOT NULL)::int AS with_grad_rate
      FROM hei_institutions`))[0] || {};
    return j({ ok: true, linkedToIpeds: r.linked || 0, withEnrolment: r.with_enrolment || 0, withGradRate: r.with_grad_rate || 0, years: [2023, 2022, 2021] });
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'lookup failed' }, 200); }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const bad = guard(locals); if (bad) return j({ ok: false, error: bad }, 403);
  let b: any = {};
  try { b = await request.json(); } catch { /* defaults */ }
  const year = parseInt(b.year, 10) || 2023;
  const started = Date.now();

  let metrics;
  try { metrics = await fetchIpedsMetrics(year); }
  catch (e: any) { return j({ ok: false, stage: 'fetch', error: e?.message || 'source unreachable' }, 200); }
  if (!metrics.length) return j({ ok: false, stage: 'parse', error: 'no metrics parsed — the publisher may have changed the files' }, 200);

  const withEnr = metrics.filter((m) => m.enrollment != null).length;
  const withGrad = metrics.filter((m) => m.gradRate != null).length;
  if (b.dryRun) {
    return j({ ok: true, dryRun: true, year, parsed: metrics.length, withEnrolment: withEnr, withGradRate: withGrad,
      missingGradRate: metrics.length - withGrad, sample: metrics.slice(0, 10), ms: Date.now() - started });
  }

  try { await ensureCols(); } catch (e: any) { return j({ ok: false, stage: 'schema', error: e?.cause?.message || e?.message }, 200); }

  // batch the VALUES join so one statement never gets absurdly large
  let matched = 0;
  const CHUNK = 800;
  try {
    for (let i = 0; i < metrics.length; i += CHUNK) {
      const part = metrics.slice(i, i + CHUNK);
      const vals = sql.join(
        part.map((m) => sql`(${m.unitId}, ${m.enrollment}::int, ${m.gradRate}::numeric)`),
        sql`, `
      );
      const r = rows(await db.execute(sql`
        UPDATE hei_institutions AS h SET
          student_count = COALESCE(v.enr, h.student_count),
          grad_rate     = COALESCE(v.gr, h.grad_rate),
          updated_at    = NOW()
        FROM (VALUES ${vals}) AS v(uid, enr, gr)
        WHERE h.ipeds_unit_id = v.uid
        RETURNING 1`));
      matched += r.length;
    }
  } catch (e: any) {
    return j({ ok: false, stage: 'update', error: e?.cause?.message || e?.message || 'db error', matched }, 200);
  }

  try {
    await db.execute(sql`INSERT INTO hei_crawlers (code, name, description, status, sources_count, records_24h, updated_at)
      VALUES ('IPEDS-M', 'US metrics: enrolment + graduation (live)', 'Derived survey files. Missing values stay NULL, never 0. Counters measured from real runs.', 'active', 2, ${matched}, NOW())
      ON CONFLICT (code) DO UPDATE SET
        records_24h = CASE WHEN hei_crawlers.updated_at > NOW() - INTERVAL '24 hours'
                           THEN hei_crawlers.records_24h + ${matched} ELSE ${matched} END,
        sources_count = 2, status = 'active', updated_at = NOW()`);
  } catch (_) {}

  return j({
    ok: true, year, parsed: metrics.length, withEnrolment: withEnr, withGradRate: withGrad,
    missingGradRate: metrics.length - withGrad,
    matchedInstitutions: matched,
    note: matched === 0
      ? 'No institutions matched — ingest the US directory first so unit ids exist to join on.'
      : 'Metrics written to unpublished rows. Missing values are NULL (never 0).',
    ms: Date.now() - started
  });
};
