// POST /api/aquintutor/wellness/counselling — ask for a counselling appointment.
//
// =================================================================================================
// THIS HANDLES INDIVIDUAL HEALTH DATA, SO THE RULES ARE THE POINT OF THE FILE
// =================================================================================================
//
// The body carries a mental-health topic from a fixed list (anxiety, low mood, grief, body image,
// among others) and free text. CLAUDE.md is explicit that no admin, and not the founder, may read
// one person's health disclosures. Three consequences, all enforced here:
//
//   1. ANONYMOUS MEANS THE NAME IS NEVER STORED. The form ticks it by default. When it is on, the
//      display name is dropped at this boundary rather than written and filtered later — a row that
//      was never written cannot leak from a screen somebody adds next year.
//   2. NOTHING IS ECHOED BACK. The response is an acknowledgement and a status. It never returns the
//      stored row, so this endpoint cannot become a read path for somebody else's disclosure.
//   3. NO PER-PERSON ADMIN VIEW MAY BE BUILT ON THIS TABLE. The wellness page reads a COUNT and
//      nothing else, and that is the only shape of oversight allowed over it.
//
// A CONTACT IS STILL REQUIRED, AND THAT IS NOT A CONTRADICTION. Anonymous here means "not named to
// the organisation", not "unreachable" — the page promises a counsellor will confirm, and a request
// with no way to answer it is a request that quietly dies. Somebody who wants neither should not be
// filling in this form at all.
//
// WHAT THIS IS NOT: an emergency service. `urgency` is stored faithfully, but nothing in this
// product watches this table in real time and this endpoint must never be described as though
// something does.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { json, text, when, tooFast, logFail, bodyOf } from '@/lib/campus-intake';

export const prerender = false;

const URGENCY = ['standard', 'soon', 'urgent'];

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const b = await bodyOf(request);
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400);

  const anonymous = b.anonymous !== false;   // absent or true both mean anonymous
  const contact = text(b.contact, 200);
  if (!contact) return json({ ok: false, error: 'a way to reach you is needed, otherwise nobody can confirm the appointment' }, 400);
  if (tooFast('counselling', clientAddress || contact)) return json({ ok: false, error: 'that went through several times just now — give it a minute' }, 429);

  // Dropped here, not stored and hidden later.
  const displayName = anonymous ? null : text(b.display_name, 120);

  const urgencyRaw = String(b.urgency || 'standard');
  const urgency = URGENCY.includes(urgencyRaw) ? urgencyRaw : 'standard';

  try {
    await db.execute(sql`
      INSERT INTO counselling_requests (anonymous, display_name, contact, language, topic, urgency, preferred_slot, notes, status)
      VALUES (${anonymous}, ${displayName}, ${contact}, ${text(b.language, 60) || 'English'},
              ${text(b.topic, 120)}, ${urgency}, ${when(b.preferred_slot)}::timestamptz,
              ${text(b.notes, 2000)}, 'pending')`);
    return json({ ok: true, status: 'pending' });
  } catch (e: any) {
    // The reason is logged, never returned — an error string from this table could carry the value of
    // a column with somebody's disclosure in it.
    logFail('wellness-counselling', e);
    return json({ ok: false, error: 'could not send that just now' }, 500);
  }
};
