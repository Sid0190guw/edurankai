// src/pages/api/track.ts
// Analytics tracking endpoint
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  try {
    const body = await request.json();
    const { page, referrer, sessionId, deviceType, browser, os } = body;

    // Get country from IP using free API
    let country = null, city = null;
    try {
      const geo = await fetch(`http://ip-api.com/json/${clientAddress}?fields=country,city`, {
        signal: AbortSignal.timeout(2000)
      });
      if (geo.ok) {
        const geoData = await geo.json();
        country = geoData.country || null;
        city = geoData.city || null;
      }
    } catch(e) {}

    // Hash the IP for privacy
    const ipHash = clientAddress ? 
      Buffer.from(clientAddress).toString('base64').substring(0, 16) : null;

    // Record pageview
    await db.execute(sql`
      INSERT INTO analytics_pageviews (session_id, page, referrer, browser, os, device_type, country, city, ip_hash)
      VALUES (${sessionId || null}, ${page || '/'}, ${referrer || null}, ${browser || null}, ${os || null}, ${deviceType || null}, ${country}, ${city}, ${ipHash})
    `);

    // Update session
    if (sessionId) {
      await db.execute(sql`
        INSERT INTO analytics_sessions (session_id, page, last_seen, country, device_type)
        VALUES (${sessionId}, ${page || '/'}, NOW(), ${country}, ${deviceType || null})
        ON CONFLICT (session_id) DO UPDATE SET
          page = ${page || '/'},
          last_seen = NOW(),
          country = COALESCE(analytics_sessions.country, ${country})
      `);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e: any) {
    return new Response(JSON.stringify({ ok: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
