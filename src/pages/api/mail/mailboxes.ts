// GET    /api/mail/mailboxes            — mailboxes in the caller's organization.
// POST   /api/mail/mailboxes            — create one.
// PATCH  /api/mail/mailboxes            — status, quota, forwarding, auto-reply, signature.
// DELETE /api/mail/mailboxes?id=...     — soft delete; the address stays reserved.
import type { APIRoute } from 'astro';
import { guard, json, body, respond } from '@/lib/mailplatform/domains/api';
import {
  listMailboxes, createMailbox, setMailboxStatus, setMailboxQuota, getMailboxSettings, saveMailboxSettings,
  verifiedDomainNames,
} from '@/lib/mailplatform/domains/store';
import { parseQuota, quotaState, formatBytes, type MailboxStatus } from '@/lib/mailplatform/domains/mailbox-rules';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const STATUSES: MailboxStatus[] = ['active', 'disabled', 'suspended', 'deleted'];

export const GET: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'mail.read');
  if (!g.ok) return g.response;
  try {
    const boxes = await listMailboxes(g.ctx.principal.orgId);
    const withSettings = await Promise.all(boxes.map(async (m) => ({
      ...m,
      quota: quotaState(m.usedBytes, m.quotaBytes),
      quotaLabel: formatBytes(m.quotaBytes),
      settings: await getMailboxSettings(g.ctx.principal.orgId, m.id),
    })));
    return json({ ok: true, data: { mailboxes: withSettings, domains: await verifiedDomainNames(g.ctx.principal.orgId) } });
  } catch (e: any) {
    return json({ ok: false, error: causeOf(e), code: 'db_error' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'mailbox.manage');
  if (!g.ok) return g.response;
  const input = await body<any>(request);
  if (!input) return json({ ok: false, error: 'The request body was not valid JSON.', code: 'bad_body' }, 400);
  if (!input.address) return json({ ok: false, error: 'An address is required.', code: 'missing_address' }, 400);

  let quotaBytes: number | null = null;
  try {
    quotaBytes = parseQuota(input.quota ?? input.quotaBytes ?? null);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || 'Invalid quota.'), code: 'bad_quota' }, 400);
  }
  return respond(await createMailbox(g.ctx, {
    address: String(input.address),
    name: String(input.name || input.address),
    kind: input.kind,
    ownerUserId: input.ownerUserId || null,
    quotaBytes,
  }), 201);
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'mailbox.manage');
  if (!g.ok) return g.response;
  const input = await body<any>(request);
  if (!input?.id) return json({ ok: false, error: 'id is required.', code: 'missing_id' }, 400);
  const id = String(input.id);

  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) {
      return json({ ok: false, error: 'status must be one of: ' + STATUSES.join(', ') + '.', code: 'bad_status' }, 400);
    }
    return respond(await setMailboxStatus(g.ctx, id, input.status));
  }

  if (input.quota !== undefined || input.quotaBytes !== undefined) {
    try {
      return respond(await setMailboxQuota(g.ctx, id, parseQuota(input.quota ?? input.quotaBytes)));
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || 'Invalid quota.'), code: 'bad_quota' }, 400);
    }
  }

  // Everything else is the settings row: forwarding, auto-reply, vacation window, signature.
  return respond(await saveMailboxSettings(g.ctx, id, {
    forwardTo: Array.isArray(input.forwardTo) ? input.forwardTo.map(String) : undefined,
    forwardKeepCopy: input.forwardKeepCopy,
    autoReplyEnabled: input.autoReplyEnabled,
    autoReplySubject: input.autoReplySubject,
    autoReplyBody: input.autoReplyBody,
    autoReplyStartsAt: input.autoReplyStartsAt,
    autoReplyEndsAt: input.autoReplyEndsAt,
    autoReplyIntervalDays: input.autoReplyIntervalDays,
    autoReplyExternal: input.autoReplyExternal,
    autoReplyInternal: input.autoReplyInternal,
    signatureText: input.signatureText,
    signatureHtml: input.signatureHtml,
  }));
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'mailbox.manage');
  if (!g.ok) return g.response;
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: 'id is required.', code: 'missing_id' }, 400);
  return respond(await setMailboxStatus(g.ctx, id, 'deleted'));
};
