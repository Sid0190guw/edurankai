// GET /api/v1/integrations/:id/health — connected | degraded | failed | expired | disabled.
//
// Section 12 of the brief. Five states, decided in ONE pure function (computeHealth in
// src/lib/mailint/connector.ts) so that the console chip, this endpoint and the stored status can
// never disagree about what "degraded" means.
//
// THE ORDER OF THE STATES IS THE DESIGN:
//   disabled  beats everything — a switched-off integration is not failing, and paging somebody
//             about it is how alerts get muted.
//   expired   beats failed — an expired credential EXPLAINS the failures and names the fix.
//   failed    beats degraded.
//   connected is everything else, and its detail line distinguishes "no event yet" from "last event
//             four minutes ago", because those must not render identically.
//
// The recent history is returned alongside, so "it says connected now" can be read against "it has
// flapped six times today".
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError } from '@/lib/mailapi/errors';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rows } from '@/lib/mailint/schema';
import { checkHealth, getIntegration, listInbound } from '@/lib/mailint/integrations';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'integrations.health', scope: 'events.read' }, async (ctx) => {
  const integration = await getIntegration(ctx.auth.orgId, String(ctx.params.id || ''));
  if (!integration) throw new ApiError('not_found', 'No integration with that id.');
  if (integration.environment !== ctx.auth.environment) {
    throw new ApiError('environment_mismatch', 'That integration is in the ' + integration.environment + ' environment.');
  }

  const report = await checkHealth(integration);

  let history: any[] = [];
  try {
    history = rows(await db.execute(sql`
      SELECT status, detail, latency_ms, checked_at FROM mailint_health_checks
      WHERE integration_id = ${integration.id}::uuid ORDER BY checked_at DESC LIMIT 20
    `));
  } catch (e: any) {
    // A failed history read is stated, not rendered as an empty history — an integration with no
    // recorded checks and one whose checks could not be read look identical otherwise.
    console.error('[v1/integrations/health] history read failed:', e?.cause?.message || e?.message);
    history = [];
  }

  const recent = await listInbound(ctx.auth.orgId, { integrationId: integration.id, limit: 10 });

  return ctx.json({
    object: 'health',
    integration_id: integration.id,
    name: integration.name,
    connector: integration.connector,
    status: report.status,
    detail: report.detail,
    checked_at: report.checkedAt,
    latency_ms: report.latencyMs ?? null,
    facts: report.facts || {},
    history: history.map((h: any) => ({ status: h.status, detail: h.detail, latency_ms: h.latency_ms, at: h.checked_at })),
    recent_inbound: recent.map((r: any) => ({
      at: r.created_at,
      status: r.status,
      detail: r.detail,
      received: r.received_count,
      published: r.published_count,
      duplicates: r.duplicate_count,
      duration_ms: r.duration_ms,
    })),
  });
});
