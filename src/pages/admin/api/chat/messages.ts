// GET /admin/api/chat/messages — the ONE endpoint of the channel system that survives, because the
// channels hold live history and history that cannot be read is history that has been thrown away.
// It reads; nothing here writes. See src/lib/chat-schema.ts for which system is canonical and why.
//
// GATE. It checked `if (!user)` — one line, weaker than the page it serves, which src/middleware.ts
// gates on the `discussion` section (PATH_SECTION, middleware.ts:57). resolveAdminSection() does not
// match `/admin/api/chat/...`, so the middleware's own section gate never reached this URL: a
// signed-in account without `discussion` was redirected away from /admin/chat and could still read
// every message in every public channel straight from here. denyAdminApi() asks the page's question.
// The per-channel membership check below stays exactly as it was — the section gate says who may
// open Discussion at all, membership says which private channels they may read, and both apply.
//
// SHAPE NOTE, now that chat_messages carries both systems' columns: this query filters on
// `channel_id = <channel>`, and an E2EE thread message has a NULL channel_id, so a portal message
// can never appear here. The reverse is true of the thread reads in /portal/messages, which filter
// on thread_id. Neither surface can start showing the other's rows.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { chatChannels, chatMessages } from '@/lib/db/schema';
import { eq, asc, gt, and, isNull } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { ensureChatSchema } from '@/lib/chat-schema';

export const GET: APIRoute = async ({ request, locals }) => {
  // Authorization before any SELECT — docs/workforce-os/AUTHORIZATION_FIRST.md: a query that ran
  // for an unauthorised principal has already happened, whatever the response says.
  const denied = await denyAdminApi(locals, {
    section: 'discussion',
    action: 'view',
    label: 'admin.api.chat.messages',
  });
  if (denied) return denied;

  const user = (locals as any).user;
  await ensureChatSchema();

  const url = new URL(request.url);
  const channelSlug = url.searchParams.get('channel') || 'general';
  const sinceIso = url.searchParams.get('since');

  const channel = await db.select().from(chatChannels).where(eq(chatChannels.slug, channelSlug)).limit(1);
  if (channel.length === 0) {
    return new Response(JSON.stringify({ error: 'channel not found' }), { status: 404 });
  }

  // Private channel? Check membership
  if (channel[0].isPrivate) {
    const { chatMemberships } = await import('@/lib/db/schema');
    const member = await db.select({ id: chatMemberships.id }).from(chatMemberships)
      .where(and(eq(chatMemberships.channelId, channel[0].id), eq(chatMemberships.userId, user.id))).limit(1);
    if (member.length === 0) {
      return new Response(JSON.stringify({ error: 'not a member of this private channel' }), { status: 403 });
    }
  }

  const conditions = [eq(chatMessages.channelId, channel[0].id), isNull(chatMessages.deletedAt)];
  if (sinceIso) {
    const since = new Date(sinceIso);
    if (!isNaN(since.getTime())) {
      conditions.push(gt(chatMessages.createdAt, since));
    }
  }

  const msgs = await db.select({
    id: chatMessages.id,
    body: chatMessages.body,
    senderUserId: chatMessages.senderUserId,
    senderName: chatMessages.senderName,
    createdAt: chatMessages.createdAt,
    editedAt: chatMessages.editedAt
  }).from(chatMessages).where(and(...conditions)).orderBy(asc(chatMessages.createdAt)).limit(200);

  return new Response(JSON.stringify({ channel: channelSlug, archived: true, messages: msgs }), {
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' }
  });
};
