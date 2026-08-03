// POST /api/meet/rooms — SCHEDULE OR OPEN A MEETING. The route the scheduler has been calling since
// 2026-06-09 and that did not exist.
//
// WHAT WAS BROKEN. src/pages/portal/meet/index.astro has four fetch() call sites — POST
// /api/meet/rooms (quick huddle and "Save meeting"), GET /api/meet/rooms/:id (edit prefill), PATCH
// /api/meet/rooms/:id (update) and DELETE /api/meet/rooms/:id (cancel). There was no /api/meet
// directory at all, so all four got Astro's 404 HTML. Three of them showed a toast and stopped; the
// fourth — the quick huddle — has an explicit `if (r.ok) ... else` fallback that navigated to
// /portal/meet/<code>?adhoc=1 anyway, which is why the feature LOOKED like it half worked: the room
// opened, and the meeting was never recorded. src/lib/workforce/widgets.ts:1250 and
// navigation.ts:656 both wrote the missing route down rather than adding it.
//
// THIS IS NOT A SECOND MEETING PLATFORM. It writes the same `meet_rooms` the room page reads,
// through the one module that owns that DDL — src/lib/meet-schema.ts. It creates no table.
//
// ROOM CODES. The client generates a 10-character code and navigates to /portal/meet/<code>. That
// code is stored in `room_code`, not in `id`, because `id` is a UUID on the canonical shape. Before
// this route existed the room page treated an unrecognised code as "make me a new room", so two
// people typing the same code each got a different empty room. One code, one row, one meeting.
//
// AUTHORIZATION — THROUGH THE CAPABILITY REGISTRY, BEFORE ANY READ. canScheduleMeeting()
// (src/lib/meet-access.ts) resolves the composition with composeWorkspace() and applies the SAME
// predicate navigation.ts already publishes for this destination — `worksHere`, i.e. an employee
// record or `admin.access` — so the endpoint cannot be more generous than the menu that leads to it.
// It fails closed: composeWorkspace denies on a failed lookup and resolvePermissions resolves to an
// EMPTY set on error, so a database hiccup refuses a meeting rather than authorising one. The gate
// runs on the first line of the handler, before the body is read and before any SELECT — filtering
// after fetching is prohibited (docs/workforce-os/AUTHORIZATION_FIRST.md), and a query that ran for
// an unauthorised principal has already happened whatever the response says.
//
// Everything AFTER creation is narrowed to the host in the WHERE clause (see ./[id].ts) — strictly
// stronger than any capability test — so this endpoint can never read or alter somebody else's
// meeting, and nobody who already has a meeting is left unable to cancel it.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMeetSchema, meetBlockReason, normaliseRoomCode } from '@/lib/meet-schema';
import { readMeetingBody } from '@/lib/meet-request';
import { canScheduleMeeting } from '@/lib/meet-access';
import { logEvent } from '@/lib/logger';

// Declared at the very top, above the handler that uses them: `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
const json = (d: any, status = 200): Response =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
// postgres-js resolves to a plain array, never a { rows } object.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// The real Postgres reason is on e.cause; e.message is only the failed SQL.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user?.id) return json({ ok: false, error: 'unauthorized' }, 401);

  // Authorization FIRST — before the body is read and before any statement runs.
  const gate = await canScheduleMeeting(user, { locals, next: '/portal/meet' });
  if (!gate.ok) {
    logEvent('warn', 'meet.rooms.create-denied', { userId: user.id, retryable: gate.retryable });
    // 503 only when the gate could not TELL — "come back later" over a settled refusal is a lie the
    // caller will act on. A decided "not for you" is 403 and stays 403.
    return json({ ok: false, error: gate.reason }, gate.retryable ? 503 : 403);
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const code = normaliseRoomCode(body?.id || '');
  if (code.length < 4) return json({ ok: false, error: 'a room code of at least 4 characters is required' }, 400);

  const m = readMeetingBody(body);

  try {
    await ensureMeetSchema();
    // The legacy shape records a host as an INTEGER and cannot hold an account id; a failed ensure
    // means nobody has confirmed the shape at all. Either way this is said out loud rather than
    // thrown: a 500 reads as "the server is broken" when the truth is "this database needs one
    // migration a person has to run", and the two are not the same instruction.
    const blocked = meetBlockReason();
    if (blocked) {
      logEvent('warn', 'meet.rooms.create-refused', { userId: user.id, code });
      return json({ ok: false, error: blocked }, 503);
    }

    // One code, one room. Checked before the INSERT so a re-post of the same form (or two people
    // pressing the button at once) joins the meeting that exists instead of colliding with it.
    const existing = rowsOf(await db.execute(sql`
      SELECT id::text AS id, host_user_id::text AS host_user_id
        FROM meet_rooms WHERE room_code = ${code} LIMIT 1`))[0] as any;
    if (existing) {
      if (String(existing.host_user_id || '') !== String(user.id)) {
        return json({ ok: false, error: 'that room code is already in use' }, 409);
      }
      return json({ ok: true, id: existing.id, roomCode: code, href: '/portal/meet/' + code, existing: true });
    }

    const created = rowsOf(await db.execute(sql`
      INSERT INTO meet_rooms (
        room_code, host_user_id, host_name, host_email, title, description, kind,
        scheduled_at, duration_min, duration_minutes, passcode, waiting_room,
        record_on_default, breakouts_enabled, attendee_mute_default, recurrence, invitees, status
      ) VALUES (
        ${code}, ${user.id}::uuid, ${user.name || null}, ${user.email || null}, ${m.title},
        ${m.description}, ${m.kind}, ${m.scheduledAt}, ${m.durationMin}, ${m.durationMin},
        ${m.passcode}, ${m.waitingRoom}, ${m.recordOnDefault}, ${m.breakoutsEnabled},
        ${m.attendeeMuteDefault}, ${m.recurrence}, ${JSON.stringify(m.invitees)}::jsonb, 'scheduled'
      )
      RETURNING id::text AS id`))[0] as any;

    if (!created?.id) {
      // NOT swallowed and NOT reported as success. An INSERT that returned no row means the write
      // did not happen, and a "Meeting scheduled" toast over a meeting that does not exist is the
      // exact failure this pass is about.
      logEvent('error', 'meet.rooms.create-empty', { userId: user.id, code });
      return json({ ok: false, error: 'the meeting was not saved' }, 500);
    }

    logEvent('info', 'meet.rooms.created', { userId: user.id, code, kind: m.kind });
    return json({ ok: true, id: created.id, roomCode: code, href: '/portal/meet/' + code });
  } catch (e: any) {
    logEvent('error', 'meet.rooms.create-failed', { userId: user.id, code, message: reasonOf(e) });
    return json({ ok: false, error: 'the meeting could not be saved' }, 500);
  }
};
