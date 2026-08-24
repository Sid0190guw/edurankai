// /api/careers/intel/profile — KEEPING A PERSONALISATION, ON PURPOSE AND ONLY ON PURPOSE.
//
// SIGNED IN, OR NOTHING IS STORED. Every method here refuses without a session, and that refusal is
// the feature: an anonymous visitor's personalisation lives in their own browser and is never
// written to this database. The careers page works fully in that state — this endpoint exists so
// somebody who WANTS their answers kept across devices can ask for that, once, explicitly.
//
//   GET     what is saved, if anything
//   POST    save what the browser is holding
//   DELETE  forget it — a real DELETE of the row, not a flag
//
// READABLE IS NOT THE SAME AS EMPTY, and the response says which. `{ saved: null, readable: true }`
// means nothing has been saved; `readable: false` means the read failed. Rendering the second as
// the first is how this project has repeatedly turned a broken query into a confident empty state.

import type { APIRoute } from 'astro';
import { json } from '@/lib/career-intel/wire';
import { parseProfile } from '@/lib/career-intel/profile';
import { loadProfile, saveProfile, deleteProfile } from '@/lib/career-intel/store';

export const prerender = false;

const REFUSE = { ok: false, error: 'Sign in to keep your personalisation. Everything works without it — nothing is stored unless you ask.' };

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return json(REFUSE, 401);
  const loaded = await loadProfile(user.id);
  return json({
    ok: true,
    readable: loaded.readable,
    saved: loaded.profile,
    updatedAt: loaded.updatedAt,
    // A stored profile read by a newer interpreter can be re-read from the raw responses it kept.
    // Surfaced so the person can be offered that rather than being asked everything again.
    modelVersion: loaded.modelVersion,
  }, 200, 'no-store');
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return json(REFUSE, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Could not read that request.' }, 400);
  }

  // Validated on the way IN as well as on the way out. This document was assembled in a browser and
  // is about to become a jsonb value that later becomes a database query.
  const profile = parseProfile(body?.profile);
  const stored = await saveProfile(user.id, profile);

  // Reported honestly. db/career-intel-schema.sql is run by hand, so "the table is not there yet"
  // is a real state, and telling somebody their career profile was saved when it was not is the
  // kind of failure they only discover when they come back and it is gone.
  return json(stored
    ? { ok: true, stored: true }
    : { ok: false, stored: false, error: 'We could not save that. Your answers are still here in this browser.' },
    stored ? 200 : 503);
};

export const DELETE: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return json(REFUSE, 401);
  const gone = await deleteProfile(user.id);
  return json(gone
    ? { ok: true, deleted: true }
    : { ok: false, deleted: false, error: 'We could not delete that just now. Please try again.' },
    gone ? 200 : 503);
};
