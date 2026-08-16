// GET  /api/mail/gov/orgs            list, or ?org=<id> for one organization with its usage
// POST /api/mail/gov/orgs            { action, orgId, ... }
//
// Organization administration. Every action is a separate capability, checked at the door by
// requireGov() BEFORE the body is read and before any query runs — a read that happened for an
// unauthorised caller has happened whatever the response says.
//
// Every write goes through auditedWrite(), which records the intent FIRST and refuses to perform the
// action if the audit could not be written. That ordering is the point: an administrative action
// nobody can prove happened is the one thing this console must not produce.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam, readJson } from '@/lib/mailgov/http';
import { auditedWrite, requireGov } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import { getOrg, listOrgs, orgUsage, platformOverview, restoreOrg, rotateOrgCredentials, setOrgControl, suspendOrg } from '@/lib/mailgov/orgs';
import { recordSecurityEvent } from '@/lib/mailgov/security-events';
import type { GovCapability } from '@/lib/mailgov/policy';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'org.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const orgId = orgParam(url, g.actor.orgId);

  if (orgId) {
    const one = await getOrg(orgId);
    if (!one.ok) return govJson({ ok: false, error: one.reason }, 404);
    const usage = await orgUsage(orgId);
    return govJson({ ok: true, organization: one.org, usage });
  }

  const list = await listOrgs({ orgId: g.actor.orgId, q: url.searchParams.get('q') });
  if (!list.ok) return govJson({ ok: false, error: list.reason }, 500);
  const overview = g.actor.orgId ? null : await platformOverview();
  return govJson({ ok: true, organizations: list.rows, overview });
};

/** Which capability each action needs. A missing entry is refused, not defaulted. */
const ACTION_CAPABILITY: Record<string, GovCapability> = {
  suspend: 'org.suspend',
  restore: 'org.restore',
  disable_sending: 'org.sending.disable',
  enable_sending: 'org.sending.disable',
  disable_receiving: 'org.receiving.disable',
  enable_receiving: 'org.receiving.disable',
  disable_campaigns: 'org.campaigns.disable',
  enable_campaigns: 'org.campaigns.disable',
  rotate_credentials: 'org.credentials.rotate',
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const action = String(body.action || '');
  const capability = ACTION_CAPABILITY[action];
  if (!capability) {
    return govJson({ ok: false, error: 'Unknown action: ' + (action || '(none)') + '.', actions: Object.keys(ACTION_CAPABILITY) }, 400);
  }

  const orgId = String(body.orgId || url.searchParams.get('org') || '');
  const g = await requireGov(locals, capability, { orgId }, request);
  if (g.denied) return g.denied;
  if (!orgId) return govJson({ ok: false, error: 'Name the organization.' }, 400);

  const reason = String(body.reason || '');

  // ---- suspend / restore -----------------------------------------------------------------------
  if (action === 'suspend') {
    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.ORG_SUSPENDED, orgId, targetType: 'organization', targetId: orgId, reason, facts: g.facts },
      async () => {
        const r = await suspendOrg({ orgId, reason, byUserId: g.actor.userId as string });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  if (action === 'restore') {
    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.ORG_RESTORED, orgId, targetType: 'organization', targetId: orgId, reason, facts: g.facts },
      async () => {
        const r = await restoreOrg({ orgId, byUserId: g.actor.userId as string });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  // ---- the three finer stops --------------------------------------------------------------------
  const CONTROLS: Record<string, { control: 'sending' | 'receiving' | 'campaigns'; enabled: boolean; audit: string }> = {
    disable_sending: { control: 'sending', enabled: false, audit: AUDIT_ACTIONS.ORG_SENDING_DISABLED },
    enable_sending: { control: 'sending', enabled: true, audit: 'org.sending_enabled' },
    disable_receiving: { control: 'receiving', enabled: false, audit: AUDIT_ACTIONS.ORG_RECEIVING_DISABLED },
    enable_receiving: { control: 'receiving', enabled: true, audit: 'org.receiving_enabled' },
    disable_campaigns: { control: 'campaigns', enabled: false, audit: AUDIT_ACTIONS.ORG_CAMPAIGNS_DISABLED },
    enable_campaigns: { control: 'campaigns', enabled: true, audit: 'org.campaigns_enabled' },
  };
  const control = CONTROLS[action];
  if (control) {
    const out = await auditedWrite(
      { actor: g.actor, action: control.audit, orgId, targetType: 'organization', targetId: orgId, reason, meta: { control: control.control, enabled: control.enabled }, facts: g.facts },
      async () => {
        const r = await setOrgControl({ orgId, control: control.control, enabled: control.enabled, reason });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  // ---- credential rotation ------------------------------------------------------------------------
  if (action === 'rotate_credentials') {
    const environment = String(body.environment || 'production');
    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.ORG_CREDENTIALS_ROTATED, orgId, targetType: 'organization', targetId: orgId, reason, meta: { environment }, facts: g.facts },
      async () => {
        const r = await rotateOrgCredentials({ orgId, environment, byUserId: g.actor.userId as string, reason });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    if (!out.ok) return govJson({ ok: false, error: out.error }, 400);

    await recordSecurityEvent({
      type: 'api.key_revoked_used', orgId, severity: 'info',
      subject: out.data?.newKeyPrefix || null, actorUserId: g.actor.userId,
      ip: g.facts.ip, requestId: g.facts.requestId,
      detail: { rotated: out.data?.revoked || 0, environment, note: 'Credentials rotated by an administrator; every previous key for this environment now fails.' },
    });

    // The plaintext key is in this response and nowhere else, ever. Said in the payload so the
    // operator knows before they close the tab, not after.
    return govJson({
      ok: true,
      revoked: out.data?.revoked || 0,
      newKey: out.data?.newKey,
      newKeyPrefix: out.data?.newKeyPrefix,
      warning: 'This key is shown once and is not recoverable. Every integration using an older key for this environment is now failing — that is what rotation means.',
    });
  }

  return govJson({ ok: false, error: 'Unhandled action.' }, 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET', 'POST']);
