// GET  /api/mail/gov/security   the security event centre
// POST /api/mail/gov/security   { action: 'resolve' | 'record', ... }
//
// `record` is here so the rest of the platform — the API key check, the SMTP edge, the campaign
// sender — has ONE place to report a signal to, rather than each growing its own log line in its own
// format. It is authorised like everything else; a security recorder that anybody can post to is a
// way to bury a real event under noise.
//
// TRIAGE REQUIRES A NOTE. Marking something resolved or a false positive without saying what was
// found produces a clean board and no knowledge — six weeks later nobody can tell an investigated
// event from a dismissed one.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam, readJson } from '@/lib/mailgov/http';
import { auditedWrite, requireGov } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import { listSecurityEvents, recordSecurityEvent, resolveSecurityEvent, securitySummary } from '@/lib/mailgov/security-events';
import { SECURITY_EVENTS, SECURITY_FAMILIES, type SecurityEventStatus, type SecuritySeverity } from '@/lib/mailgov/security-policy';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'security.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const orgId = orgParam(url, g.actor.orgId);
  const list = await listSecurityEvents({
    orgId,
    family: url.searchParams.get('family'),
    type: url.searchParams.get('type'),
    severity: (url.searchParams.get('severity') as SecuritySeverity) || null,
    status: (url.searchParams.get('status') as SecurityEventStatus) || null,
    subject: url.searchParams.get('subject'),
    since: url.searchParams.get('since'),
    limit: Number(url.searchParams.get('limit')) || 100,
  });
  const summary = await securitySummary(orgId, Number(url.searchParams.get('hours')) || 168);

  return govJson({
    ok: list.ok,
    error: list.ok ? null : list.reason,
    events: list.ok ? list.rows : [],
    summary,
    families: SECURITY_FAMILIES,
    catalogue: Object.values(SECURITY_EVENTS).map((s) => ({ type: s.type, family: s.family, severity: s.severity, label: s.label })),
    // Stated in the payload, not only in the documentation: nothing on this screen has acted on
    // anybody. Every entry is a report for a person to decide about.
    advisoryOnly: true,
  });
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const action = String(body.action || '');
  const orgId = String(body.orgId || url.searchParams.get('org') || '') || null;

  if (action === 'resolve') {
    const g = await requireGov(locals, 'security.resolve', { orgId: orgId || undefined }, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      {
        actor: g.actor, action: 'security.event_triaged', orgId,
        targetType: 'security_event', targetId: String(body.id || ''),
        reason: String(body.note || ''), meta: { status: body.status }, facts: g.facts,
      },
      async () => {
        const r = await resolveSecurityEvent({
          id: String(body.id || ''),
          status: String(body.status || 'acknowledged') as SecurityEventStatus,
          note: String(body.note || ''),
          byUserId: g.actor.userId as string,
        });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  if (action === 'record') {
    const g = await requireGov(locals, 'security.resolve', { orgId: orgId || undefined }, request);
    if (g.denied) return g.denied;

    const ok = await recordSecurityEvent({
      type: String(body.type || ''),
      orgId,
      environment: body.environment ? String(body.environment) : null,
      subject: body.subject ? String(body.subject) : null,
      actorUserId: g.actor.userId,
      ip: g.facts.ip,
      requestId: g.facts.requestId,
      detail: (body.detail && typeof body.detail === 'object') ? body.detail : {},
      severity: body.severity as SecuritySeverity | undefined,
    });
    return govJson({ ok, error: ok ? null : 'The event could not be recorded; the reason is in the server log.' }, ok ? 200 : 500);
  }

  // A policy change on the security screen is one of the audit actions the brief names explicitly.
  if (action === 'policy_changed') {
    const g = await requireGov(locals, 'security.resolve', { orgId: orgId || undefined }, request);
    if (g.denied) return g.denied;
    const out = await auditedWrite(
      { actor: g.actor, action: AUDIT_ACTIONS.SECURITY_POLICY_CHANGED, orgId, targetType: 'security_policy', targetId: String(body.policy || ''), reason: String(body.reason || ''), meta: body.change || {}, facts: g.facts },
      async () => true,
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  return govJson({ ok: false, error: 'Unknown action: ' + action + '.', actions: ['resolve', 'record', 'policy_changed'] }, 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET', 'POST']);
