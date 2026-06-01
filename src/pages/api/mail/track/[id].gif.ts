// GET /api/mail/track/<messageId>.gif
// 1x1 transparent pixel for external read receipts. Inserted into the HTML
// body of outbound mail; when the recipient's client loads it we record the
// open + IP + geolocation. Always returns the GIF so a fetch error never
// breaks the recipient's mail rendering.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailSchema } from '@/lib/mail';

// 35-byte 1x1 transparent GIF (lowest possible).
const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);
const GIF_HEADERS: Record<string, string> = {
  'Content-Type': 'image/gif',
  'Content-Length': String(GIF.length),
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
};

async function geo(ip: string | null): Promise<{ country?: string; region?: string; city?: string }> {
  if (!ip) return {};
  // ipapi.co is free + no auth for low volume. Best-effort; never blocks.
  try {
    const r = await fetch('https://ipapi.co/' + encodeURIComponent(ip) + '/json/', {
      headers: { 'User-Agent': 'EduRankAI-mail-tracker' },
    });
    if (!r.ok) return {};
    const d = await r.json() as any;
    return { country: d?.country_name, region: d?.region, city: d?.city };
  } catch (_) { return {}; }
}

export const GET: APIRoute = async ({ params, request, clientAddress }) => {
  const raw = (params.id || '').toString();
  const messageId = raw.replace(/\.gif$/i, '').trim();
  if (!messageId || !/^[0-9a-f-]{32,36}$/i.test(messageId)) {
    return new Response(GIF, { status: 200, headers: GIF_HEADERS });
  }
  try {
    await ensureMailSchema();
    const ua = (request.headers.get('user-agent') || '').slice(0, 500);
    const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);
    const g = await geo(ip);
    await db.execute(sql`
      INSERT INTO mail_reads (message_id, kind, ip_address, country, region, city, user_agent)
      VALUES (${messageId}, 'external', ${ip || null}, ${g.country || null}, ${g.region || null}, ${g.city || null}, ${ua})
    `);
  } catch (_) { /* silent — never break the recipient's render */ }
  return new Response(GIF, { status: 200, headers: GIF_HEADERS });
};
