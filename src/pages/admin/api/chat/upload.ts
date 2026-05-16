import type { APIRoute } from 'astro';
import { put } from '@vercel/blob';
import { db } from '@/lib/db';
import { chatChannels, chatMessages, chatAttachments, chatMemberships } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  try {
    const form = await request.formData();
    const file = form.get('file') as File;
    const channelSlug = (form.get('channel') as string || '').trim();

    if (!file || !channelSlug) {
      return new Response(JSON.stringify({ error: 'file and channel required' }), { status: 400 });
    }
    if (file.size > 10 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'file too large (max 10MB)' }), { status: 400 });
    }

    const ch = await db.select().from(chatChannels).where(eq(chatChannels.slug, channelSlug)).limit(1);
    if (ch.length === 0) return new Response(JSON.stringify({ error: 'channel not found' }), { status: 404 });

    if (ch[0].isPrivate || ch[0].isDm) {
      const m = await db.select({ id: chatMemberships.id }).from(chatMemberships)
        .where(and(eq(chatMemberships.channelId, ch[0].id), eq(chatMemberships.userId, user.id))).limit(1);
      if (m.length === 0) return new Response(JSON.stringify({ error: 'not a member' }), { status: 403 });
    }

    const blob = await put('chat/' + Date.now() + '-' + (file.name || 'file'), file, {
      access: 'public',
      addRandomSuffix: true
    });

    const messageCode = 'MSG-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const msg = await db.insert(chatMessages).values({
      channelId: ch[0].id,
      senderUserId: user.id,
      senderName: user.name || user.email,
      body: '[file] ' + (file.name || 'file'),
      messageCode
    }).returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

    await db.insert(chatAttachments).values({
      messageId: msg[0].id,
      blobUrl: blob.url,
      fileName: file.name || 'file',
      fileSize: file.size,
      mimeType: file.type || null
    });

    return new Response(JSON.stringify({ ok: true, message: msg[0], blobUrl: blob.url }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'upload failed' }), { status: 500 });
  }
};