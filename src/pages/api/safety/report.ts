// src/pages/api/safety/report.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { flagType, entityType, entityId, contentSnippet, flagSource } = body;
    const user = locals.user;

    await db.execute(sql`
      INSERT INTO content_flags
        (reporter_user_id, entity_type, entity_id, content_snippet, flag_type, flag_source, status)
      VALUES
        (${user?.id || null}, ${entityType || 'page'}, ${entityId || null},
         ${contentSnippet || null}, ${flagType || 'other'},
         ${flagSource || (user ? 'user' : 'anonymous')}, 'pending')
    `);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
