// POST /api/admin/ops/bootstrap — create every self-bootstrapping module table on demand.
//
// This platform has no migration runner: each module creates its own tables the first time somebody
// opens it. That works, but it means /api/health reports "degraded — N module table(s) not yet
// created" until a human happens to visit each surface, and an unvisited module's first real user
// is the one who discovers the table is missing. This endpoint touches them all deliberately.
//
// Every ensure is idempotent (CREATE TABLE IF NOT EXISTS inside an ensureOnce guard) and additive.
// Nothing here drops or alters existing data. Safe to run repeatedly.
import type { APIRoute } from 'astro';
import { can } from '@/lib/auth/permissions';
import { allowingDdl } from '@/lib/schema-bootstrap';
import { runBootstrapModules } from '@/lib/bootstrap-modules';

function j(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// THE LIST IS NOT WRITTEN OUT HERE ANY MORE. It lived in this file AND in the frontmatter of
// /admin/setup, and the two had drifted: twenty-five modules here, thirteen on the page. Both now
// import src/lib/bootstrap-modules.ts, which also owns the loop — including the part that stops one
// poisoned connection being reported as twenty broken modules.
export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  // 'settings.edit' is the real key for changing platform configuration. A capability string outside
  // the union answers false for EVERY role including super_admin, so this is checked, not assumed.
  if (!can(user as any, 'settings.edit')) return j({ ok: false, error: 'not permitted' }, 403);

  // INSIDE allowingDdl(), BECAUSE THIS ENDPOINT IS THE ESCAPE HATCH.
  //
  // src/lib/db/index.ts refuses DDL at db.execute when SCHEMA_BOOTSTRAP is off, which is the
  // production default, and that is right for every request-time bootstrap. It is exactly wrong
  // here: creating the module tables on demand IS this endpoint's entire contract, and an operator
  // reaches for it during an incident. Without this wrapper every CREATE TABLE below is suppressed
  // while each module still reports ok:true — the silent failure the verify step further down was
  // already written to catch, now arriving through a new door.
  //
  // Scoped to this handler by AsyncLocalStorage, so nothing else in the process is affected while
  // it runs, and the permission checks above still decide who may reach it.
  const results = await allowingDdl(() => runBootstrapModules());

  // VERIFY, do not trust the return. ensureOnce() ends in `p.catch(() => {})`, so a DDL statement
  // that threw still resolves and every ensure above reports success. The first run of this endpoint
  // answered ok:true, ran:8, failed:0 while /api/health went on reporting all ten tables missing.
  // A green result from a call is not evidence the call did anything; the only evidence is the
  // database itself, so ask it.
  //
  // THE LIST IS NOT WRITTEN OUT HERE ANY MORE. It was a hand-kept copy of a fact
  // src/lib/observability-health.ts already records, and it had already drifted: twelve names here
  // against sixteen there, and neither of the two search tables another session added the same day.
  // A verify step that checks a stale list is worse than none — it reports "verified" over exactly
  // the tables nobody remembered to add.
  //
  // BOOTSTRAP_MODULES is what /api/health reports on, so this endpoint and that endpoint now answer
  // the same question from the same source and cannot come to disagree. It is broader than what the
  // modules above create — a few of its tables belong to bootstraps this endpoint does not run — and
  // that is the right direction for a verify step: it can only over-report what is still missing,
  // never under-report it.
  const { BOOTSTRAP_MODULES } = await import('@/lib/observability-health');
  const EXPECTED = BOOTSTRAP_MODULES.map((m) => m.table);
  let present: string[] = [];
  let verifyError = '';
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    // = ANY(${array}) fails here with "op ANY/ALL (array) requires array on right side": the driver
    // sends a JS array as a plain parameter, not a typed text[]. An IN list built from individual
    // placeholders is unambiguous and needs no cast.
    const names = sql.join(EXPECTED.map((t) => sql`${t}`), sql`, `);
    const r: any = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (${names})`);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    present = rows.map((x: any) => String(x.table_name));
  } catch (e: any) {
    verifyError = e?.cause?.message || e?.message || 'unknown error';
  }
  // Only meaningful when the check itself succeeded. A failed verification means we do not KNOW,
  // and saying "still missing" would be the same false certainty this endpoint exists to remove.
  const missing = verifyError === '' ? EXPECTED.filter((t) => !present.includes(t)) : [];

  const failed = results.filter((r) => !r.ok);
  return j({
    ok: failed.length === 0 && missing.length === 0 && verifyError === '',
    ran: results.length,
    failed: failed.length,
    results,
    verified: verifyError === '' ? { present: present.length, missing } : null,
    verifyError: verifyError || undefined,
  });
};
