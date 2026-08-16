// GET  /api/mail/gov/support   message metadata, delivery trails, and the authorisation queue
// POST /api/mail/gov/support   { action: 'request_content' | 'approve' | 'deny' | 'revoke' | 'read' | 'retry' }
//
// THE DEFAULT RESPONSE FROM THIS ROUTE CONTAINS NO SUBJECT AND NO BODY. The metadata view is built
// field by field in src/lib/mailgov/support-policy.ts from a query that never selects a body column —
// not a full row with two keys deleted, because a projection applied after the fetch is a projection
// somebody eventually forgets.
//
// READING CONTENT TAKES TWO PEOPLE. `request_content` is held by support; `approve` is held by the
// platform owner alone, and approveContentGrant() refuses an approver who is the requester even if
// somebody holds both. Two independent checks on the one control that a single mistake would render
// meaningless.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam, readJson } from '@/lib/mailgov/http';
import { auditedWrite, requireGov } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import {
  approveContentGrant, denyContentGrant, listContentGrants, lookupMessages, messageMetadata,
  readMessageContent, requestContentGrant, retryMessage, revokeContentGrant,
} from '@/lib/mailgov/support';
import type { SupportSubjectType } from '@/lib/mailgov/support-policy';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'support.metadata.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const orgId = orgParam(url, g.actor.orgId);

  if (url.searchParams.get('grants') === '1') {
    const grants = await listContentGrants({ orgId, status: url.searchParams.get('status'), limit: 100 });
    return grants.ok ? govJson({ ok: true, grants: grants.rows }) : govJson({ ok: false, error: grants.reason }, 500);
  }

  const messageId = url.searchParams.get('message');
  if (messageId) {
    const one = await messageMetadata(messageId);
    if (!one.ok) return govJson({ ok: false, error: one.reason }, 404);
    if (g.actor.orgId && one.message?.orgId !== g.actor.orgId) {
      return govJson({ ok: false, error: 'forbidden', code: 'cross-tenant' }, 403);
    }
    return govJson({
      ok: true, message: one.message, events: one.events,
      note: 'Subject and body are withheld. Reading them needs an approved authorisation, which a different person grants.',
    });
  }

  const list = await lookupMessages({
    orgId,
    rfcMessageId: url.searchParams.get('rfc'),
    recipient: url.searchParams.get('recipient'),
    status: url.searchParams.get('status'),
    since: url.searchParams.get('since'),
    limit: Number(url.searchParams.get('limit')) || 50,
  });
  return govJson({ ok: list.ok, error: list.ok ? null : list.reason, messages: list.ok ? list.rows : [] });
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const action = String(body.action || '');
  const orgId = String(body.orgId || url.searchParams.get('org') || '');

  if (action === 'request_content') {
    const g = await requireGov(locals, 'support.content.request', { orgId }, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.SUPPORT_CONTENT_REQUESTED, orgId,
        targetType: String(body.subjectType || 'message'), targetId: String(body.subjectId || ''),
        reason: String(body.reason || ''), meta: { matterRef: body.matterRef || null }, facts: g.facts,
      },
      async () => {
        const r = await requestContentGrant({
          orgId,
          subjectType: String(body.subjectType || 'message') as SupportSubjectType,
          subjectId: String(body.subjectId || ''),
          reason: String(body.reason || ''),
          matterRef: body.matterRef ? String(body.matterRef) : null,
          requestedBy: g.actor.userId as string,
        });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({
      ok: out.ok, error: out.error, grantId: out.data?.grantId,
      next: out.ok ? 'Waiting for approval. You cannot approve your own request.' : undefined,
    }, out.ok ? 200 : 400);
  }

  if (action === 'approve' || action === 'deny' || action === 'revoke') {
    const capability = action === 'approve' ? 'support.content.approve' : 'support.content.request';
    const g = await requireGov(locals, capability as any, { orgId }, request);
    if (g.denied) return g.denied;

    if (action === 'approve') {
      const out = await auditedWrite(
        {
          actor: g.actor, action: AUDIT_ACTIONS.SUPPORT_CONTENT_APPROVED, orgId,
          targetType: 'support_grant', targetId: String(body.grantId || ''),
          reason: String(body.reason || 'Authorised a support engineer to read message content.'),
          facts: g.facts,
        },
        async () => {
          const r = await approveContentGrant({ grantId: String(body.grantId || ''), byUserId: g.actor.userId as string, hours: Number(body.hours) || undefined });
          if (!r.ok) throw new Error(r.error);
          return r;
        },
      );
      return govJson({ ok: out.ok, error: out.error, expiresAt: out.data?.expiresAt }, out.ok ? 200 : 400);
    }

    const fn = action === 'deny' ? denyContentGrant : revokeContentGrant;
    const out = await auditedWrite(
      { actor: g.actor, action: 'support.content_' + action, orgId, targetType: 'support_grant', targetId: String(body.grantId || ''), reason: String(body.reason || ''), facts: g.facts },
      async () => {
        const r = await (fn as any)({ grantId: String(body.grantId || ''), byUserId: g.actor.userId as string, reason: String(body.reason || '') });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  if (action === 'read') {
    const g = await requireGov(locals, 'support.content.request', { orgId }, request);
    if (g.denied) return g.denied;

    // The audit event is written BEFORE the body is selected. If it cannot be written, no content is
    // read — the ordering that makes "every content access is logged" true rather than intended.
    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.SUPPORT_CONTENT_ACCESSED, orgId,
        targetType: 'message', targetId: String(body.messageId || ''),
        reason: 'Read message content under authorisation ' + String(body.grantId || ''),
        meta: { grantId: body.grantId }, facts: g.facts,
      },
      async () => readMessageContent({
        grantId: String(body.grantId || ''),
        messageId: String(body.messageId || ''),
        actorUserId: g.actor.userId as string,
        ip: g.facts.ip,
        requestId: g.facts.requestId,
      }),
    );
    const r = out.data as any;
    if (!out.ok) return govJson({ ok: false, error: out.error }, 500);
    return govJson({ ok: !!r?.ok, error: r?.error, message: r?.view, usesRemaining: r?.usesRemaining }, r?.ok ? 200 : 403);
  }

  if (action === 'retry') {
    const g = await requireGov(locals, 'support.message.retry', { orgId }, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.SUPPORT_MESSAGE_RETRIED, orgId,
        targetType: 'message', targetId: String(body.messageId || ''),
        reason: String(body.reason || 'Support retried a failed delivery.'), facts: g.facts,
      },
      async () => {
        const r = await retryMessage(String(body.messageId || ''));
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error, detail: out.data?.detail }, out.ok ? 200 : 400);
  }

  return govJson({ ok: false, error: 'Unknown action: ' + action + '.', actions: ['request_content', 'approve', 'deny', 'revoke', 'read', 'retry'] }, 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET', 'POST']);
