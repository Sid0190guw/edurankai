// src/pages/api/safety/check-domain.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const domain = url.searchParams.get('domain')?.toLowerCase().replace('www.', '') || '';

  if (!domain) return new Response(JSON.stringify({ blocked: false }), {
    headers: { 'Content-Type': 'application/json' }
  });

  try {
    const r = await db.execute(sql`
      SELECT domain, reason, category FROM content_blocked_domains
      WHERE domain = ${domain} OR ${domain} LIKE '%.' || domain
      LIMIT 1
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    if (rows.length > 0) {
      const d = rows[0] as any;
      return new Response(JSON.stringify({ blocked: true, reason: d.reason, category: d.category }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch(e) {}

  return new Response(JSON.stringify({ blocked: false }), {
    headers: { 'Content-Type': 'application/json' }
  });
};
