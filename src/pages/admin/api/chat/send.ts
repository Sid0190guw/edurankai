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

    const inserted = await db.insert(chatMessages).values({
      channelId: channel[0].id,
      senderUserId: user.id,
      senderName: user.name || user.email,
      body: text
    }).returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

    return new Response(JSON.stringify({ ok: true, message: inserted[0] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'failed' }), { status: 500 });
  }
};