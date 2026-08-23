// POST /api/forge/book — queue a fabrication job on a piece of Forge equipment.
//
// The page told people "Slot reserved locally. Operator will confirm via email within 30 minutes."
// whenever this endpoint answered 404 — which was always, because it did not exist. Nothing was
// reserved and nothing was local: the string was the entire mechanism.
//
// A job enters `queued`. The operator moves it on. This endpoint does not schedule, does not price,
// and does not promise an ETA, because none of those are decided here.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { json, text, email, when, num, tooFast, logFail, bodyOf, rowsOf } from '@/lib/campus-intake';

export const prerender = false;

/** Only links. Files of any kind are shared as links on this project, never uploaded. */
function link(v: unknown): string | null {
  const s = text(v, 500);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : null;
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const b = await bodyOf(request);
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400);

  const equipmentId = text(b.equipment_id, 80);
  const equipmentName = text(b.equipment_name, 160);
  const addr = email(b.user_email);
  const startAt = when(b.start_at);
  if (!equipmentId) return json({ ok: false, error: 'pick a machine' }, 400);
  if (!addr) return json({ ok: false, error: 'an email address is required so the operator can reach you' }, 400);
  if (!startAt) return json({ ok: false, error: 'pick a start time' }, 400);
  if (await tooFast('forge', clientAddress || addr)) return json({ ok: false, error: 'too many submissions just now — try again in a minute' }, 429);

  const rawFile = text(b.file_url, 500);
  const fileUrl = link(b.file_url);
  // Say which half was wrong. "Invalid input" on a form with nine fields is not an answer.
  if (rawFile && !fileUrl) return json({ ok: false, error: 'the design file must be a link starting with http:// or https://' }, 400);

  const hours = num(b.hours_requested, 0.25, 48) ?? 1;

  try {
    const r = await db.execute(sql`
      INSERT INTO forge_bookings (equipment_id, equipment_name, user_email, start_at,
                                  hours_requested, file_url, material, ship_address, status)
      VALUES (${equipmentId}, ${equipmentName || equipmentId}, ${addr}, ${startAt}::timestamp,
              ${hours}, ${fileUrl}, ${text(b.material, 120)}, ${text(b.ship_address, 400)}, 'queued')
      RETURNING id`);
    return json({ ok: true, id: rowsOf(r)[0]?.id ?? null, status: 'queued' });
  } catch (e: any) {
    logFail('forge-book', e);
    return json({ ok: false, error: 'could not queue that job just now' }, 500);
  }
};
