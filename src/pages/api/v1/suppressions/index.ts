// GET    /api/v1/suppressions — addresses this organization has stopped mailing. Scope: email.read
// POST   /api/v1/suppressions — add one (reason: bounce | complaint | unsubscribe | manual). Scope: email.send
// DELETE /api/v1/suppressions?email=… — remove one. Scope: email.send
//
// REMOVING A SUPPRESSION IS A DELIBERATE ACT AND IT IS LOGGED AS ONE. Nothing expires off this list
// on its own. An address that hard-bounced can reasonably be retried later — mailboxes get emptied,
// people come back — but the decision has to be somebody's, not a timer's.
//
// A person who unsubscribed or complained is not a delivery problem to route around: `skip_suppression`
// on a send can retry a bounce, and cannot override either of those.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody, ApiError } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { listSuppressions, suppress, unsuppress, normalizeAddress } from '@/lib/mailapi/suppression';
import { isEmail } from '@/lib/mailapi/validate';

export const OPTIONS = PREFLIGHT;
const REASONS = ['bounce', 'complaint', 'unsubscribe', 'manual'] as const;

export const GET: APIRoute = apiRoute({ endpoint: 'suppressions.list', scope: 'email.read' }, async (ctx) => {
  const list = await listSuppressions(ctx.auth.orgId, ctx.auth.environment, Number(ctx.url.searchParams.get('limit')) || 200);
  return ctx.json({
    object: 'list',
    environment: ctx.auth.environment,
    count: list.length,
    data: list.map((s) => ({ object: 'suppression', email: s.email, reason: s.reason, source: s.source, detail: s.detail, created_at: s.createdAt })),
  });
});

export const POST: APIRoute = apiRoute({ endpoint: 'suppressions.create', scope: 'email.read' }, async (ctx) => {
  requireScope(ctx.auth, 'email.send');
  const body = await readJsonBody(ctx.request, 8 * 1024);
  const email = normalizeAddress(String(body.email || ''));
  if (!isEmail(email)) throw new ApiError('invalid_request', 'Send a valid `email`.', { param: 'email' });
  const reason = String(body.reason || 'manual');
  if (!(REASONS as readonly string[]).includes(reason)) {
    throw new ApiError('invalid_request', '`reason` must be one of: ' + REASONS.join(', ') + '.', { param: 'reason' });
  }
  await suppress({
    orgId: ctx.auth.orgId, environment: ctx.auth.environment, email,
    reason: reason as any, source: 'api', detail: body.detail != null ? String(body.detail) : null,
  });
  return ctx.json({ object: 'suppression', email, reason, environment: ctx.auth.environment, created: true }, 201);
});

export const DELETE: APIRoute = apiRoute({ endpoint: 'suppressions.delete', scope: 'email.read' }, async (ctx) => {
  requireScope(ctx.auth, 'email.send');
  const email = normalizeAddress(ctx.url.searchParams.get('email') || '');
  if (!isEmail(email)) throw new ApiError('invalid_request', 'Pass ?email=someone@example.com', { param: 'email' });
  const removed = await unsuppress(ctx.auth.orgId, ctx.auth.environment, email);
  if (!removed) throw new ApiError('not_found', 'That address is not on the suppression list for this environment.');
  return ctx.json({ object: 'suppression', email, removed: true });
});
