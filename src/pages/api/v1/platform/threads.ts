// GET /api/v1/platform/threads          — conversations, newest first.
// GET /api/v1/platform/threads?id=<uuid> — every message in one conversation.

import type { APIRoute } from 'astro';
import { error, ok, pageParams, pageResponse, preflight, requirePrincipal } from '@/lib/mailplatform/api';
import { providers } from '@/lib/mailplatform/providers';

export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'mail.read');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const url = new URL(ctx.request.url);
  const threadId = url.searchParams.get('id');
  const viewer = {
    userId: principal.kind === 'user' ? principal.id : undefined,
    orgId: principal.kind === 'user' ? undefined : principal.orgId,
  };

  if (threadId) {
    const messages = await providers().messages.getThread(threadId, viewer);
    // An empty thread and a thread the caller may not see are answered identically, on purpose: a
    // distinguishable "exists but forbidden" lets someone enumerate thread ids.
    if (!messages.length) return error('No conversation with that id.', 404, 'not_found');
    return ok({ threadId, messages, count: messages.length });
  }

  const { limit, cursor } = pageParams(url, 25, 100);
  const page = await providers().messages.listThreads({
    ...viewer,
    folder: url.searchParams.get('folder') || 'inbox',
    limit,
    cursor,
  });
  return pageResponse(page, 'threads');
};
