// GET    /api/v1/platform/messages/:id — one message, with recipients, attachments and delivery.
// PATCH  /api/v1/platform/messages/:id — per-mailbox state: folder, read, starred, labels.
// DELETE /api/v1/platform/messages/:id — move to trash, or ?hard=true to remove this copy.
//
// PATCH changes only the CALLER'S copy of the message. A message has one body and one row per
// mailbox that holds it; marking it read must not mark it read for the four other recipients.

import type { APIRoute } from 'astro';
import { audit, error, ok, preflight, readJson, requirePrincipal, requireUuid } from '@/lib/mailplatform/api';
import { providers } from '@/lib/mailplatform/providers';
import { statusFor, summarize } from '@/lib/mailplatform/delivery';

export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.read');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const id = requireUuid(ctx.params.id, 'id');
  if (id instanceof Response) return id;

  const message = await providers().messages.get(id, {
    userId: principal.kind === 'user' ? principal.id : undefined,
    orgId: principal.kind === 'user' ? undefined : principal.orgId,
  });
  // 404 rather than 403 for a message the caller may not see. A 403 confirms the id exists, which
  // turns this endpoint into a way to enumerate other people's message ids.
  if (!message) return error('No message with that id.', 404, 'not_found');

  const url = new URL(ctx.request.url);
  const wantDelivery = url.searchParams.get('delivery') !== 'false';
  const delivery = wantDelivery ? await statusFor(principal.orgId, id) : [];

  return ok({
    message,
    delivery: wantDelivery ? { recipients: delivery, summary: summarize(delivery) } : undefined,
  });
};

export const PATCH: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.read');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  // A mailbox copy belongs to a USER. An API key has no inbox, so there is nothing for it to patch.
  if (principal.kind !== 'user') {
    return error('Only a signed-in user can change mailbox state — an API key has no mailbox.', 403, 'no_mailbox');
  }

  const id = requireUuid(ctx.params.id, 'id');
  if (id instanceof Response) return id;

  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;

  const result = await providers().messages.patchState(
    id,
    { userId: principal.id },
    {
      folder: typeof body.folder === 'string' ? body.folder : undefined,
      isRead: typeof body.isRead === 'boolean' ? body.isRead : undefined,
      isStarred: typeof body.isStarred === 'boolean' ? body.isStarred : undefined,
      isImportant: typeof body.isImportant === 'boolean' ? body.isImportant : undefined,
      addLabels: Array.isArray(body.addLabels) ? (body.addLabels as string[]) : undefined,
      removeLabels: Array.isArray(body.removeLabels) ? (body.removeLabels as string[]) : undefined,
      snoozedUntil: body.snoozedUntil === null || typeof body.snoozedUntil === 'string' ? (body.snoozedUntil as any) : undefined,
    },
  );

  if (!result.ok) {
    const status = result.code === 'not_found' ? 404 : result.code === 'empty_patch' ? 400 : 422;
    return error(result.error || 'Nothing changed.', status, result.code);
  }
  return ok({ state: result.data });
};

export const DELETE: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.read');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  if (principal.kind !== 'user') {
    return error('Only a signed-in user can delete from a mailbox — an API key has no mailbox.', 403, 'no_mailbox');
  }

  const id = requireUuid(ctx.params.id, 'id');
  if (id instanceof Response) return id;

  const hard = new URL(ctx.request.url).searchParams.get('hard') === 'true';
  const result = await providers().messages.remove(id, { userId: principal.id }, { hard });
  if (!result.ok) return error(result.error || 'Nothing was deleted.', result.code === 'not_found' ? 404 : 422, result.code);

  await audit({
    principal,
    request: ctx.request,
    action: hard ? 'message.delete.hard' : 'message.trash',
    targetType: 'message',
    targetId: id,
  });

  // The distinction is reported rather than left implicit: one is reversible from Trash, the other
  // removed this copy for good.
  return ok({ deleted: true, permanent: hard, detail: hard ? 'Your copy has been removed.' : 'Moved to Trash.' });
};
