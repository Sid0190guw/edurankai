// POST /api/mail/open
// Body: { messageIds: string[] }
// Called by the mail client when a recipient OPENS a thread, to log read
// receipts with IP + geolocation. Internal counterpart to /track/[id].gif.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailSchema } from '@/lib/mail';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function geo(ip: string | null): Promise<{ country?: string; region?: string; city?: string }> {
  if (!ip) return {};
  // Tight 1.5s timeout — we don't want a slow ipapi to delay the open response.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch('https://ipapi.co/' + encodeURIComponent(ip) + '/json/', { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return {};
    const d = await r.json() as any;
    return { country: d?.country_name, region: d?.region, city: d?.city };
  } catch (_) { return {}; }
}

async function logOpens(ids: string[], userId: string, ip: string | null, ua: string) {
  try {
    await ensureMailSchema();
    const g = await geo(ip);
    for (const id of ids) {
      try {
        await db.execute(sql`
          INSERT INTO mail_reads (message_id, user_id, kind, ip_address, country, region, city, user_agent)
          SELECT ${id}, ${userId}, 'internal', ${ip || null}, ${g.country || null}, ${g.region || null}, ${g.city || null}, ${ua}
          WHERE EXISTS (SELECT 1 FROM mail_messages WHERE id = ${id} AND from_user_id <> ${userId})
            AND NOT EXISTS (
              SELECT 1 FROM mail_reads WHERE message_id = ${id} AND user_id = ${userId}
                AND read_at > NOW() - INTERVAL '30 minutes'
            )
        `);
      } catch (_) {}
    }
  } catch (_) {}
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false }, 401);
  let body: any = {}; try { body = await request.json(); } catch {}
  const ids: string[] = Array.isArray(body?.messageIds) ? body.messageIds.filter((x: any) => typeof x === 'string') : [];
  if (!ids.length) return json({ ok: true, logged: 0 });

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);
  // Fire-and-forget — the client doesn't need to wait for the log write.
  void logOpens(ids, user.id, ip, ua);
  return json({ ok: true, queued: ids.length });
};
