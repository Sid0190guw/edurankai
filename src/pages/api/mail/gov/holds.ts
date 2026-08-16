// GET  /api/mail/gov/holds   the legal holds on an organization
// POST /api/mail/gov/holds   { action: 'place' | 'release', ... }
//
// A hold stops records being DELETED. It does not let anybody read them — that is a support content
// grant, approved by a different person under a different capability. Collapsing the two would mean
// anybody who can type a matter reference can read a customer's mail, which is the shape of every
// "legal hold" feature that turns into a surveillance tool.
//
// PLACING IS A PLATFORM ACT, RELEASING IS THE OWNER'S. `hold.place` belongs to platform
// administrators; `hold.release` belongs to the platform owner alone. That asymmetry is deliberate:
// placing a hold over-preserves, which is recoverable, and releasing one makes records deletable,
// which is not.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam, readJson } from '@/lib/mailgov/http';
import { auditedWrite, requireGov } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import { HOLD_SCOPES, listHolds, placeHold, releaseHold, type HoldScope } from '@/lib/mailgov/holds';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'hold.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const list = await listHolds({
    orgId: orgParam(url, g.actor.orgId),
    status: (url.searchParams.get('status') as 'active' | 'released') || null,
  });
  return govJson({
    ok: list.ok, error: list.ok ? null : list.reason,
    holds: list.ok ? list.rows : [],
    scopes: HOLD_SCOPES,
    note: 'A hold prevents deletion. It does not grant access to the held records.',
  });
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const action = String(body.action || '');
  const orgId = String(body.orgId || url.searchParams.get('org') || '');

  if (action === 'place') {
    const g = await requireGov(locals, 'hold.place', { orgId }, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.HOLD_PLACED, orgId,
        targetType: 'legal_hold', targetId: String(body.scopeRef || orgId),
        reason: String(body.reason || ''),
        meta: { scope: body.scope, matterRef: body.matterRef }, facts: g.facts,
      },
      async () => {
        const r = await placeHold({
          orgId,
          matterRef: String(body.matterRef || ''),
          matterId: body.matterId ? String(body.matterId) : null,
          scope: String(body.scope || '') as HoldScope,
          scopeRef: body.scopeRef ? String(body.scopeRef) : null,
          reason: String(body.reason || ''),
          placedBy: g.actor.userId as string,
        });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error, id: out.data?.id }, out.ok ? 200 : 400);
  }

  if (action === 'release') {
    const g = await requireGov(locals, 'hold.release', { orgId }, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.HOLD_RELEASED, orgId,
        targetType: 'legal_hold', targetId: String(body.id || ''),
        reason: String(body.reason || ''), facts: g.facts,
      },
      async () => {
        const r = await releaseHold({ id: String(body.id || ''), byUserId: g.actor.userId as string, reason: String(body.reason || '') });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({
      ok: out.ok, error: out.error,
      note: out.ok ? 'The records this hold covered are now subject to the ordinary retention policy again.' : undefined,
    }, out.ok ? 200 : 400);
  }

  return govJson({ ok: false, error: 'Unknown action: ' + action + '.', actions: ['place', 'release'] }, 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET', 'POST']);
