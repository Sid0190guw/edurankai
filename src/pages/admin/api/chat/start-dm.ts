import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { chatChannels, chatMemberships, users } from '@/lib/db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const me = (locals as any).user;
  if (!me) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  if (me.role === 'applicant') return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });

  try {
    const body = await request.json();
    const otherUserId = (body.userId || '').trim();
    if (!otherUserId || otherUserId === me.id) {
      return new Response(JSON.stringify({ error: 'pick another user' }), { status: 400 });
    }

    const other = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, otherUserId)).limit(1);
    if (other.length === 0) return new Response(JSON.stringify({ error: 'user not found' }), { status: 404 });

    // Look for existing DM channel that has BOTH users as members and is_dm=true
    const myChannels = await db.select({ channelId: chatMemberships.channelId })
      .from(chatMemberships).where(eq(chatMemberships.userId, me.id));
    const myChannelIds = myChannels.map(c => c.channelId);

    if (myChannelIds.length > 0) {
      const candidates = await db.select().from(chatChannels)
        .where(and(eq(chatChannels.isDm, true), inArray(chatChannels.id, myChannelIds)));

      for (const c of candidates) {
        const others = await db.select({ uid: chatMemberships.userId })
          .from(chatMemberships).where(eq(chatMemberships.channelId, c.id));
        const memberIds = others.map(o => o.uid);
        if (memberIds.length === 2 && memberIds.includes(me.id) && memberIds.includes(otherUserId)) {
          return new Response(JSON.stringify({ ok: true, channel: { slug: c.slug }, existing: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    // Create new DM
    const slug = 'dm-' + me.id.substring(0, 8) + '-' + otherUserId.substring(0, 8);
    const dmName = 'DM with ' + (other[0].name || 'user');
    const inserted = await db.insert(chatChannels).values({
      slug,
      name: dmName,
      isPrivate: true,
      isDm: true,
      createdByUserId: me.id,
      sortOrder: 90
    }).returning({ id: chatChannels.id, slug: chatChannels.slug });

    await db.insert(chatMemberships).values({ channelId: inserted[0].id, userId: me.id });
    await db.insert(chatMemberships).values({ channelId: inserted[0].id, userId: otherUserId });

    return new Response(JSON.stringify({ ok: true, channel: inserted[0], existing: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'failed' }), { status: 500 });
  }
};