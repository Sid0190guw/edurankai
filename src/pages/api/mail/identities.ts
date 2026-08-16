// GET    /api/mail/identities         — the From addresses this organization may send as.
// POST   /api/mail/identities         — create one on a domain the organization owns.
// PATCH  /api/mail/identities         — display name, Reply-To, purpose, default.
// DELETE /api/mail/identities?id=...  — soft delete.
import type { APIRoute } from 'astro';
import { guard, json, body, respond } from '@/lib/mailplatform/domains/api';
import { listIdentities, createIdentity, updateIdentity, deleteIdentity, listDomains } from '@/lib/mailplatform/domains/store';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const GET: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'domains.read');
  if (!g.ok) return g.response;
  try {
    const [identities, domains] = await Promise.all([listIdentities(g.ctx.principal.orgId), listDomains(g.ctx.principal.orgId)]);
    return json({
      ok: true,
      data: {
        identities: identities.map((i) => ({
          ...i,
          // Being VERIFIED and being able to SEND are different questions, and an identity screen
          // that only answers the first one leaves people wondering why a green row bounces.
          canSend: i.isVerified && i.domainLifecycle === 'ACTIVE',
          blockedBecause: !i.isVerified
            ? 'The domain this address is on has not passed its sending checks yet.'
            : i.domainLifecycle !== 'ACTIVE'
              ? 'The domain is verified but sending has not been turned on for it.'
              : null,
        })),
        domains: domains.map((d) => ({ id: d.id, domain: d.domain, lifecycle: d.lifecycle })),
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: causeOf(e), code: 'db_error' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'domains.manage');
  if (!g.ok) return g.response;
  const input = await body<any>(request);
  if (!input?.fromAddress) return json({ ok: false, error: 'fromAddress is required.', code: 'missing_address' }, 400);
  return respond(await createIdentity(g.ctx, {
    fromAddress: String(input.fromAddress),
    fromName: input.fromName ?? null,
    replyTo: input.replyTo ?? null,
    purpose: input.purpose ?? null,
    isDefault: input.isDefault === true,
  }), 201);
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'domains.manage');
  if (!g.ok) return g.response;
  const input = await body<any>(request);
  if (!input?.id) return json({ ok: false, error: 'id is required.', code: 'missing_id' }, 400);
  return respond(await updateIdentity(g.ctx, String(input.id), {
    fromName: input.fromName,
    replyTo: input.replyTo,
    purpose: input.purpose,
    isDefault: input.isDefault,
  }));
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'domains.manage');
  if (!g.ok) return g.response;
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: 'id is required.', code: 'missing_id' }, 400);
  return respond(await deleteIdentity(g.ctx, id));
};
