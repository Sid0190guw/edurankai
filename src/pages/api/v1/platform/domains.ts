// GET  /api/v1/platform/domains — domains, their DNS status and the records to publish.
// POST /api/v1/platform/domains — add a domain, verify one (?action=verify), rotate DKIM
//                                 (?action=rotate-dkim), or register a sending identity
//                                 (?action=identity).
//
// THE PRIVATE KEY IS RETURNED EXACTLY ONCE, in the response to the POST that mints it, and is never
// written to the database. If it is lost, the fix is a rotation, not a lookup. That is deliberately
// inconvenient — the convenient design stores the key where any read of the domains table exposes
// the ability to sign mail as the domain, which is the one thing DKIM exists to prevent.

import type { APIRoute } from 'astro';
import { audit, error, ok, preflight, readJson, requirePrincipal } from '@/lib/mailplatform/api';
import {
  addDomain,
  addSendingIdentity,
  getActiveDkim,
  listDomains,
  listSendingIdentities,
  requiredRecords,
  rotateDkim,
  verificationHistory,
  verifyDomain,
} from '@/lib/mailplatform/domains';

export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'domains.read');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const url = new URL(ctx.request.url);
  const id = url.searchParams.get('id');

  if (id) {
    const records = await requiredRecords(principal.orgId, id);
    const dkim = await getActiveDkim(id);
    return ok({
      records,
      // Public key only. `privateKeyRef` names WHERE the signing key lives; the key itself is not
      // in this response and is not in the database.
      dkim: dkim
        ? {
            selector: dkim.selector,
            algorithm: dkim.algorithm,
            status: dkim.status,
            publicKey: dkim.publicKey,
            privateKeyRef: dkim.privateKeyRef,
          }
        : null,
      verifications: await verificationHistory(principal.orgId, id),
    });
  }

  return ok({
    domains: await listDomains(principal.orgId),
    identities: await listSendingIdentities(principal.orgId),
  });
};

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'domains.manage');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const url = new URL(ctx.request.url);
  const action = url.searchParams.get('action');
  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;

  if (action === 'verify') {
    const id = String(body.domainId || url.searchParams.get('id') || '');
    if (!id) return error('"domainId" is required.', 422, 'no_domain');
    const result = await verifyDomain(principal.orgId, id);
    await audit({
      principal,
      request: ctx.request,
      action: 'domain.verify',
      targetType: 'domain',
      targetId: id,
      meta: { status: result.status },
    });
    if (!result.ok) return error(result.error || 'Verification could not run.', 422, 'verify_failed');
    // 200 even when checks fail: the verification RAN, and the per-check detail is the answer. A
    // non-2xx here would make "your DNS is not published yet" look like a broken endpoint.
    return ok({
      status: result.status,
      verified: result.status === 'verified',
      checks: result.checks.map((c) => ({
        check: c.checkType,
        status: c.status,
        expected: c.expected,
        observed: c.observed,
        detail: c.detail,
      })),
    });
  }

  if (action === 'rotate-dkim') {
    const id = String(body.domainId || url.searchParams.get('id') || '');
    if (!id) return error('"domainId" is required.', 422, 'no_domain');
    const result = await rotateDkim(principal.orgId, id);
    await audit({ principal, request: ctx.request, action: 'domain.dkim.rotate', targetType: 'domain', targetId: id });
    if (!result.ok) return error(result.error || 'The key was not rotated.', 422, 'rotate_failed');
    return ok({
      dkim: { selector: result.dkim?.selector, status: result.dkim?.status, privateKeyRef: result.dkim?.privateKeyRef },
      record: result.record,
      privateKeyPem: result.privateKeyPem,
      instructions: [
        `1. Put the private key in your MTA's secret store under ${result.dkim?.privateKeyRef}.`,
        '2. Publish the TXT record above.',
        '3. Wait for DNS to propagate, then run verification. Only then does the new key start signing.',
        '4. Keep the OLD key published for at least a week — messages already in flight were signed with it.',
      ],
    }, 201);
  }

  if (action === 'identity') {
    if (!body.fromAddress) return error('"fromAddress" is required.', 422, 'no_address');
    const result = await addSendingIdentity({
      orgId: principal.orgId,
      fromAddress: String(body.fromAddress),
      fromName: (body.fromName as string) || null,
      replyTo: (body.replyTo as string) || null,
      isDefault: body.isDefault === true,
    });
    await audit({
      principal,
      request: ctx.request,
      action: 'domain.identity.add',
      targetType: 'identity',
      targetId: result.identityId || null,
      meta: { fromAddress: body.fromAddress },
    });
    if (!result.ok) return error(result.error || 'The identity was not registered.', 422, 'identity_failed');
    return ok({ identityId: result.identityId }, 201);
  }

  // --- default: add a domain ---
  if (!body.domain) return error('"domain" is required.', 422, 'no_domain');

  const result = await addDomain({
    orgId: principal.orgId,
    domain: String(body.domain),
    purpose: (body.purpose as any) || 'both',
    actorId: principal.kind === 'user' ? principal.id : null,
  });
  if (!result.ok) return error(result.error || 'The domain was not added.', 422, 'add_failed');

  await audit({
    principal,
    request: ctx.request,
    action: 'domain.add',
    targetType: 'domain',
    targetId: result.domain?.id || null,
    meta: { domain: body.domain },
  });

  return ok(
    {
      domain: result.domain,
      records: result.records,
      dkim: { selector: result.dkim?.selector, privateKeyRef: result.dkim?.privateKeyRef },
      privateKeyPem: result.privateKeyPem,
      instructions: [
        `1. Store the private key below in your MTA's secret store under ${result.dkim?.privateKeyRef}. It is shown ONCE and is not saved here.`,
        '2. Publish every record marked required at your DNS host.',
        '3. POST back with ?action=verify. The domain cannot send until verification passes.',
      ],
    },
    201,
  );
};
