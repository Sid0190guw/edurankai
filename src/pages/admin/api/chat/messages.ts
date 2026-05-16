import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { chatChannels, chatMessages, users } from '@/lib/db/schema';
import { eq, asc, gt, and, isNull } from 'drizzle-orm';

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

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

  return new Response(JSON.stringify({ channel: channelSlug, messages: msgs }), {
    headers: { 'Content-Type': 'application/json' }
  });
};