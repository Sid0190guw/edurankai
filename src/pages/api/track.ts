// src/pages/api/track.ts
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  try {
    const body = await request.json();
    const { page, referrer, sessionId, deviceType, browser, os, duration } = body;
    const loggedInUser = locals.user;

    // Get detailed geo from ip-api.com (free, 45 req/min)
    let country = null, city = null, region = null, isp = null, lat = null, lon = null;
    try {
      const ip = clientAddress?.startsWith('::ffff:') ? clientAddress.slice(7) : clientAddress;
      if (ip && ip !== '127.0.0.1' && ip !== '::1') {
        const geo = await fetch(
          `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,lat,lon`,
          { signal: AbortSignal.timeout(2000) }
        );
        if (geo.ok) {
          const g = await geo.json();
          if (g.status === 'success') {
            country = g.country || null;
            city = g.city || null;
            region = g.regionName || null;
            isp = g.isp || null;
            lat = g.lat || null;
            lon = g.lon || null;
          }
        }
      }
    } catch(e) {}

    const ipHash = clientAddress ?
      Buffer.from(clientAddress).toString('base64').substring(0, 16) : null;

    // Parse referrer source
    let referrerSource = 'direct';
    if (referrer) {
      if (referrer.includes('google')) referrerSource = 'google';
      else if (referrer.includes('linkedin')) referrerSource = 'linkedin';
      else if (referrer.includes('twitter') || referrer.includes('x.com')) referrerSource = 'twitter';
      else if (referrer.includes('facebook')) referrerSource = 'facebook';
      else if (referrer.includes('instagram')) referrerSource = 'instagram';
      else if (referrer.includes('whatsapp')) referrerSource = 'whatsapp';
      else if (referrer.includes('edurankai.in')) referrerSource = 'internal';
      else referrerSource = 'external';
    }

    await db.execute(sql`
      INSERT INTO analytics_pageviews
        (session_id, page, referrer, browser, os, device_type, country, city, ip_hash,
         duration_ms, user_id, user_name, user_role, region, isp, lat, lon, referrer_source)
      VALUES
        (${sessionId||null}, ${page||'/'}, ${referrer||null}, ${browser||null}, ${os||null},
         ${deviceType||null}, ${country}, ${city}, ${ipHash}, ${duration||null},
         ${loggedInUser?.id||null}, ${loggedInUser?.name||null}, ${loggedInUser?.role||null},
         ${region}, ${isp}, ${lat}, ${lon}, ${referrerSource})
    `);

    if (sessionId) {
      await db.execute(sql`
        INSERT INTO analytics_sessions (session_id, page, last_seen, country, city, device_type, is_admin, user_id)
        VALUES (${sessionId}, ${page||'/'}, NOW(), ${country}, ${city}, ${deviceType||null},
                ${loggedInUser?.role !== 'applicant' && !!loggedInUser}, ${loggedInUser?.id||null})
        ON CONFLICT (session_id) DO UPDATE SET
          page = ${page||'/'},
          last_seen = NOW(),
          country = COALESCE(analytics_sessions.country, ${country}),
          city = COALESCE(analytics_sessions.city, ${city})
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
