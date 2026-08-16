// GET  /api/v1/domains — sending identities and their DNS posture. Scope: domains.read
// POST /api/v1/domains — register one, or re-run its checks.       Scope: domains.write
//
// A DOMAIN IS NOT "FAILING" BECAUSE A LOOKUP TIMED OUT. Each record reports whether the check RAN
// (`checked`) separately from what it found (`ok`). The distinction matters more here than almost
// anywhere else in this API: the documented fix for a missing SPF record is to add one, and a domain
// that already has an SPF record and gains a second is treated by every large provider as a
// permanent SPF failure. A resolver hiccup rendered as "no SPF record" could therefore talk an
// operator into breaking mail for the whole company.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody, ApiError } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { addDomain, listDomains, verifyDomain, removeDomain, checkDomain } from '@/lib/mailapi/domains';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'domains.list', scope: 'domains.read' }, async (ctx) => {
  const domains = await listDomains(ctx.auth.orgId, ctx.auth.environment);
  return ctx.json({
    object: 'list',
    environment: ctx.auth.environment,
    count: domains.length,
    data: domains.map((d) => ({
      id: d.id,
      object: 'sending_domain',
      domain: d.domain,
      status: d.status,
      spf: d.spfOk,
      dkim: d.dkimOk,
      dmarc: d.dmarcOk,
      last_checked_at: d.lastCheckedAt,
      checks: d.detail,
    })),
    note: 'A `null` for spf/dkim/dmarc means the lookup could not be completed, not that the record is missing.',
  });
});

export const POST: APIRoute = apiRoute({ endpoint: 'domains.create', scope: 'domains.read' }, async (ctx) => {
  requireScope(ctx.auth, 'domains.write');
  const body = await readJsonBody(ctx.request, 8 * 1024);
  const domain = String(body.domain || '');
  if (!domain) throw new ApiError('invalid_request', 'Send a `domain`.', { param: 'domain' });

  await addDomain(ctx.auth.orgId, ctx.auth.environment, domain);
  const verified = await verifyDomain(ctx.auth.orgId, ctx.auth.environment, domain);
  const checks = verified?.detail || (await checkDomain(domain));

  return ctx.json({
    object: 'sending_domain',
    domain: verified?.domain || domain,
    environment: ctx.auth.environment,
    status: verified?.status || 'unverified',
    spf: verified?.spfOk ?? null,
    dkim: verified?.dkimOk ?? null,
    dmarc: verified?.dmarcOk ?? null,
    checks,
    // Registering a domain here records the intent and reports its DNS state. It does not by itself
    // change which address the mail server authenticates as — that is the SMTP workstream's
    // configuration, and claiming otherwise would be the kind of "reported success" this project has
    // been bitten by.
    note: 'Registered. Sending From this domain also requires the mail server to be authorised for it at /admin/mail/settings; this endpoint records and checks the domain, it does not reconfigure the transport.',
  }, 201);
});

export const DELETE: APIRoute = apiRoute({ endpoint: 'domains.delete', scope: 'domains.read' }, async (ctx) => {
  requireScope(ctx.auth, 'domains.write');
  const domain = ctx.url.searchParams.get('domain') || '';
  if (!domain) throw new ApiError('invalid_request', 'Pass ?domain=example.com', { param: 'domain' });
  const gone = await removeDomain(ctx.auth.orgId, ctx.auth.environment, domain);
  if (!gone) throw new ApiError('not_found', 'That domain is not registered for this organization and environment.');
  return ctx.json({ object: 'sending_domain', domain, deleted: true });
});
