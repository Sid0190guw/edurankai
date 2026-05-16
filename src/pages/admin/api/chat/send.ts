import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { chatChannels, chatMessages } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  try {
    const body = await request.json();
    const channelSlug = (body.channel || '').trim();
    const text = (body.body || '').trim();

    if (!channelSlug || !text) {
      return new Response(JSON.stringify({ error: 'channel and body required' }), { status: 400 });
    }
    if (text.length > 4000) {
      return new Response(JSON.stringify({ error: 'message too long (max 4000 chars)' }), { status: 400 });
    }

    const channel = await db.select({ id: chatChannels.id }).from(chatChannels).where(eq(chatChannels.slug, channelSlug)).limit(1);
    if (channel.length === 0) {
      return new Response(JSON.stringify({ error: 'channel not found' }), { status: 404 });
    }

    // Need to re-query channel with isPrivate column
    const fullCh = await db.select().from(chatChannels).where(eq(chatChannels.id, channel[0].id)).limit(1);
    if (fullCh[0].isPrivate) {
      const { chatMemberships } = await import('@/lib/db/schema');
      const { and } = await import('drizzle-orm');
      const m = await db.select({ id: chatMemberships.id }).from(chatMemberships)
        .where(and(eq(chatMemberships.channelId, fullCh[0].id), eq(chatMemberships.userId, user.id))).limit(1);
      if (m.length === 0) {
        return new Response(JSON.stringify({ error: 'not a member' }), { status: 403 });
      }
    }

    const messageCode = 'MSG-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const inserted = await db.insert(chatMessages).values({
      channelId: channel[0].id,
      senderUserId: user.id,
      senderName: user.name || user.email,
      body: text,
      messageCode
    }).returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

    return new Response(JSON.stringify({ ok: true, message: inserted[0] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'failed' }), { status: 500 });
  }
};