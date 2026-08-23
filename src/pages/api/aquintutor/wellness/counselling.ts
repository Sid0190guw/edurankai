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
// WHAT THIS IS NOT: an emergency service. `urgency` is stored faithfully, and nothing in this
// product watches this table in real time.
//
// THE LINE ABOVE USED TO END "and this endpoint must never be described as though something does",
// AND THE PAGE DESCRIBED IT AS THOUGH SOMETHING DID. /aquintutor/campus/wellness told anybody who
// read it that a request here "reaches the counselling team as a real request, not a message into
// the void". There was no GET on this route, nothing anywhere SELECTed the notes, and nobody was
// notified. It was exactly a message into the void.
//
// A request now reaches a configured counsellor through notifyCounselling, carrying the FACT of the
// request and none of its content — see src/lib/wellness-routing.ts for why the notes stay here.
// When no counsellor is configured the row is still written and the response says `monitored: false`
// so the page can stop claiming a team, which is the only honest thing to say in that state.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { json, text, when, tooFast, logFail, bodyOf } from '@/lib/campus-intake';
import { notifyCounselling, isCounsellingMonitored, counsellingPromise } from '@/lib/wellness-routing';

export const prerender = false;

const URGENCY = ['standard', 'soon', 'urgent'];

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const b = await bodyOf(request);
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400);

  const anonymous = b.anonymous !== false;   // absent or true both mean anonymous
  const contact = text(b.contact, 200);
  if (!contact) return json({ ok: false, error: 'a way to reach you is needed, otherwise nobody can confirm the appointment' }, 400);
  if (await tooFast('counselling', clientAddress || contact)) return json({ ok: false, error: 'that went through several times just now — give it a minute' }, 429);

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

    // AFTER the write, and its failure is not the request's failure. The row is the durable record;
    // a mail outage must not turn "we saved it" into an error the person reads as "it did not send".
    const monitored = isCounsellingMonitored();
    if (monitored) {
      await notifyCounselling({
        urgency,
        language: text(b.language, 60) || 'English',
        contact,
        preferredSlot: when(b.preferred_slot),
        anonymous,
      });
    }
    // `message` comes from the module rather than from this file, so what the person is told cannot
    // drift away from whether anybody is actually there.
    return json({ ok: true, status: 'pending', monitored, message: counsellingPromise(monitored) });
  } catch (e: any) {
    // The reason is logged, never returned — an error string from this table could carry the value of
    // a column with somebody's disclosure in it.
    logFail('wellness-counselling', e);
    return json({ ok: false, error: 'could not send that just now' }, 500);
  }
};
