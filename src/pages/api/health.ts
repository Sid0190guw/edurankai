// GET /api/health — the check an external monitor polls.
//
// It is NOT a static 200. A static 200 is worse than no monitor at all: it reports the one thing
// that is always true (this function booted) and stays green through the outage you bought it for.
// This route asks the database a real question, reports how long the answer took, and reports which
// self-bootstrapping schemas have actually run — this deployment has no migration runner, so the
// existence of a module's table IS its deployment status.
//
// 503 WHEN THE DATABASE IS UNREACHABLE. That is the whole point of the endpoint: a monitor can only
// see an outage if the outage changes the status code. A DEGRADED result (a module table missing,
// nothing has exercised it yet) stays 200 — it is information, not a page-somebody event.
//
// CHEAP ENOUGH TO POLL, AND HOLDS NOTHING OPEN. Exactly two statements (SELECT 1, and one
// information_schema lookup for every module at once), no DDL, no writes, no transaction, no
// timer. On the Supabase transaction pooler connections are precious — a health probe that leaked
// one would become the outage it exists to detect.
//
// UNAUTHENTICATED BY DESIGN, and therefore deliberately thin: reachability, latency, how many
// module schemas have run, and the commit that is serving. Anything that discloses configuration —
// hostnames, queue contents, pool internals — lives at /api/health/deep behind an operator
// capability.
//
// TWO THINGS THIS ROUTE USED TO GIVE AWAY, and now does not:
//
//   1. THE DATABASE ERROR VERBATIM. `e.cause.message` is written by the Postgres driver and on the
//      failures that matter it carries the connection configuration — the pooler hostname, the
//      database role, the address and port. That is precisely what /api/health/deep exists to keep
//      behind a capability, and this route was publishing it to anyone during an outage.
//      publicErrorSummary() keeps the failure CLASS and strips the configuration, because deleting
//      the reason outright would be worse: /api/health/deep gates on can(), which resolves the
//      principal from the database, so during a database outage NOBODY can read the deep endpoint
//      and this field is the only diagnosis available. The unredacted reason is written to
//      edu_error_log and shown on /admin/ops and /api/health/deep.
//   2. THE NAMES OF INTERNAL TABLES. `schemas.missing` listed them. A stranger does not need the
//      table inventory to know the deployment is degraded; a COUNT says the same thing to a monitor.
//      The names stay on /api/health/deep and on the /admin/ops bootstrap panel.
import type { APIRoute } from 'astro';
import { quickHealth, publicErrorSummary } from '@/lib/observability-health';
// A health check that can hang is not a health check. On 2026-08-23 this route held requests open
// past 100 seconds while the database was unreachable, so the one endpoint whose entire job is to
// turn an outage into a 503 reported nothing at all for the quarter hour the site was down. The
// catch below was always correct; it simply never ran, because the query never rejected.
import { withDbTimeout } from '@/lib/db';
// TWO IN-PROCESS COUNTERS, NO EXTRA QUERIES. Both answer questions this endpoint could not answer
// during the incident it was written for: is the database circuit currently open (so reads are being
// refused instantly rather than waited out), and is request-time DDL still being attempted by
// bootstraps that never got onto ensureOnce. A guard nobody can see is the next invisible incident,
// and this project has already shipped one bootstrap that reported success while doing nothing.
import { dbCircuitState } from '@/lib/db-timeout';
import { suppressedDdlState } from '@/lib/schema-bootstrap';

export const prerender = false;

// Declared before the handler that uses it: `const` is not hoisted, and that has taken pages down here.
const json = (body: any, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store, max-age=0' },
  });

export const GET: APIRoute = async () => {
  try {
    // 5s, not the default: this route is polled by a monitor, and a monitor that waits is a monitor
    // that misses. A database this far past a warm round trip (~140ms measured) is already an
    // outage, whatever it eventually answers.
    const h = await withDbTimeout(quickHealth(), 'health.quick', 5000);
    // Scrubbed once, then used for BOTH the database field and the checks array — the raw reason
    // reached the public body through two paths, and fixing only one of them would have been worse
    // than fixing neither, because it would read as fixed.
    const publicDbError = h.database.error ? publicErrorSummary(h.database.error) : null;
    return json({
      status: h.status,
      at: h.at,
      database: { ok: h.database.ok, latencyMs: h.database.latencyMs, ...(publicDbError ? { error: publicDbError } : {}) },
      schemas: { ran: h.schemas.ran, expected: h.schemas.expected, missingCount: h.schemas.missing.length },
      // Per-instance, not site-wide: a serverless deployment has many instances and this is whichever
      // one answered. Non-zero `suppressed` means a bootstrap is still trying to run DDL on the
      // request path; the sample list names which statements, in the function logs.
      ddl: (() => { const d = suppressedDdlState(); return { bootstrapEnabled: d.bootstrapEnabled, suppressed: d.count, samples: d.samples.slice(0, 5) }; })(),
      dbCircuit: dbCircuitState(),
      release: { commit: h.release.shortCommit, ref: h.release.ref, environment: h.release.environment, region: h.release.region, known: h.release.known },
      checks: h.checks.map((c) => ({
        name: c.name,
        ok: c.ok,
        ...(c.critical ? { critical: true } : {}),
        detail: c.name === 'database' && !c.ok ? (publicDbError || 'database unreachable') : c.detail,
      })),
    }, h.httpCode);
  } catch (e: any) {
    // A health endpoint that 500s with a stack tells a monitor nothing useful and tells a stranger
    // too much. Report the failure as an outage, in the same shape, with the real reason (which for
    // a Postgres failure lives on e.cause, never on e.message) recorded where operators can read it
    // — edu_error_log gets it unredacted, the response gets the scrubbed class.
    const message = publicErrorSummary(e?.cause?.message || e?.message || 'health check failed');
    // BOUNDED, because this writes to edu_error_log — the same database that has just failed to
    // answer. An unbounded await here would hang the 503 exactly as long as the check it is
    // reporting on, which is how the failure path becomes the failure.
    try {
      const { trackError } = await import('@/lib/logger');
      await withDbTimeout(trackError('health.check_failed', e, {}), 'health.trackError', 2000);
    } catch { /* never let logging mask the outage */ }
    return json({ status: 'down', at: new Date().toISOString(), database: { ok: false, latencyMs: -1, error: message }, checks: [{ name: 'database', ok: false, critical: true, detail: message }] }, 503);
  }
};

// HEAD, so an uptime monitor can poll for the status code alone without transferring a body.
export const HEAD: APIRoute = async () => {
  const h = await withDbTimeout(quickHealth(), 'health.quick.head', 5000).catch(() => null);
  return new Response(null, { status: h ? h.httpCode : 503, headers: { 'cache-control': 'no-store, max-age=0' } });
};
