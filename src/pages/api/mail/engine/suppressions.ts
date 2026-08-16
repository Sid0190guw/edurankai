// POST /api/mail/engine/suppressions — the engine telling the application it has stopped mailing
// an address, and why.
//
// The engine keeps its own mirror on disk (mail-engine/src/publish/http.ts) so it can make the
// decision while the application is unreachable; this is the copy that lives where people can see
// it. Same ownership split as events.ts: Patch 1 owns `suppression_entries`, this route only writes
// into it and answers 503 until it exists.
//
// WHY THIS IS A SEPARATE ROUTE from the event stream, when a suppression also produces an event:
// because the two are read for different reasons. The event stream is history — what happened, in
// order, forever. The suppression list is state — who must not be mailed right now. A screen asking
// "is this address suppressed" should not have to fold the whole event history to find out.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../../../../../mail-engine/src/publish/signature';

export const prerender = false;

const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const rows = (r: any) => (Array.isArray(r) ? r : r?.rows || []);
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function suppressionTableExists(): Promise<boolean> {
  try {
    return rows(await db.execute(sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'suppression_entries'
    `)).length > 0;
  } catch (e: any) {
    console.error('[api/mail/engine/suppressions] could not read the schema:', reasonOf(e));
    return false;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const secret = process.env.MAIL_APP_SHARED_SECRET || '';
  if (!secret) return json({ ok: false, error: 'mail engine integration is not configured' }, 503);

  const body = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER) || '';
  const timestamp = request.headers.get(TIMESTAMP_HEADER) || '';
  const age = Math.abs(Date.now() - Number(timestamp));
  if (!signature || !timestamp || !Number.isFinite(age) || age > MAX_CLOCK_SKEW_MS) {
    return json({ ok: false, error: 'missing or stale signature' }, 401);
  }
  if (!verifySignature(secret, timestamp, body, signature)) return json({ ok: false, error: 'bad signature' }, 401);

  let entry: any;
  try {
    entry = JSON.parse(body).suppression;
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  if (!entry?.recipient) return json({ ok: false, error: 'suppression.recipient is required' }, 400);

  if (!(await suppressionTableExists())) {
    console.warn('[api/mail/engine/suppressions] holding: suppression_entries does not exist yet (Patch 1)');
    return json({ ok: false, error: 'contract_not_ready' }, 503);
  }

  try {
    // A PERMANENT ENTRY IS NEVER DOWNGRADED. The engine applies the same rule to its own mirror; it
    // is repeated here because this table can also be written by other things, and "this address
    // hard-bounced" must not be erased by a later "this address was rate-limited".
    await db.execute(sql`
      INSERT INTO suppression_entries (recipient, reason, permanent, expires_at, created_at, last_event_id, detail)
      VALUES (${String(entry.recipient).toLowerCase()}, ${entry.reason}, ${!!entry.permanent},
              ${entry.expiresAt}, ${entry.createdAt}, ${entry.lastEventId}, ${entry.detail})
      ON CONFLICT (recipient) DO UPDATE SET
        reason = EXCLUDED.reason,
        permanent = suppression_entries.permanent OR EXCLUDED.permanent,
        expires_at = CASE WHEN suppression_entries.permanent THEN NULL ELSE EXCLUDED.expires_at END,
        last_event_id = EXCLUDED.last_event_id,
        detail = EXCLUDED.detail
    `);
  } catch (e: any) {
    console.error('[api/mail/engine/suppressions] could not record the suppression:', reasonOf(e));
    return json({ ok: false, error: reasonOf(e) }, 500);
  }

  return json({ ok: true, recipient: entry.recipient });
};
