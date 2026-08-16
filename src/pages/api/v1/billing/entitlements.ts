// GET  /api/v1/billing/entitlements?orgId=...  — the whole capability matrix for this caller
// POST /api/v1/billing/entitlements            — ask about one capability, with an amount
//
// The POST is what another subsystem calls before doing expensive work: "may this tenant send to
// 40,000 recipients?" is a question worth asking BEFORE the campaign starts, and it is the same
// question the send path itself asks, answered by the same engine.
//
// ASKING IS NOT CONSUMING. Neither verb records usage. A caller that goes on to do the work meters
// it through the send/API path; a caller that changes its mind leaves no trace, which is the only
// way a "can I?" endpoint can be safe to call from a UI that re-renders.
import type { APIRoute } from 'astro';
import { error, ok, preflight, readJson, requirePrincipal } from '@/lib/mailplatform/api';
import {
  checkCapabilityForPrincipal,
  explainCapabilities,
  resolveTenantForUser,
} from '@/lib/mailplatform/saas/service';
import { CAPABILITIES, isCapability } from '@/lib/mailplatform/saas/entitlements';

export const prerender = false;
export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const url = new URL(ctx.request.url);

  const orgId = await resolveTenantForUser(auth.principal.id, url.searchParams.get('orgId'));
  if (!orgId) return error('forbidden', 403, 'not_a_member');

  try {
    const decisions = await explainCapabilities(orgId, auth.principal.id);
    return ok({
      orgId,
      capabilities: decisions.map((d) => ({
        key: d.capability,
        label: CAPABILITIES[d.capability].label,
        allowed: d.allowed,
        reason: d.reason,
        message: d.message,
        requiredFeature: d.requiredFeature,
        upgradeToPlanKey: d.upgradeToPlanKey,
        meters: CAPABILITIES[d.capability].meters,
      })),
    });
  } catch (e: any) {
    const detail = String(e?.cause?.message || e?.message || 'unknown error');
    console.error('[api/v1/billing/entitlements] read failed -', detail);
    return error('The entitlements could not be read: ' + detail, 500, 'read_failed');
  }
};

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx);
  if (auth instanceof Response) return auth;
  const body = await readJson<{ capability?: string; amount?: number; critical?: boolean }>(ctx.request);
  if (body instanceof Response) return body;

  if (!isCapability(body.capability)) {
    return error(
      'Unknown capability. Try one of: ' + Object.keys(CAPABILITIES).slice(0, 6).join(', ') + ', and so on.',
      400,
      'unknown_capability',
    );
  }
  const amount = Number.isFinite(body.amount) ? Math.max(0, Number(body.amount)) : 1;

  // The principal carries its own tenant — for an API key that is the only tenant it can ever act
  // in, and there is deliberately no parameter here to point it at another one.
  const decision = await checkCapabilityForPrincipal(auth.principal as any, body.capability, {
    amount,
    // `critical` is honoured only for a critical-eligible capability. A caller asserting it on a
    // campaign send is ignored rather than refused: the assertion is meaningless there, not hostile.
    critical: body.critical === true,
  });

  return ok({
    capability: decision.capability,
    allowed: decision.allowed,
    reason: decision.reason,
    message: decision.message,
    metric: decision.metric,
    overage: decision.overage,
    notice: decision.notice,
    requiredFeature: decision.requiredFeature,
    upgradeToPlanKey: decision.upgradeToPlanKey,
    limits: decision.limits.map((l) => ({
      metric: l.metric, used: l.used, limit: l.limit, state: l.state, remaining: l.remaining,
    })),
  });
};
