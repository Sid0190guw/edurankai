// GET  /api/v1/billing?orgId=...  — plan, usage, limits, standing, invoices, renewal
// POST /api/v1/billing            — change the plan
//
// One route for the whole billing picture, because every screen that shows any of it shows all of
// it, and three round trips to draw one panel is three chances for the panel to disagree with
// itself.
import type { APIRoute } from 'astro';
import { error, ok, preflight, readJson, requirePrincipal } from '@/lib/mailplatform/api';
import {
  billingOverview,
  changeOrganizationPlan,
  resolveTenantForUser,
} from '@/lib/mailplatform/saas/service';
import { PLAN_CATALOG, describeLimit, describeMetricValue, limitFor, METRICS } from '@/lib/mailplatform/saas/plans';
import { priceFor } from '@/lib/mailplatform/saas/pricing';
import { billingProviderStatus } from '@/lib/mailplatform/saas/billing';
import { daysRemaining, periodProgress, projectedTotal } from '@/lib/mailplatform/saas/usage';

export const prerender = false;
export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const url = new URL(ctx.request.url);

  const orgId = await resolveTenantForUser(auth.principal.id, url.searchParams.get('orgId'));
  if (!orgId) return error('forbidden', 403, 'not_a_member');

  try {
    const view = await billingOverview(orgId);
    if (!view) return error('That organization could not be found.', 404, 'not_found');
    const { context } = view;
    const currency = context.profile?.currency || 'INR';

    return ok({
      organization: {
        id: context.organization.id,
        name: context.organization.name,
        status: context.organization.status,
        type: context.profile?.orgType || null,
      },
      plan: {
        key: context.plan.key,
        name: context.plan.name,
        tier: context.plan.tier,
        isCustom: context.plan.isCustom,
        features: context.plan.features,
      },
      subscription: {
        status: context.subscription.status,
        standing: view.standing,
        periodStart: context.period.start,
        periodEnd: context.period.end,
        // The period boundary is UTC. Said out loud rather than implied — see the header of
        // src/lib/mailplatform/saas/usage.ts for why it is not per-tenant.
        periodTimezone: 'UTC',
        daysRemaining: daysRemaining(context.period),
        progress: Number(periodProgress(context.period).toFixed(4)),
        pendingPlanKey: context.subscription.pendingPlanKey,
        pendingPlanAt: context.subscription.pendingPlanAt,
        cancelAt: context.subscription.cancelAt,
        provider: context.subscription.provider,
        suspension: view.suspension,
      },
      usage: view.statuses.map((s) => ({
        metric: s.metric,
        label: METRICS[s.metric].label,
        kind: s.kind,
        used: s.used,
        usedText: describeMetricValue(s.metric, s.used),
        limit: s.limit,
        limitText: describeLimit(s.limit, METRICS[s.metric].unit),
        ratio: Number(s.ratio.toFixed(4)),
        state: s.state,
        overage: s.overage,
        remaining: s.remaining,
        // Only meaningful for a counter: projecting a level that does not accumulate is nonsense.
        projected: s.kind === 'counter' ? projectedTotal(s.used, context.period) : null,
      })),
      attention: view.attention.map((s) => ({ metric: s.metric, state: s.state, ratio: Number(s.ratio.toFixed(4)) })),
      invoices: view.invoices,
      events: view.events.map((e) => ({
        type: e.type, occurredAt: e.occurredAt, provider: e.provider, error: e.error,
      })),
      enterprise: context.enterprise,
      providers: billingProviderStatus(),
      catalog: PLAN_CATALOG.map((p) => {
        const price = priceFor(p.key, currency, 'month');
        return {
          key: p.key,
          name: p.name,
          tier: p.tier,
          description: p.description,
          features: p.features,
          // A plan with no published price is quoted, not free. `null` says so; 0 would lie.
          monthlyAmountMinor: price ? price.amountMinor : null,
          currency,
          limits: Object.fromEntries(
            Object.keys(METRICS).map((m) => [m, limitFor(m as any, p.limits)]),
          ),
        };
      }),
    });
  } catch (e: any) {
    const detail = String(e?.cause?.message || e?.message || 'unknown error');
    console.error('[api/v1/billing] read failed -', detail);
    return error('The billing summary could not be read: ' + detail, 500, 'read_failed');
  }
};

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<{ orgId?: string; planKey?: string }>(ctx.request);
  if (body instanceof Response) return body;

  const orgId = await resolveTenantForUser(auth.principal.id, body.orgId || null);
  if (!orgId) return error('forbidden', 403, 'not_a_member');
  if (!body.planKey) return error('Which plan? Send a planKey.', 400, 'missing_plan');

  const result = await changeOrganizationPlan(orgId, auth.principal.id, String(body.planKey));
  if (!result.ok) return error(result.message, 409, 'refused');
  return ok({
    orgId,
    planKey: result.subscription?.planKey,
    pendingPlanKey: result.subscription?.pendingPlanKey || null,
    immediate: result.immediate,
    effectiveAt: result.effectiveAt,
    message: result.message,
  });
};
