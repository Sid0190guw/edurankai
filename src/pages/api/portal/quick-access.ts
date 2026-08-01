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
const LEARNER_TILES = ['learn', 'community', 'wellbeing'];

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
    const r = await db.execute(sql`
      SELECT 1 FROM hr_employees
      WHERE (user_id = ${user.id} OR work_email = ${user.email} OR personal_email = ${user.email})
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
