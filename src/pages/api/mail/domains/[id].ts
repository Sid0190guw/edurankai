// GET    /api/mail/domains/:id  — the whole picture: records to publish, last check, keys, step.
// PATCH  /api/mail/domains/:id  — purpose, settings, suspend/resume, activate/deactivate sending.
// DELETE /api/mail/domains/:id  — soft-remove, refused while anything still depends on it.
import type { APIRoute } from 'astro';
import { guard, json, body, respond } from '@/lib/mailplatform/domains/api';
import { domainView } from '@/lib/mailplatform/domains/service';
import {
  updateDomainPurpose, setDomainSuspended, setSendingEnabled, removeDomain, saveDomainSettings, getDomain,
} from '@/lib/mailplatform/domains/store';
import { policyChangeGuard, type DmarcPolicy } from '@/lib/mailplatform/domains/dmarc';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** The actions PATCH accepts. Named rather than inferred, so an unknown one is refused loudly. */
const ACTIONS = ['purpose', 'settings', 'suspend', 'resume', 'activate', 'deactivate'] as const;
type Action = (typeof ACTIONS)[number];

export const GET: APIRoute = async ({ request, locals, params }) => {
  const g = await guard(request, locals, 'domains.read');
  if (!g.ok) return g.response;
  try {
    const view = await domainView(g.ctx, String(params.id || ''));
    if (!view) return json({ ok: false, error: 'Domain not found.', code: 'not_found' }, 404);
    return json({ ok: true, data: view });
  } catch (e: any) {
    return json({ ok: false, error: causeOf(e), code: 'db_error' }, 500);
  }
};

export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const g = await guard(request, locals, 'domains.manage');
  if (!g.ok) return g.response;
  const id = String(params.id || '');
  const input = await body<any>(request);
  if (!input) return json({ ok: false, error: 'The request body was not valid JSON.', code: 'bad_body' }, 400);

  const action = String(input.action || '') as Action;
  if (!ACTIONS.includes(action)) {
    return json({ ok: false, error: 'Unknown action. Expected one of: ' + ACTIONS.join(', ') + '.', code: 'bad_action' }, 400);
  }

  if (action === 'purpose') {
    const purpose = String(input.purpose || '');
    if (!['sending', 'receiving', 'both'].includes(purpose)) {
      return json({ ok: false, error: 'purpose must be sending, receiving or both.', code: 'bad_purpose' }, 400);
    }
    return respond(await updateDomainPurpose(g.ctx, id, purpose as any));
  }

  if (action === 'settings') {
    // THE DMARC GUARD, ENFORCED SERVER-SIDE.
    //
    // The UI asks for confirmation before changing a published policy, and a UI check is a
    // suggestion — this route is reachable with curl and by anything holding a session. A change to
    // a policy that is already published requires `confirm: true` in the body, and the reason it
    // requires it is returned so the caller can show the same sentence.
    if (input.dmarcPolicy) {
      const next = String(input.dmarcPolicy) as DmarcPolicy;
      if (!['none', 'quarantine', 'reject'].includes(next)) {
        return json({ ok: false, error: 'dmarcPolicy must be none, quarantine or reject.', code: 'bad_policy' }, 400);
      }
      try {
        const view = await domainView(g.ctx, id);
        if (!view) return json({ ok: false, error: 'Domain not found.', code: 'not_found' }, 404);
        const verdict = policyChangeGuard(view.publishedDmarcPolicy, next);
        if (verdict.requiresConfirmation && input.confirm !== true) {
          return json({
            ok: false,
            error: verdict.reason,
            code: 'confirmation_required',
            data: { current: view.publishedDmarcPolicy, next, direction: verdict.direction },
          }, 409);
        }
      } catch (e: any) {
        return json({ ok: false, error: causeOf(e), code: 'db_error' }, 500);
      }
    }
    return respond(await saveDomainSettings(g.ctx, id, {
      dmarcPolicy: input.dmarcPolicy ?? undefined,
      trackingDomain: input.trackingDomain ?? undefined,
      openTracking: input.openTracking ?? undefined,
      clickTracking: input.clickTracking ?? undefined,
      customReturnPath: input.customReturnPath ?? undefined,
      bounceAddress: input.bounceAddress ?? undefined,
      maxSendRatePerHour: input.maxSendRatePerHour ?? undefined,
    }));
  }

  if (action === 'suspend') return respond(await setDomainSuspended(g.ctx, id, true));
  if (action === 'resume') return respond(await setDomainSuspended(g.ctx, id, false));
  return respond(await setSendingEnabled(g.ctx, id, action === 'activate'));
};

export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const g = await guard(request, locals, 'domains.manage');
  if (!g.ok) return g.response;
  const id = String(params.id || '');
  const existing = await getDomain(g.ctx.principal.orgId, id);
  if (!existing) return json({ ok: false, error: 'Domain not found.', code: 'not_found' }, 404);
  return respond(await removeDomain(g.ctx, id));
};
