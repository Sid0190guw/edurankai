// GET  /api/mail/domains  — every domain in the caller's organization, with its health roll-up.
// POST /api/mail/domains  — add one.
//
// Every const is declared before the handler that uses it. `const` is not hoisted, and on this
// project a const declared below a POST handler has taken a page down on its first line while the
// page itself reported success.
import type { APIRoute } from 'astro';
import { guard, json, body, respond } from '@/lib/mailplatform/domains/api';
import { listDomains, addDomain } from '@/lib/mailplatform/domains/store';
import { domainListView } from '@/lib/mailplatform/domains/service';
import { getProfile, profileCapabilities } from '@/lib/mailplatform/profile';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const GET: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'domains.read');
  if (!g.ok) return g.response;
  try {
    const domains = await listDomains(g.ctx.principal.orgId);
    const view = await domainListView(g.ctx, domains);
    const profile = getProfile();
    return json({
      ok: true,
      data: {
        domains: view,
        // The deployment's own gaps travel with the list, so a screen can explain an empty MX
        // section as "this deployment has not been configured" rather than as the customer's fault.
        deployment: { id: profile.id, label: profile.label, source: profile.source, ...profileCapabilities(profile) },
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: causeOf(e), code: 'db_error' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'domains.manage');
  if (!g.ok) return g.response;
  const input = await body<{ domain?: string; purpose?: 'sending' | 'receiving' | 'both' }>(request);
  if (!input) return json({ ok: false, error: 'The request body was not valid JSON.', code: 'bad_body' }, 400);
  if (!input.domain) return json({ ok: false, error: 'A domain is required.', code: 'missing_domain' }, 400);
  const result = await addDomain(g.ctx, { domain: input.domain, purpose: input.purpose });
  return respond(result, 201);
};
