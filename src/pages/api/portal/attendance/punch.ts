// POST /api/portal/attendance/punch — RECORD A PUNCH, WITH A SERVER-SIDE FACE CHECK, STORING NO IMAGE.
//
// =================================================================================================
// WHAT REACHES THIS ENDPOINT, AND WHAT NEVER DOES
// =================================================================================================
//
// ARRIVES:   a punch kind, the same geo/QR evidence the form already sent, and OPTIONALLY a
//            `descriptor` — 128 floating point numbers the browser computed from a camera frame it
//            then threw away.
//
// NEVER ARRIVES: a photograph. Not a data: URI, not a base64 blob, not a file, not a thumbnail. The
//            browser does not upload the frame; rejectsImagePayload() below refuses the request
//            outright if anything image-shaped turns up anyway, so the rule is ENFORCED and not
//            merely documented. A future edit that starts posting a selfie gets a 400 with a
//            sentence saying why, instead of quietly creating the thing this feature exists to
//            avoid.
//
// NEVER ARRIVES AND IS NEVER READ: a distance, a score, a `matched` flag or a threshold. The server
//            computes the comparison itself. src/pages/api/auth/enroll-face.ts still reads
//            `matchDistance` straight out of its request body and admits anyone who posts
//            `{ matchDistance: 0.01 }`; this endpoint does not have that defect and must not
//            acquire it. There is no code path here that reads a verdict from the body.
//
// NOTHING IS STORED FROM THE DESCRIPTOR EITHER. It is a local variable passed to verifyPunchFace(),
// which compares it and returns four scalars. It is not logged, not echoed, not cached, and there is
// no column anywhere that could hold it.
//
// =================================================================================================
// A FAILED CHECK STILL RECORDS THE PUNCH
// =================================================================================================
//
// Deliberate, and the most important decision in this file. Automated detection on this platform is
// ADVISORY ONLY. Someone who genuinely turned up, whose phone camera would not focus in a dark
// stairwell, must still end the day with a record of having been at work. So there is no branch
// between the verification result and punch(): every outcome — match, no match, no enrolment, no
// camera, server unavailable — records the punch and differs only in the label written beside it.
// A mismatch is surfaced for a human to look at and is never a penalty, a deduction or a refusal.
//
// The other half: the response says plainly which of those happened, and the screen prints it, so a
// verified punch and an unverified one never look the same.
//
// =================================================================================================
// AUTHORIZATION
// =================================================================================================
//
// The session decides WHO is punching. There is no employeeId or userId parameter, deliberately:
// requireEmployee() resolves the employee record from the signed-in user, so a caller cannot aim
// this endpoint at somebody else's attendance no matter what they post. The face is compared against
// THAT user's enrolment, so a descriptor lifted from anywhere else matches nothing.
//
// HOUSE RULES: every const is declared above the handler (`const` is not hoisted, and a handler
// reaching a later declaration has taken pages down here). Nothing is swallowed — a failure comes
// back with the real reason, because a punch that silently did nothing is how somebody discovers at
// the end of the month that they have no attendance.
import type { APIRoute } from 'astro';
import { punch } from '@/lib/attendance';
import { verifyPunchFace, declinedVerification, verificationLine } from '@/lib/attendance-verify';
import { requireEmployee } from '@/lib/auth/workspace-access';

export const prerender = false;

const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    // Per-person answer about one person's day. It must never land in a shared cache.
    headers: { 'Content-Type': 'application/json', 'cache-control': 'private, no-store' },
  });

/**
 * A descriptor is 128 numbers — under 3 kB as JSON. Anything materially larger is not a descriptor,
 * and the most likely thing it IS is an image somebody started posting. Capped before parsing so a
 * 300 kB base64 selfie cannot even be read into memory here, let alone stored.
 */
const MAX_BODY_BYTES = 32 * 1024;

/** Field names that would only ever be here to carry a picture. */
const IMAGE_KEYS = [
  'photo', 'image', 'selfie', 'frame', 'snapshot', 'facePhoto', 'face_photo',
  'dataUrl', 'dataURL', 'imageData', 'capture', 'jpeg', 'png', 'blob',
];

/**
 * REFUSE ANYTHING IMAGE-SHAPED. The storage rule made executable.
 *
 * Two independent tests, because either one alone is easy to slip past: a named field, and a data:
 * URI anywhere in the posted values whatever it is called. Returns a sentence to refuse with, or
 * null when the body is clean.
 */
const rejectsImagePayload = (body: any): string | null => {
  if (!body || typeof body !== 'object') return null;
  for (const key of IMAGE_KEYS) {
    if (key in body) {
      return 'This endpoint does not accept images. Attendance verification compares a mathematical signature and stores no photograph, so a field called "' + key + '" has nowhere to go.';
    }
  }
  for (const value of Object.values(body)) {
    if (typeof value === 'string' && /^data:\s*image\//i.test(value.slice(0, 40))) {
      return 'This endpoint does not accept images. A data: image URI was posted and has been discarded without being read or stored.';
    }
  }
  return null;
};

/** Punch kinds are re-checked inside punch() against the day so far; this is only a shape check. */
const KINDS = ['clock_in', 'break_start', 'break_end', 'clock_out'];

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = (locals as any)?.user;
  if (!user?.id) {
    return json({ ok: false, error: 'Please sign in to record a punch.' }, 401);
  }

  // WHOSE ATTENDANCE. Resolved from the session, never from the body.
  const gate = await requireEmployee(user as any, '/portal/employee/attendance');
  if (!gate.ok) {
    return json({ ok: false, error: gate.reason || 'This account has no employee record to record attendance against.' }, 403);
  }
  const employeeId = gate.workspace.employeeId;

  const raw = await request.text().catch(() => '');
  if (raw.length > MAX_BODY_BYTES) {
    return json({
      ok: false,
      error: 'That request is far larger than a face signature, so it has been refused unread. This endpoint takes 128 numbers, never a picture.',
    }, 413);
  }

  let body: any = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ ok: false, error: 'We could not read that request.' }, 400);
  }

  const imageRefusal = rejectsImagePayload(body);
  if (imageRefusal) {
    console.warn('[portal/attendance/punch] image-shaped payload refused for employee', employeeId);
    return json({ ok: false, error: imageRefusal }, 400);
  }

  const kind = String(body?.kind || '');
  if (!KINDS.includes(kind)) {
    return json({ ok: false, error: 'That is not something we record.' }, 400);
  }

  // ---------------------------------------------------------------------------------------------
  // THE CHECK. Server-side, against this user's own enrolment, and the descriptor is dropped after.
  //
  // `skipFace` is the person saying "record it without the camera". It is honoured exactly as
  // offered — it produces an unverified punch, which is a legitimate punch. It cannot be used to
  // claim a PASS, because the only thing it can produce is declinedVerification().
  // ---------------------------------------------------------------------------------------------
  const wantsFace = body?.skipFace !== true && body?.descriptor !== undefined && body?.descriptor !== null;
  const verification = wantsFace
    ? await verifyPunchFace(String(user.id), body.descriptor)
    : declinedVerification('no_capture');

  const res = await punch(employeeId, kind, {
    lat: num(body?.lat),
    lon: num(body?.lon),
    accuracy: num(body?.acc),
    qrCode: body?.qr ? String(body.qr).slice(0, 120) : null,
    workMode: body?.mode ? String(body.mode) : 'remote',
    ipAddress: (clientAddress || request.headers.get('x-forwarded-for') || '').toString().slice(0, 90),
    deviceInfo: request.headers.get('user-agent'),
    verification,
  });

  if (!res.ok) {
    // NEVER SWALLOWED. The engine's sentence, including the database's own reason when the write
    // itself failed, goes back as it is.
    return json({
      ok: false,
      error: res.error || 'That could not be recorded.',
      // The check still ran, and saying so stops the camera being pointed at the same face again
      // over a problem that had nothing to do with it.
      outcome: verification.outcome,
    }, 400);
  }

  return json({
    ok: true,
    kind,
    outcome: verification.outcome,
    verified: verification.verified,
    verificationLine: verificationLine(verification.outcome),
    advisory: res.advisory || null,
    totals: res.totals || null,
  });
};
