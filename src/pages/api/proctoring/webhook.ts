// /api/proctoring/webhook - generic proctoring vendor webhook receiver.
// Vendor sends: { event_type, session_id, attempt_id, ..., flags }
// We verify signature, persist the event, update session status.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { verifyWebhookSignature, isConfigured, getProvider } from '@/lib/proctoring';

export const POST: APIRoute = async ({ request }) => {
  if (!isConfigured()) return new Response('proctoring not configured', { status: 503 });

  const raw = await request.text();
  const sig = request.headers.get('x-signature') || request.headers.get('x-honorlock-signature') || '';
  if (!verifyWebhookSignature(raw, sig)) {
    return new Response('invalid signature', { status: 400 });
  }

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response('invalid JSON', { status: 400 }); }

  const vendor = getProvider();
  const vendorSessionId = event?.session_id || event?.sessionId || event?.id || null;
  const attemptId = event?.attempt_id || event?.attemptId || (event?.metadata && event.metadata.attempt) || null;
  const eventType = event?.event_type || event?.event || event?.type || 'unknown';
  const flags = event?.flags || event?.violations || [];
  const status = mapStatus(eventType);

  try {
    // Upsert by (vendor, vendor_session_id) if present
    if (vendorSessionId) {
      const existing = await db.execute(sql`
        SELECT id FROM proctoring_sessions WHERE vendor = ${vendor} AND vendor_session_id = ${vendorSessionId} LIMIT 1
      `);
      const rows = Array.isArray(existing) ? existing : (existing?.rows || []);
      if (rows.length === 0) {
        await db.execute(sql`
          INSERT INTO proctoring_sessions (attempt_id, vendor, vendor_session_id, status, events, flagged_reasons, started_at)
          VALUES (${attemptId}, ${vendor}, ${vendorSessionId}, ${status || 'pending'},
                  ${sql.raw("'" + JSON.stringify([{ at: new Date().toISOString(), type: eventType, raw: event }]).replace(/'/g, "''") + "'::jsonb")},
                  ${sql.raw("'" + JSON.stringify(flags).replace(/'/g, "''") + "'::jsonb")},
                  ${eventType === 'session.started' ? new Date() : null})
        `);
      } else {
        const row = rows[0] as any;
        await db.execute(sql`
          UPDATE proctoring_sessions SET
            events = events || ${sql.raw("'" + JSON.stringify([{ at: new Date().toISOString(), type: eventType }]).replace(/'/g, "''") + "'::jsonb")},
            ${status ? sql`status = ${status},` : sql``}
            ${eventType === 'session.ended' || eventType === 'session.completed' ? sql`ended_at = NOW(),` : sql``}
            updated_at = NOW()
          WHERE id = ${row.id}
        `);
      }
    }
  } catch (e: any) {
    console.error('[proctoring webhook] db error:', e?.message);
    // Still 200 so the vendor doesn't keep retrying - log for review
  }

  return new Response('ok', { status: 200 });
};

function mapStatus(eventType: string): string | null {
  if (eventType === 'session.started') return 'active';
  if (eventType === 'session.ended' || eventType === 'session.completed') return 'completed';
  if (eventType === 'session.flagged' || eventType === 'violation') return 'flagged';
  if (eventType === 'session.cancelled') return 'cancelled';
  return null;
}
