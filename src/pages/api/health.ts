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
// UNAUTHENTICATED BY DESIGN, and therefore deliberately thin: reachability, latency, module names,
// and the commit that is serving. Anything that discloses configuration — hostnames, queue
// contents, pool internals — lives at /api/health/deep behind an operator capability.
import type { APIRoute } from 'astro';
import { quickHealth } from '@/lib/observability-health';

export const prerender = false;

// Declared before the handler that uses it: `const` is not hoisted, and that has taken pages down here.
const json = (body: any, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store, max-age=0' },
  });

export const GET: APIRoute = async () => {
  try {
    const h = await quickHealth();
    return json({
      status: h.status,
      at: h.at,
      database: { ok: h.database.ok, latencyMs: h.database.latencyMs, ...(h.database.error ? { error: h.database.error } : {}) },
      schemas: h.schemas,
      release: { commit: h.release.shortCommit, ref: h.release.ref, environment: h.release.environment, region: h.release.region, known: h.release.known },
      checks: h.checks,
    }, h.httpCode);
  } catch (e: any) {
    // A health endpoint that 500s with a stack tells a monitor nothing useful and tells a stranger
    // too much. Report the failure as an outage, in the same shape, with the real reason (which for
    // a Postgres failure lives on e.cause, never on e.message) recorded where operators can read it.
    const message = String(e?.cause?.message || e?.message || 'health check failed').slice(0, 300);
    try { const { trackError } = await import('@/lib/logger'); await trackError('health.check_failed', e, {}); } catch { /* never let logging mask the outage */ }
    return json({ status: 'down', at: new Date().toISOString(), database: { ok: false, latencyMs: -1, error: message }, checks: [{ name: 'database', ok: false, critical: true, detail: message }] }, 503);
  }
};

// HEAD, so an uptime monitor can poll for the status code alone without transferring a body.
export const HEAD: APIRoute = async () => {
  const h = await quickHealth().catch(() => null);
  return new Response(null, { status: h ? h.httpCode : 503, headers: { 'cache-control': 'no-store, max-age=0' } });
};
