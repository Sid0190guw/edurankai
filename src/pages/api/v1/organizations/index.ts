// GET  /api/v1/organizations  — the tenants this caller belongs to
// POST /api/v1/organizations  — create one, with the caller as its Owner
//
// The list is deliberately NOT "all organizations". A caller sees the tenants they are a member of
// and nothing else, because a complete tenant list is a customer list, and handing one to any
// authenticated caller is the cheapest possible competitive-intelligence exercise.
import type { APIRoute } from 'astro';
import { error, ok, preflight, readJson, requirePrincipal } from '@/lib/mailplatform/api';
import { createOrganization, getSaasStore } from '@/lib/mailplatform/saas/service';
import { ORG_TYPE_DEFAULTS, PLAN_CATALOG, isOrganizationType } from '@/lib/mailplatform/saas/plans';

export const prerender = false;
export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  try {
    const orgs = await getSaasStore().listOrganizationsForUser(principal.id);
    return ok({
      organizations: orgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name, status: o.status })),
      // The catalog travels with the list so a signup form does not need a second round trip.
      organizationTypes: Object.entries(ORG_TYPE_DEFAULTS).map(([key, d]) => ({
        key, label: d.label, suggestedPlanKey: d.suggestedPlanKey, rationale: d.rationale,
      })),
      plans: PLAN_CATALOG.map((p) => ({ key: p.key, name: p.name, tier: p.tier, description: p.description })),
    });
  } catch (e: any) {
    // The real Postgres reason is on `cause`; `message` is only the SQL that failed.
    const detail = String(e?.cause?.message || e?.message || 'unknown error');
    console.error('[api/v1/organizations] list failed -', detail);
    return error('The organization list could not be read: ' + detail, 500, 'read_failed');
  }
};

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const body = await readJson<{ name?: string; orgType?: string; planKey?: string; billingEmail?: string; country?: string }>(ctx.request);
  if (body instanceof Response) return body;

  const name = String(body.name || '').trim();
  if (name.length < 2) return error('An organization needs a name of at least two characters.', 400, 'invalid_name');
  if (!isOrganizationType(body.orgType)) {
    return error(
      'Pick an organization type: ' + Object.keys(ORG_TYPE_DEFAULTS).join(', ') + '.',
      400,
      'invalid_org_type',
    );
  }
  // An explicit plan wins over the type's suggestion — the type suggests, it never imposes.
  const planKey = body.planKey ? String(body.planKey) : undefined;
  if (planKey && !PLAN_CATALOG.some((p) => p.key === planKey)) {
    return error('There is no plan called "' + planKey + '".', 400, 'unknown_plan');
  }

  try {
    const { organization, subscription } = await createOrganization({
      name,
      orgType: body.orgType,
      createdByUserId: principal.id,
      billingEmail: body.billingEmail ? String(body.billingEmail).trim() : null,
      country: body.country ? String(body.country).trim() : null,
      planKey,
    });
    return ok({
      organization: { id: organization.id, slug: organization.slug, name: organization.name },
      subscription: { planKey: subscription.planKey, status: subscription.status, periodEnd: subscription.periodEnd },
    }, 201);
  } catch (e: any) {
    const detail = String(e?.cause?.message || e?.message || 'unknown error');
    console.error('[api/v1/organizations] create failed -', detail);
    return error('The organization could not be created: ' + detail, 500, 'create_failed');
  }
};
