// POST /api/id-card/face-check - "IS THE PERSON IN FRONT OF ME THE PERSON THIS CARD IS FOR?"
//
// For the People desk or whoever is checking cards at a door. They scan the card, point their
// camera at the person holding it, and the server compares that capture with the cardholder's own
// enrolment. The answer is ONE BOOLEAN. No distance, no score, no template, no photo: a number would
// let somebody probe their way towards another person's enrolment, and an image is not needed for
// the comparison at all.
//
// ADVISORY. A "does not match" is a prompt to look properly, never an automatic refusal: lighting,
// glasses and a scratched lens all cause misses, and a human decides.
//
// Body: { token: string, descriptor: number[128] }.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { matchEnrolledFace } from '@/lib/auth/face';
import { verifyToken } from '@/lib/hr/id-card';
import { logAudit } from '@/lib/audit';

export const prerender = false;

// A small per-instance brake. The permission gate is the real control; this stops a stuck script
// from running hundreds of comparisons a minute against one person's enrolment.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 40;
const recent = new Map<string, number[]>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { permission: 'employee.manage', label: 'hr.id_card.face_check' });
  if (denied) return denied;
  const actor = (locals as any)?.user;

  const now = Date.now();
  const mine = (recent.get(String(actor?.id)) || []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= MAX_PER_WINDOW) return json({ ok: false, error: 'Too many face checks in a few minutes. Wait a little and try again.' }, 429);
  mine.push(now);
  recent.set(String(actor?.id), mine);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'That request was not readable.' }, 400); }

  const v = await verifyToken(String(body?.token || ''));
  if (v.verdict !== 'valid' || !v.holder) {
    return json({ ok: false, error: 'This card did not verify, so there is nobody to compare the face with.' }, 400);
  }
  if (!v.holder.userId) {
    return json({ ok: true, matched: false, enrolled: false, message: 'The cardholder has no sign-in account, so there is no face enrolment to compare with. Check the photo by eye.' });
  }

  try {
    const m = await matchEnrolledFace(v.holder.userId, body?.descriptor);
    await logAudit({
      userId: actor?.id ? String(actor.id) : null, action: 'hr.id_card.face_checked', entity: 'hr_id_card',
      entityId: v.card?.serial, diff: { matched: m.matched, enrolled: m.enrolled },
    }).catch(() => {});
    if (!m.enrolled) {
      return json({ ok: true, matched: false, enrolled: false, message: 'The cardholder has not enrolled a face, so there is nothing to compare with. Check the photo by eye.' });
    }
    return json({
      ok: true, matched: m.matched, enrolled: true,
      message: m.matched
        ? 'The face matches the cardholder\'s enrolment.'
        : 'The face did not match the cardholder\'s enrolment. This is advisory: check the photo, ask for the live phone card, and decide.',
    });
  } catch (e: any) {
    console.error('[api/id-card/face-check]', e?.cause?.message || e?.message);
    return json({ ok: false, error: 'The face check could not run just now. Check the photo by eye.' }, 503);
  }
};
