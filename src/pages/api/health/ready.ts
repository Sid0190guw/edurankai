// GET /api/health/ready — readiness, which is a different question from liveness.
//
// LIVENESS (/api/health) asks "is this process alive and can it reach its database". A load
// balancer that kills on liveness restarts things.
//
// READINESS asks "should traffic be sent here YET". The distinction matters at exactly one moment
// and it is the moment that hurts: a fresh instance that has booted, passes liveness, and is
// missing the configuration it needs to do its job. It will accept mail and lose it. Readiness is
// what a deployment gate, a container orchestrator and `scripts/status-mail.sh` read before they
// declare a rollout finished.
//
// WHAT MAKES IT NOT READY, and nothing else:
//   - the database does not answer (nothing works without it)
//   - a REQUIRED environment variable is absent (checkEnv errors)
// A partially-configured optional group (S3 four-fifths set) is reported and does NOT block
// readiness — it is a warning, because the system genuinely still serves with the fallback. Making
// warnings block is how a readiness probe gets disabled by the first person paged at 3am.
//
// UNAUTHENTICATED, and therefore counts only. Names of missing variables would tell a stranger
// which capability this deployment lacks, which is a map of where to push. The names are on
// /api/health/deep and in `node scripts/mail-env-check.mjs`, both of which require an operator.
import type { APIRoute } from 'astro';
import { dbPing } from '@/lib/observability-health';
import { checkEnv } from '@/lib/mailops/env';

export const prerender = false;

// `const` is not hoisted, and a handler reaching a later declaration has taken pages down here.
const json = (body: any, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store, max-age=0' },
  });

export const GET: APIRoute = async () => {
  const at = new Date().toISOString();
  try {
    const [db, env] = [await dbPing(), checkEnv(process.env as any)];

    const checks = [
      { name: 'database', ok: db.ok, blocking: true },
      { name: 'required-env', ok: env.errors.length === 0, blocking: true },
      { name: 'config-groups', ok: env.groups.every((g) => !g.partial), blocking: false },
    ];
    const ready = checks.every((c) => !c.blocking || c.ok);

    return json({
      ready,
      at,
      databaseLatencyMs: db.latencyMs,
      checks,
      // Counts, never names. See the header.
      config: { errors: env.errors.length, warnings: env.warnings.length, partialGroups: env.groups.filter((g) => g.partial).length },
    }, ready ? 200 : 503);
  } catch (e: any) {
    // Not-ready is the honest answer to "the readiness check itself threw". Reporting 200 here
    // would send traffic to an instance whose state is unknown, which is the one outcome this
    // endpoint exists to prevent.
    try { const { trackError } = await import('@/lib/logger'); await trackError('health.ready_failed', e, {}); } catch { /* never let logging mask the outage */ }
    return json({ ready: false, at, error: 'readiness check failed' }, 503);
  }
};

export const HEAD: APIRoute = async () => {
  const db = await dbPing().catch(() => ({ ok: false }));
  const env = checkEnv(process.env as any);
  const ready = (db as any).ok === true && env.errors.length === 0;
  return new Response(null, { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store, max-age=0' } });
};
