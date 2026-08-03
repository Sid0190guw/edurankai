// /api/meet/rooms/:id — READ, UPDATE and CANCEL one meeting. Three of the four call sites in
// src/pages/portal/meet/index.astro land here; the fourth (create) is ./index.ts. Until this build
// all four received Astro's 404 HTML, so "Edit" toasted "Could not load meeting", "Update" toasted
// "Could not save" and "Cancel" toasted "Could not cancel" — every time, for everyone.
//
// `:id` IS THE SEGMENT IN THE URL, which is a room CODE for anything the scheduler made and a UUID
// for a room opened directly. roomLookupSql() resolves both by comparing `id::text`, never by
// casting the parameter to ::uuid — a cast of the parameter throws on a non-uuid string, and on a
// database carrying the legacy TEXT-id shape it would throw on every request. Same rule this project
// already applies to departments.id.
//
// AUTHORIZATION IS THE HOST, IN THE WHERE CLAUSE. Not a role name and not a capability: a meeting
// belongs to the person who called it, and every statement below is narrowed to
// `host_user_id::text = <caller>`. So a signed-in stranger who guesses a room code gets 404 from the
// same query that would have served the host — the filter is not applied after fetching, it IS the
// fetch. The passcode is returned by GET, which is why this is host-only and not participant-wide.
//
// AND DELIBERATELY NOT canScheduleMeeting(). ./index.ts gates CREATION through the capability
// registry, because calling a new meeting is the ability the registry has an opinion about. These
// three do not repeat that test, and the omission is the point: a person whose employee record is
// closed tomorrow must still be able to CANCEL the meeting they called today rather than leave a
// room open with invitees walking into it. Ownership is the stronger gate here, not the weaker one —
// it is per-row, it is in the statement, and no capability can substitute for it.
//
// It creates no table. src/lib/meet-schema.ts owns the meeting DDL; see its header for the two
// conflicting CREATEs this replaced.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMeetSchema, roomLookupSql, normaliseRoomCode } from '@/lib/meet-schema';
import { readMeetingBody } from '@/lib/meet-request';
import { logEvent } from '@/lib/logger';

// Declared at the very top, above every handler that uses them: `const` is not hoisted, and a
// handler reaching a later declaration has taken pages down on this project.
const json = (d: any, status = 200): Response =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
// postgres-js resolves to a plain array, never a { rows } object.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

const NOT_FOUND = { ok: false, error: 'no meeting of yours has that code' };

export const GET: APIRoute = async ({ params, locals }) => {
  const user = (locals as any).user;
  if (!user?.id) return json({ ok: false, error: 'unauthorized' }, 401);
  const segment = normaliseRoomCode(params.id || '');
  if (!segment) return json(NOT_FOUND, 404);

  try {
    await ensureMeetSchema();
    // Snake_case on purpose: the client reads m.scheduled_at / m.duration_min / m.record_on_default
    // straight off this object into the form. Renaming them here would break the prefill.
    const row = rowsOf(await db.execute(sql`
      SELECT id::text AS id, room_code, title, description, kind, scheduled_at,
             duration_min, recurrence, invitees, passcode, record_on_default,
             waiting_room, breakouts_enabled, attendee_mute_default, status
        FROM meet_rooms
       WHERE ${roomLookupSql(segment)} AND host_user_id::text = ${user.id}
       LIMIT 1`))[0] as any;
    if (!row) return json(NOT_FOUND, 404);
    return json(row);
  } catch (e: any) {
    logEvent('error', 'meet.rooms.read-failed', { userId: user.id, segment, message: reasonOf(e) });
    return json({ ok: false, error: 'the meeting could not be read' }, 500);
  }
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const user = (locals as any).user;
  if (!user?.id) return json({ ok: false, error: 'unauthorized' }, 401);
  const segment = normaliseRoomCode(params.id || '');
  if (!segment) return json(NOT_FOUND, 404);

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const m = readMeetingBody(body);

  try {
    await ensureMeetSchema();
    // RETURNING is what proves the UPDATE matched a row. Without it a PATCH against somebody else's
    // meeting — or against a code that does not exist — would report success having changed
    // nothing, which is the failure mode this whole pass exists to remove.
    const updated = rowsOf(await db.execute(sql`
      UPDATE meet_rooms SET
        title = ${m.title},
        description = ${m.description},
        kind = ${m.kind},
        scheduled_at = ${m.scheduledAt},
        duration_min = ${m.durationMin},
        duration_minutes = ${m.durationMin},
        passcode = ${m.passcode},
        recurrence = ${m.recurrence},
        invitees = ${JSON.stringify(m.invitees)}::jsonb,
        record_on_default = ${m.recordOnDefault},
        waiting_room = ${m.waitingRoom},
        breakouts_enabled = ${m.breakoutsEnabled},
        attendee_mute_default = ${m.attendeeMuteDefault},
        updated_at = NOW()
       WHERE ${roomLookupSql(segment)} AND host_user_id::text = ${user.id}
       RETURNING id::text AS id`))[0] as any;
    if (!updated?.id) return json(NOT_FOUND, 404);
    return json({ ok: true, id: updated.id, roomCode: segment });
  } catch (e: any) {
    logEvent('error', 'meet.rooms.update-failed', { userId: user.id, segment, message: reasonOf(e) });
    return json({ ok: false, error: 'the meeting could not be saved' }, 500);
  }
};

/**
 * CANCEL. The verb is DELETE because that is what the client sends; the effect is a status change.
 *
 * The row STAYS. A meeting that happened, or that people were invited to, is a record — and its
 * participants, chat and recordings hang off its id. Cancelling sets status='cancelled', which is
 * what drops it out of the scheduler's list (that list selects status IN ('scheduled','live')).
 * Nothing here deletes a row and nothing here deletes a column.
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = (locals as any).user;
  if (!user?.id) return json({ ok: false, error: 'unauthorized' }, 401);
  const segment = normaliseRoomCode(params.id || '');
  if (!segment) return json(NOT_FOUND, 404);

  try {
    await ensureMeetSchema();
    const cancelled = rowsOf(await db.execute(sql`
      UPDATE meet_rooms SET status = 'cancelled', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
       WHERE ${roomLookupSql(segment)} AND host_user_id::text = ${user.id}
       RETURNING id::text AS id`))[0] as any;
    if (!cancelled?.id) return json(NOT_FOUND, 404);
    logEvent('info', 'meet.rooms.cancelled', { userId: user.id, segment });
    return json({ ok: true, id: cancelled.id, cancelled: true });
  } catch (e: any) {
    logEvent('error', 'meet.rooms.cancel-failed', { userId: user.id, segment, message: reasonOf(e) });
    return json({ ok: false, error: 'the meeting could not be cancelled' }, 500);
  }
};
