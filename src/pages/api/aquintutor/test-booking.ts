// POST /api/aquintutor/test-booking — hold a seat at a test centre.
//
// THE PAGE THAT CALLS THIS USED TO CLAIM THE SEAT WAS HELD WHEN THIS FILE DID NOT EXIST. The
// failure branch of /aquintutor/campus/test-centres printed "Booking received. We will reach out
// via email within 24 h to confirm payment + seat." with the class `ok`, over a 404, under a comment
// that said "Even if the API endpoint is not wired, gracefully report". A candidate reading that had
// every reason to stop looking for a seat.
//
// A booking is `pending` here and nothing else. It is a request that a human confirms — the page's
// own copy says a confirmation follows, and this endpoint must not imply more than it did.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { json, text, email, when, tooFast, logFail, bodyOf, rowsOf } from '@/lib/campus-intake';

import { notifyIntake, isIntakeRouted, intakePromise } from '@/lib/intake-routing';

export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const b = await bodyOf(request);
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400);

  const testId = text(b.test_id, 80);
  const name = text(b.candidate_name, 120);
  const slot = when(b.slot);
  if (!testId) return json({ ok: false, error: 'pick a test' }, 400);
  if (!name) return json({ ok: false, error: 'a candidate name is required' }, 400);
  // A booking with no slot is not a booking. Storing one would put a row in the queue that nobody
  // could act on and that the candidate believes is a time.
  if (!slot) return json({ ok: false, error: 'pick a date and time' }, 400);

  const addr = email(b.candidate_email);
  if (!addr) return json({ ok: false, error: 'an email address is required so the seat can be confirmed' }, 400);
  if (await tooFast('test-booking', clientAddress || addr)) return json({ ok: false, error: 'too many submissions just now — try again in a minute' }, 429);

  try {
    const r = await db.execute(sql`
      INSERT INTO test_bookings (test_id, test_name, candidate_name, candidate_email, slot,
                                 special_accommodations, tier, status)
      VALUES (${testId}, ${text(b.test_name, 160)}, ${name}, ${addr}, ${slot}::timestamp,
              ${text(b.special_accommodations, 600)}, ${text(b.tier, 40) || 'standard'}, 'pending')
      RETURNING id`);

    // NOBODY WAS TOLD, AND THE ACCOMMODATION FIELD IS WHY THAT MATTERED.
    //
    // This table had no reader anywhere in the codebase — the only SELECT against it is a COUNT of
    // the last 24 hours on the test-centres page — and nothing notified anybody. A candidate could
    // ask for a sign-language interpreter, a screen reader or a low-distraction room, be told
    // "pending", and no operator would ever learn to arrange it. The field was collected and
    // discarded, which is worse than not offering it: the person believes the accommodation is
    // handled and finds out on the day that it is not.
    //
    // The accommodation IS forwarded here, unlike a counselling disclosure. It has to be — it cannot
    // be arranged by somebody who has not been told what it is, and it was filled in for exactly
    // that purpose. See mayForwardContent in src/lib/intake-routing.ts, where that distinction is
    // declared per intake rather than decided ad hoc at each call site.
    const routed = isIntakeRouted('test-booking');
    if (routed) await notifyIntake('test-booking', {
      subject: 'Test centre - new booking',
      lines: [
        'Test: ' + (text(b.test_name, 160) || testId),
        'Candidate: ' + name,
        'Reach them at: ' + addr,
        'Slot: ' + String(slot),
        'Tier: ' + (text(b.tier, 40) || 'standard'),
        'Accommodations requested: ' + (text(b.special_accommodations, 600) || 'none stated'),
      ],
    });
    return json({
      ok: true, id: rowsOf(r)[0]?.id ?? null, status: 'pending', routed,
      message: intakePromise('test-booking', routed),
    });
  } catch (e: any) {
    logFail('test-booking', e);
    return json({ ok: false, error: 'could not hold that seat just now' }, 500);
  }
};
