// GET /api/portal/quick-access — which quick-launch tiles this viewer may see.
//
// The launcher used to render a fixed tile list to everyone, so a signed-in person who had never
// been onboarded still saw Attendance, Wallet and Leave. Opening them was correctly refused, but
// the tile itself is the disclosure: it advertises entitlements the viewer does not have and
// invites them to go looking.
//
// THE DECISION IS MADE HERE, ON THE SERVER, from the session — never from anything the browser
// sends. The client only renders what this returns.
//
// THIS IS NOT ACCESS CONTROL. Hiding a tile hides a link, nothing more. Every /portal route must
// still authorise its own request, because anyone can call that URL directly regardless of what
// the launcher drew. This endpoint exists to stop over-disclosure in the UI, not to replace the
// checks behind it.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const prerender = false;

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

// Available to anyone signed in to the portal: their own front page and their own profile.
const BASE_TILES = ['home', 'profile'];

// Learning surfaces. Open to any portal account — interns, learners and staff alike.
// 'records' is everyone's own access history. It is never withheld: the whole point of showing a
// person who read their communications is that they do not have to be granted permission to look.
const LEARNER_TILES = ['learn', 'community', 'wellbeing', 'records'];

// Employment surfaces. These only mean anything for someone with an active HR record, and for
// anyone else they are an invitation to a screen that will refuse them.
const EMPLOYEE_TILES = ['attendance', 'wallet', 'leave'];

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    // Per-viewer answer, so it must never land in a shared cache.
    headers: { 'Content-Type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;

  // Not signed in: no tiles at all. Fail closed rather than falling back to a "safe" default set,
  // because an anonymous viewer has no portal of their own to be shown.
  if (!user?.id) return json({ allow: [] });

  const allow = [...BASE_TILES, ...LEARNER_TILES];

  try {
    // work_email IS NOT NAMED HERE, AND THAT IS THE FIX.
    //
    // It is declared in db/hr-schema.sql and does NOT exist on the production table. Naming a column
    // that does not exist makes the WHOLE statement throw, so this query failed on every single load
    // of every /portal page — BaseLayout loads /quick-launch.js on all of them and it fetches this
    // endpoint immediately. The catch below then swallowed it into a 200 with the employment tiles
    // missing, so a new joiner silently lost Attendance, Wallet and Leave on the very page that is
    // meant to be welcoming them, with nothing on screen saying anything had gone wrong.
    //
    // The identical mistake in src/lib/auth/admin-access.ts denied /admin to EVERY administrator
    // including the founder, who then bounced to /portal and landed on the onboarding screen — which
    // is exactly how somebody arrives at the page this was reported from. src/lib/employee-tasks.ts
    // records the same column costing three outages in one day.
    //
    // Matching on user_id, email and personal_email is what admin-access.ts settled on and what the
    // live schema actually supports. Addresses are compared case-insensitively, because an address is
    // the same address however it was typed into the HR form, and the email arms are omitted entirely
    // when the session carries no address so that an empty string can never match a row with an empty
    // column. The right answer is to stop naming the column, NOT to add another ALTER: the only ALTER
    // for it in src/ sits in the frontmatter of another page, so whether it exists depends on whether
    // somebody happened to open that page first, and a spent ensure-once key never runs again.
    const email = String(user.email || '').trim().toLowerCase();
    const byEmail = email
      ? sql` OR lower(coalesce(email, '')) = ${email} OR lower(coalesce(personal_email, '')) = ${email}`
      : sql``;
    const r = await db.execute(sql`
      SELECT 1 FROM hr_employees
      WHERE (user_id = ${user.id}${byEmail})
        AND is_active = true
      LIMIT 1`);
    if (rows(r).length) allow.push(...EMPLOYEE_TILES);
  } catch (e: any) {
    // A lookup failure must not hand out employment tiles. The viewer keeps the learner set and
    // simply sees fewer tiles than usual, which is the safe direction to be wrong in.
    console.error('[portal/quick-access]', e?.cause?.message || e?.message);
  }

  return json({ allow });
};
