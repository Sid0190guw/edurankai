// GET /api/health/deep — everything /api/health reports, plus the signals that DISCLOSE
// CONFIGURATION: the mail host and whether it answers, queue depth, connection-pool pressure, cron
// schedules and their last observed runs, and error volume.
//
// GATED ON AN OPERATOR CAPABILITY, and it fails CLOSED. src/middleware.ts hard-exempts everything
// under /api/ (isExempt), so an API route is structurally an unguarded URL and whatever it checks
// for itself is the only thing in front of it. The check is `administer` on the platform — the same
// capability /admin/hardening and /admin/ops ask for — so the URL can never answer more than the
// page it belongs to. No shared-secret bypass: a secret in a header is not a role, and every
// fail-open guard on this project was written as a condition that short-circuits when the secret is
// unset. There is nothing here to short-circuit.
//
// It runs more work than the shallow check, so it is NOT the endpoint to poll on an interval. Point
// the uptime monitor at /api/health and open this one when that one goes red.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac/guard';
import { deepHealth, recordRelease } from '@/lib/observability-health';

export const prerender = false;

const json = (body: any, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store, max-age=0' },
  });

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ error: 'authentication required' }, 401);
  let allowed = false;
  try {
    const gate = await can(user, 'administer', { type: 'platform' });
    allowed = gate.allow === true;
  } catch (e: any) {
    // A refusal that writes nothing anywhere is precisely the incident this workflow exists to
    // prevent: the deny happened, and afterwards nobody could tell it had. Record it, then deny.
    const { trackError } = await import('@/lib/logger');
    await trackError('health.deep_authz_failed', e, { userId: user?.id ?? null });
    allowed = false;
  }
  if (!allowed) return json({ error: 'forbidden' }, 403);

  try {
    // Note the serving commit while an operator is here. Deliberately NOT done in /api/health:
    // that endpoint is polled, and a write per poll is a cost the monitor should not impose.
    await recordRelease();
    const h = await deepHealth();
    return json(h, h.httpCode);
  } catch (e: any) {
    const message = String(e?.cause?.message || e?.message || 'deep health failed').slice(0, 300);
    const { trackError } = await import('@/lib/logger');
    await trackError('health.deep_failed', e, {});
    return json({ status: 'down', at: new Date().toISOString(), error: message }, 503);
  }
};
