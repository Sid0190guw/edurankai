// src/pages/api/safety/check-domain.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const domain = url.searchParams.get('domain')?.toLowerCase().replace('www.', '') || '';

  if (!domain) return new Response(JSON.stringify({ blocked: false, checked: false }), {
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
      return new Response(JSON.stringify({ blocked: true, checked: true, reason: d.reason, category: d.category }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (e: any) {
    // FAIL-OPEN, AND IT WAS SILENT. This used to be `catch(e) {}` falling through to the same
    // `{ blocked: false }` a clean domain gets, so any error reading content_blocked_domains — the
    // table down, the column renamed, the pooler refusing a connection — told public/safety.js that
    // every blocked domain on the list was fine to follow, and left no line anywhere saying so. The
    // block list on /admin/moderation would have looked untouched the whole time.
    //
    // The answer is now `unknown` rather than `false`. The caller cannot mistake it for a clearance:
    // `blocked` is absent, `checked` is false, and the reason is on the record.
    const real = e?.cause?.message || e?.message || 'unknown reason';
    console.error('[safety/check-domain] block-list read failed for', domain, '-', real);
    return new Response(JSON.stringify({ checked: false, error: 'the block list could not be read' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  return new Response(JSON.stringify({ blocked: false, checked: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
};
