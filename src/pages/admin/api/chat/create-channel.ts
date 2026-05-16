import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { chatChannels, chatMemberships, users } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  if (user.role === 'applicant') return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });

  try {
    const body = await request.json();
    const name = (body.name || '').trim();
    const description = (body.description || '').trim() || null;
    const isPrivate = body.isPrivate === true;
    const memberIds: string[] = Array.isArray(body.memberIds) ? body.memberIds.filter((s: any) => typeof s === 'string') : [];

    if (!name || name.length < 2) {
      return new Response(JSON.stringify({ error: 'name required (min 2 chars)' }), { status: 400 });
    }

    // Generate slug
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50) || 'channel';
    let slug = baseSlug;
    let suffix = 1;
    while (true) {
      const existing = await db.select({ id: chatChannels.id }).from(chatChannels).where(eq(chatChannels.slug, slug)).limit(1);
      if (existing.length === 0) break;
      suffix++;
      slug = baseSlug + '-' + suffix;
    }

    const inserted = await db.insert(chatChannels).values({
      slug, name, description, isPrivate,
      createdByUserId: user.id,
      sortOrder: 50
    }).returning({ id: chatChannels.id, slug: chatChannels.slug });

    const channelId = inserted[0].id;

    // For private channels: add creator + selected members
    if (isPrivate) {
      const allMemberIds = Array.from(new Set([user.id, ...memberIds]));
      for (const uid of allMemberIds) {
        await db.insert(chatMemberships).values({ channelId, userId: uid }).onConflictDoNothing();
      }
    }

    return new Response(JSON.stringify({ ok: true, channel: { id: channelId, slug: inserted[0].slug } }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'failed' }), { status: 500 });
  }
};