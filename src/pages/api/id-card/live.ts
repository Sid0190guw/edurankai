// POST /api/id-card/live - A FRESH 90-SECOND CODE FOR THE HOLDER'S OWN PHONE CARD.
//
// WHY A LIVE CODE AT ALL. A printed card's QR is the same forever, so a photograph of it works as
// well as the card. The phone card shows a code that changes every 30 seconds and dies after 90, so a
// screenshot is worthless a minute later, and the verification page says how old the code was.
//
// BIOMETRIC UNLOCK, ADVISORY AND SERVER-SIDE. The holder may unlock the card with their face: the
// browser sends the 128 numbers its camera produced (never an image), the server compares them with
// the enrolment it already holds (src/lib/auth/face.ts - the template never leaves the server), and
// on a match the time of that match is SIGNED INTO every code for the next ten minutes. A guard who
// scans it sees "unlocked with a face match 2 minutes ago". A failed or skipped check still produces
// a card - automated checks here are advisory, never a refusal - but the code says plainly that no
// face check happened, so the two never look alike.
//
// Body: { descriptor?: number[128] } to unlock, or { grant?: string } to refresh. Nothing else is read.
import type { APIRoute } from 'astro';
import { requireEmployee } from '@/lib/auth/workspace-access';
import { matchEnrolledFace } from '@/lib/auth/face';
import { activeCardFor, liveToken, activeSigningKey, signingKeyFor } from '@/lib/hr/id-card';
import { signGrant, verifyGrant, GRANT_TTL_SECONDS, LIVE_TTL_SECONDS, LIVE_REFRESH_SECONDS } from '@/lib/hr/id-card-crypto';
import { qrSvg } from '@/lib/qr';
import { publicUrl } from '@/lib/public-origin';
import { logAudit } from '@/lib/audit';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  const gate = await requireEmployee(user, '/portal/employee/id-card');
  if (!gate.ok) return json({ ok: false, error: gate.reason }, gate.code === 'not-signed-in' ? 401 : 403);
  const employeeId = gate.workspace.employeeId;

  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }

  const cardRead = await activeCardFor(employeeId);
  if (!cardRead.ready) return json({ ok: false, error: cardRead.error }, 503);
  const card = cardRead.value;
  if (!card) return json({ ok: false, error: 'No ID card has been issued to you yet. HR issues cards from the ID card desk.' }, 404);

  try { activeSigningKey(); } catch (e: any) {
    console.error('[api/id-card/live] signing key', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'ID cards cannot be signed on this deployment right now. Tell HR.' }, 503);
  }

  const now = Math.floor(Date.now() / 1000);
  let faceAt = 0;
  let grant: string | null = null;
  let faceMessage = '';

  if (Array.isArray(body?.descriptor)) {
    try {
      const m = await matchEnrolledFace(String(user.id), body.descriptor);
      // BOOLEAN ONLY to the browser. The distance stays on the server (see face.ts).
      if (m.matched) {
        faceAt = now;
        grant = signGrant(activeSigningKey(), { employeeId, serial: card.serial, faceAt: now, expiresAt: now + GRANT_TTL_SECONDS });
        faceMessage = 'Face matched. Your card is unlocked for ten minutes.';
      } else if (!m.enrolled) {
        faceMessage = 'You have no face enrolment, so the card shows without a face check. Enrol at /portal/face-setup.';
      } else {
        faceMessage = 'Your face did not match this time, so the card shows without a face check. Try again in better light.';
      }
      await logAudit({
        userId: String(user.id), action: 'hr.id_card.face_unlock', entity: 'hr_id_card', entityId: card.serial,
        diff: { matched: m.matched, enrolled: m.enrolled },
      }).catch(() => {});
    } catch (e: any) {
      console.error('[api/id-card/live] face match', e?.cause?.message || e?.message);
      faceMessage = 'The face check could not run just now, so the card shows without one.';
    }
  } else if (typeof body?.grant === 'string') {
    const g = verifyGrant(body.grant, signingKeyFor, now);
    if (g && g.employeeId === employeeId && g.serial === card.serial) {
      faceAt = g.faceAt;
      grant = body.grant;
    } else {
      faceMessage = 'Your face unlock has ended. Unlock again to show a face-checked card.';
    }
  }

  const token = liveToken(card, faceAt, now);
  const verifyUrl = publicUrl('/verify/id/' + token);
  const svg = await qrSvg(verifyUrl, { size: 220, level: 'M', margin: 1 });

  return json({
    ok: true,
    serial: card.serial,
    verifyUrl,
    qrSvg: svg,
    faceAt,
    grant,
    faceMessage,
    expiresIn: LIVE_TTL_SECONDS,
    refreshIn: LIVE_REFRESH_SECONDS,
    serverTime: now,
  });
};
