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

/**
 * GEOLOCATION IS OFF UNLESS SOMEBODY TURNED IT ON, AND THAT IS A CHANGE OF DEFAULT.
 *
 * This function sends the READER'S IP ADDRESS to a third-party service on every open, and stores
 * the city it returns. For an internal open that is a colleague's location; through the sibling
 * pixel route it is an external recipient's, and they were never asked and are never told.
 *
 * This codebase's own rules forbid reading private data without consent and require oversight
 * screens to be aggregate-only. A per-open city, per person, is neither. The sovereignty directive
 * also says core capability should be first-party, and this is a request path with a dependency on
 * somebody else's API.
 *
 * So the default is off. Set MAIL_GEOLOCATE_OPENS=true to restore the previous behaviour — the
 * read receipt itself (who opened, when) is unaffected either way; only country/region/city stop
 * being filled.
 */
const GEO_ENABLED = process.env.MAIL_GEOLOCATE_OPENS === 'true';

async function geo(ip: string | null): Promise<{ country?: string; region?: string; city?: string }> {
  if (!GEO_ENABLED) return {};
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

// A READ RECEIPT THAT NEVER LANDED USED TO LEAVE NO TRACE. Both catches here were bare, so a
// failing mail_reads insert simply meant the "read" column on /admin/mail/analytics stayed at zero
// for ever, indistinguishable from mail nobody had opened, with nothing in any log to say otherwise.
// The catches stay - this is fire-and-forget and must never affect the caller's response - but they
// now say what happened. e.message is only the failed SQL; the reason is on e.cause.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

async function logOpens(ids: string[], userId: string, ip: string | null, ua: string) {
  try {
    await ensureMailSchema();
    const g = await geo(ip);
    // ONE STATEMENT FOR THE WHOLE READING PANE, NOT ONE PER MESSAGE.
    //
    // This looped, and every iteration was an awaited round trip holding a pooler connection for
    // ~140ms whatever the insert cost — so opening a pane of a hundred messages took a hundred
    // connections' worth of time on a pool of a few, for receipts nobody is waiting on. On a shared
    // pooler that is not a slow endpoint, it is other people's pages answering 503.
    //
    // The ids arrive already validated as UUIDs and capped at 100 by the handler below, and they go
    // in as ONE json parameter rather than a hundred placeholders. `= ANY(${jsArray})` is the trap
    // here and src/lib/pg-array.ts is written about it: the driver sends a JS array as a record
    // literal, not an array, and Postgres answers "op ANY/ALL (array) requires array on right side".
    // jsonb_array_elements_text is the form that repo already standardised on.
    //
    // BOTH SECURITY PREDICATES ARE UNCHANGED and now correlate on x.id instead of a literal. The
    // mail_box join is what binds a receipt to a copy the caller genuinely owns — without it any
    // mailbox holder who learned a message id, and every recipient of a tracked message holds one
    // because it is in the pixel and link URLs, could forge read rows against mail they were never
    // sent. The NOT EXISTS keeps the thirty-minute dedupe.
    //
    // The per-id catch is gone because it was guarding nothing per-id: the predicates decide each
    // row on its own, so anything that can actually throw here is statement-level (a missing table,
    // an unreachable database) and would have failed all hundred iterations anyway. The outer catch
    // still logs it, and this is still fire-and-forget.
    await db.execute(sql`
      INSERT INTO mail_reads (message_id, user_id, kind, ip_address, country, region, city, user_agent)
      SELECT x.id::uuid, ${userId}, 'internal', ${ip || null}, ${g.country || null}, ${g.region || null}, ${g.city || null}, ${ua}
        FROM (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS id) x
       WHERE EXISTS (
         SELECT 1 FROM mail_messages m
         JOIN mail_box b ON b.message_id = m.id AND b.user_id = ${userId}
         WHERE m.id = x.id::uuid AND m.from_user_id <> ${userId}
       )
         AND NOT EXISTS (
           SELECT 1 FROM mail_reads
            WHERE message_id = x.id::uuid AND user_id = ${userId}
              AND read_at > NOW() - INTERVAL '30 minutes'
         )
    `);
  } catch (e: any) {
    console.error('[api/mail/open] read receipts abandoned:', reasonOf(e));
  }
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any).user;
  if (!user) return json({ ok: false }, 401);
  let body: any = {}; try { body = await request.json(); } catch {}
  // BOUNDED, AND SHAPE-CHECKED. `messageIds` had no length limit and no format check, and each
  // entry became one INSERT plus (previously) one outbound geo lookup, fire-and-forget. A single
  // request could therefore ask for ten thousand of both from any account with a mailbox. A reading
  // pane shows a handful of messages at a time; 100 is far above the real ceiling and far below a
  // useful amount of amplification.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids: string[] = (Array.isArray(body?.messageIds) ? body.messageIds : [])
    .filter((x: any) => typeof x === 'string' && UUID.test(x))
    .slice(0, 100);
  if (!ids.length) return json({ ok: true, logged: 0 });

  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const ip = (clientAddress || request.headers.get('x-forwarded-for') || '').toString().split(',')[0].trim().slice(0, 64);
  // Fire-and-forget — the client doesn't need to wait for the log write.
  void logOpens(ids, user.id, ip, ua);
  return json({ ok: true, queued: ids.length });
};
