// GET /api/mail/click/<messageId>?u=<encoded-url>
// Records a link click for campaign analytics, then 302-redirects to the target.
//
// ═══ IT WAS AN OPEN REDIRECT ON THE COMPANY DOMAIN ═══
//
// The destination arrived in the query string and NOTHING bound it to the message it claimed to
// belong to. `id` was not validated at all, and any `u=` that started with http(s) was redirected to
// verbatim. So anyone could hand out
//
//     https://edurankai.in/api/mail/click/anything?u=https%3A%2F%2F<attacker>
//
// — a link that reads as ours, passes a "is this edurankai.in?" glance, survives being pasted into a
// message, and lands on somebody else's page. That is the same shape as a payment signature that is
// not bound to the order it paid for: a caller-supplied value trusted because it was supplied.
//
// ═══ WHAT BINDS IT NOW, AND WHY THIS SHAPE ═══
//
// rewriteLinksForTracking() only ever wraps hrefs that were ALREADY IN THE MESSAGE BODY, and
// deliverMessage() stores that body verbatim in mail_messages.body_html BEFORE the rewrite happens
// (src/pages/api/mail/send.ts and scheduled-send.ts both call it that way round). So the message we
// sent is itself the record of which destinations are legitimate for that message id, and no new
// table, no new column and no migration is needed to check it.
//
// This deliberately does NOT introduce a signed token. Mail already delivered — sitting in real
// inboxes, out of our reach — carries unsigned links, and a scheme that only honoured freshly signed
// ones would break every link in every message already sent. Checking against the stored body honours
// those and refuses invented ones.
//
// IT FAILS CLOSED. An id that is not a uuid, a message that does not exist, a destination that is not
// in that message, or a lookup that throws all land on the site root rather than on the address the
// caller asked for. A recipient whose link does not resolve reaches our homepage; the alternative is
// a phishing redirector wearing our domain.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { recordClick } from '@/lib/mail-advanced';

// Declared above the handler that reads them — `const` is not hoisted.
const HOME = 'https://edurankai.in';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// postgres-js resolves to a plain array, never a { rows } object.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/**
 * Was `dest` a link in the message this click claims to come from?
 *
 * Compared against the stored html AND the stored text: a plain-text-only send has no href to rewrite
 * but the address is still in the body, and a recipient's client may linkify it.
 */
async function destinationBelongsToMessage(messageId: string, dest: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 AS ok FROM mail_messages
     WHERE id = ${messageId}::uuid
       AND (POSITION(${dest} IN COALESCE(body_html, '')) > 0
         OR POSITION(${dest} IN COALESCE(body_text, '')) > 0)
     LIMIT 1`);
  return rowsOf(r).length > 0;
}

export const GET: APIRoute = async ({ params, url, request, clientAddress }) => {
  const id = (params.id as string) || '';
  let dest = url.searchParams.get('u') || '';
  try { dest = decodeURIComponent(dest); } catch (_) {}

  const safe = (to: string) =>
    new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });

  // http(s) only: `javascript:` and `data:` never reach the branch below.
  if (!/^https?:\/\//i.test(dest) || dest.length > 2000) return safe(HOME);
  if (!UUID.test(id)) return safe(HOME);

  let allowed = false;
  try {
    allowed = await destinationBelongsToMessage(id, dest);
  } catch (e: any) {
    // Not swallowed into a pass. Logged, and refused.
    console.error('[api/mail/click] destination check failed:', reasonOf(e));
    return safe(HOME);
  }
  if (!allowed) return safe(HOME);

  recordClick(id, dest, (clientAddress || '').toString(), request.headers.get('user-agent') || '')
    .catch((e: any) => console.error('[api/mail/click] click not recorded:', reasonOf(e)));
  return safe(dest);
};
