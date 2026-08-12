// POST /api/aquintutor/wellness/sleep-signup — join the sleep programme.
//
// Health-adjacent rather than a clinical disclosure, but it is still a person's habits, so it
// follows the same two rules as the counselling endpoint: nothing is echoed back, and no per-person
// admin view may be built on this table. The wellness page reads a COUNT from it and nothing else.
//
// The page said "Signed up. We will email your sleep diary today." on success — and this file did
// not exist, so that sentence had never once been true.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { json, text, tooFast, logFail, bodyOf } from '@/lib/campus-intake';

export const prerender = false;

/** A clock time as the form's <input type="time"> produces it, or null. */
function clock(v: unknown): string | null {
  const s = text(v, 8);
  return s && /^\d{1,2}:\d{2}$/.test(s) ? s : null;
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const b = await bodyOf(request);
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400);

  const contact = text(b.contact, 200);
  if (!contact) return json({ ok: false, error: 'a way to reach you is needed so the diary can be sent' }, 400);
  if (tooFast('sleep', clientAddress || contact)) return json({ ok: false, error: 'that went through several times just now — give it a minute' }, 429);

  try {
    await db.execute(sql`
      INSERT INTO sleep_program_signups (display_name, contact, timezone, chronotype, bedtime, waketime, goals)
      VALUES (${text(b.display_name, 120)}, ${contact}, ${text(b.timezone, 60)},
              ${text(b.chronotype, 60)}, ${clock(b.bedtime)}, ${clock(b.waketime)}, ${text(b.goals, 1200)})`);
    return json({ ok: true });
  } catch (e: any) {
    logFail('wellness-sleep', e);
    return json({ ok: false, error: 'could not sign you up just now' }, 500);
  }
};
