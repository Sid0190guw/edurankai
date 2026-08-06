// Server-side face matching for the login face gate.
//
// WHY THIS FILE EXISTS.
// The enrolled face descriptor is a BIOMETRIC TEMPLATE. It must never leave the server.
// src/pages/admin/login.astro used to hand it to the browser with
// `define:vars={{ storedDescriptor: faceDescriptor }}`, so anyone who could load the login page
// for a pending user read the stored template out of the page source, replayed it as the "live"
// capture, and the Euclidean distance came back 0 — a perfect match. That defeated face sign-in
// and disclosed biometric data. A password can be rotated; a face cannot.
//
// So the comparison happens HERE, on the server. The browser sends only the descriptor it just
// captured from the camera; it receives only a boolean. The enrolled descriptor is never
// serialised into a page, a data attribute, a JSON island, or a response body.
//
// Both the interactive poll (/api/auth/face-match) and the authoritative form POST that actually
// mints the session import from this file, so the two can never drift apart and let the browser
// be told "matched" by one threshold and refused by another.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

/**
 * Match threshold, unchanged from the value the login gate already enforced (0.6). Deliberately
 * NOT retuned as part of a security fix: moving this number changes who can sign in, which is a
 * policy decision, not a mechanism one.
 *
 * (The old client-side pre-check used a stricter 0.5 purely to decide when to submit the form.
 * It never granted anything — the server gate at 0.6 was and remains the only thing that does.)
 */
export const FACE_2FA_THRESHOLD = 0.6;

/** face-api descriptors are 128 floats. Anything else is not a descriptor. */
export const DESCRIPTOR_DIMS = 128;

// The real Postgres reason is on e.cause; e.message is only the SQL that failed.
export const causeOf = (e: any): string => e?.cause?.message || e?.message || 'unknown error';

/**
 * Euclidean distance — the same measure faceapi.euclideanDistance computes in the browser, so an
 * enrolment that passes today still passes after the comparison moves server-side.
 *
 * Declared above every consumer deliberately: `const` is not hoisted, and a handler reaching a
 * later declaration has taken pages down on this project before.
 */
export const euclid = (a: number[], b: number[]): number => {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (Number(a[i]) || 0) - (Number(b[i]) || 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
};

/**
 * Descriptors reach us as a JSON string, a plain array, or a jsonb object with numeric keys
 * depending on how they were written. Normalise all three to number[].
 */
export const normDesc = (d: any): number[] | null => {
  if (d == null) return null;
  if (typeof d === 'string') {
    try { return normDesc(JSON.parse(d)); } catch { return null; }
  }
  if (Array.isArray(d)) return d.map(Number);
  if (typeof d === 'object') {
    return Object.keys(d).sort((a, b) => Number(a) - Number(b)).map((k) => Number((d as any)[k]));
  }
  return null;
};

/** A descriptor of all zeros is a "no face detected" result, not a face. */
export const isDegenerate = (v: number[]): boolean =>
  !v.some((n: any) => Number.isFinite(n) && Math.abs(n) > 1e-6);

/** Parse and validate a descriptor supplied by the browser. Returns null if it is not usable. */
export const parseLiveDescriptor = (raw: unknown): number[] | null => {
  const v = normDesc(raw);
  if (!v || v.length !== DESCRIPTOR_DIMS) return null;
  if (v.some((n) => !Number.isFinite(n))) return null;
  if (isDegenerate(v)) return null;
  return v;
};

export type FaceMatchResult = {
  /** The only thing any caller is allowed to send to the browser. */
  matched: boolean;
  /**
   * Server-measured distance. For the AUDIT ROW AND SERVER LOGS ONLY — never put this in a
   * response body or a user-visible message. A numeric distance is a gradient: it lets an
   * attacker hill-climb toward the enrolled template one probe at a time, which is a slower
   * road to the same biometric disclosure this file exists to prevent.
   */
  distance: number;
  /** False when the user has no active enrolment row at all. */
  enrolled: boolean;
};

const NO_MATCH_DISTANCE = 99;

/**
 * Load the enrolled descriptor for a user and compare it to a live capture.
 *
 * The enrolled descriptor is read, used, and dropped inside this function. It is not returned.
 *
 * Throws on a database failure rather than reporting a false negative — an auth path must not
 * turn "the database is down" into "your face is wrong", and it must not swallow the reason.
 */
export async function matchEnrolledFace(userId: string, liveRaw: unknown): Promise<FaceMatchResult> {
  const live = parseLiveDescriptor(liveRaw);

  const r = await db.execute(
    sql`SELECT face_descriptor FROM user_face_enrollments WHERE user_id = ${userId} AND is_active = true LIMIT 1`
  );
  // postgres-js returns a plain array. Never r.rows[0].
  const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
  if (rows.length === 0) {
    return { matched: false, distance: NO_MATCH_DISTANCE, enrolled: false };
  }

  const stored = normDesc((rows[0] as any).face_descriptor);
  if (!stored || stored.length !== DESCRIPTOR_DIMS || !live) {
    return { matched: false, distance: NO_MATCH_DISTANCE, enrolled: true };
  }

  const distance = euclid(stored, live);
  return { matched: distance < FACE_2FA_THRESHOLD, distance, enrolled: true };
}

/**
 * Does this user have an active face enrolment? Used to decide whether to render the camera UI.
 * Returns a boolean and nothing else — the page never needs the descriptor to draw a viewfinder.
 */
export async function hasActiveFaceEnrolment(userId: string): Promise<boolean> {
  const r = await db.execute(
    sql`SELECT id FROM user_face_enrollments WHERE user_id = ${userId} AND is_active = true LIMIT 1`
  );
  const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
  return rows.length > 0;
}
