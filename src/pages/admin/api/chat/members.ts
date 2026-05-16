import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { chatChannels, chatMemberships, users } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const me = (locals as any).user;
  if (!me) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  try {
    const body = await request.json();
    const channelSlug = (body.channel || '').trim();
    const action = (body.action || '').trim();
    const userId = (body.userId || '').trim();

    if (!channelSlug || !action || !userId) {
      return new Response(JSON.stringify({ error: 'channel, action, userId required' }), { status: 400 });
    }
    if (action !== 'add' && action !== 'remove') {
      return new Response(JSON.stringify({ error: 'invalid action' }), { status: 400 });
    }

    const ch = await db.select().from(chatChannels).where(eq(chatChannels.slug, channelSlug)).limit(1);
    if (ch.length === 0) return new Response(JSON.stringify({ error: 'channel not found' }), { status: 404 });

    // Only creator or super_admin can manage members
    if (ch[0].createdByUserId !== me.id && me.role !== 'super_admin') {
      return new Response(JSON.stringify({ error: 'only channel creator or super_admin can manage members' }), { status: 403 });
    }

    if (action === 'add') {
      await db.insert(chatMemberships).values({ channelId: ch[0].id, userId }).onConflictDoNothing();
    } else {
      await db.delete(chatMemberships)
        .where(and(eq(chatMemberships.channelId, ch[0].id), eq(chatMemberships.userId, userId)));
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'failed' }), { status: 500 });
  }
};

export const GET: APIRoute = async ({ request, locals }) => {
  const me = (locals as any).user;
  if (!me) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const url = new URL(request.url);
  const channelSlug = url.searchParams.get('channel') || '';
  if (!channelSlug) return new Response(JSON.stringify({ error: 'channel required' }), { status: 400 });

  const ch = await db.select().from(chatChannels).where(eq(chatChannels.slug, channelSlug)).limit(1);
  if (ch.length === 0) return new Response(JSON.stringify({ error: 'channel not found' }), { status: 404 });

  const memberRows = await db.select({ uid: chatMemberships.userId })
    .from(chatMemberships).where(eq(chatMemberships.channelId, ch[0].id));

  const memberIds = memberRows.map(r => r.uid);
  let memberList: any[] = [];
  if (memberIds.length > 0) {
    memberList = await db.select({ id: users.id, name: users.name, email: users.email, internalHandle: users.internalHandle })
      .from(users).where(inArray(users.id, memberIds));
  }

  return new Response(JSON.stringify({
    members: memberList,
    canManage: ch[0].createdByUserId === me.id || me.role === 'super_admin',
    isPrivate: ch[0].isPrivate
  }), { headers: { 'Content-Type': 'application/json' } });
};