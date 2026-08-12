// POST /api/aquintutor/commons-signup — coffee roulette, dorm circles, and buddy requests.
//
// One endpoint for three forms because /aquintutor/campus/commons posts all three here with a
// `kind` discriminator, and the page is the caller that matters. The three tables it bootstraps
// (coffee_matches, dorm_circle_signups, buddy_requests) already exist; nothing had ever written a
// row to any of them, because this file did not exist and the page's failure branch said
// "Saved locally. We will sync it shortly." over a 404.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { json, text, email, tooFast, logFail, bodyOf } from '@/lib/campus-intake';

export const prerender = false;

const KINDS = ['coffee', 'circle', 'buddy'] as const;
type Kind = (typeof KINDS)[number];

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const b = await bodyOf(request);
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400);

  const kind = String(b.kind || '') as Kind;
  if (!KINDS.includes(kind)) return json({ ok: false, error: 'unknown kind' }, 400);

  const fullName = text(b.full_name, 120);
  const addr = email(b.email);
  // Both are required by every one of the three forms, and a row with neither cannot be acted on.
  if (!fullName) return json({ ok: false, error: 'a name is required' }, 400);
  if (!addr) return json({ ok: false, error: 'that email address does not look right' }, 400);
  if (tooFast('commons', clientAddress || addr)) return json({ ok: false, error: 'too many submissions just now — try again in a minute' }, 429);

  const year = text(b.year_of_study, 40);

  try {
    if (kind === 'coffee') {
      await db.execute(sql`
        INSERT INTO coffee_matches (full_name, email, year_of_study, interests, preferred_time)
        VALUES (${fullName}, ${addr}, ${year}, ${text(b.interests, 400)}, ${text(b.preferred_time, 60)})`);
    } else if (kind === 'circle') {
      await db.execute(sql`
        INSERT INTO dorm_circle_signups (full_name, email, year_of_study, circle_preference, availability)
        VALUES (${fullName}, ${addr}, ${year}, ${text(b.circle_preference, 120)}, ${text(b.availability, 200)})`);
    } else {
      await db.execute(sql`
        INSERT INTO buddy_requests (full_name, email, year_of_study, buddy_kind, reason)
        VALUES (${fullName}, ${addr}, ${year}, ${text(b.buddy_kind, 60)}, ${text(b.reason, 800)})`);
    }
    return json({ ok: true });
  } catch (e: any) {
    logFail('commons-signup', e);
    // The page prints its own failure line from this. It must not read as a success.
    return json({ ok: false, error: 'could not record that just now' }, 500);
  }
};
