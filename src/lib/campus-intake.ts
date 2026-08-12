// src/lib/campus-intake.ts — shared plumbing for the public campus intake forms.
//
// =================================================================================================
// WHY THIS EXISTS
// =================================================================================================
//
// Six forms across the campus pages posted to endpoints that had never been written. Each page
// created its own table, drew its own form, and pointed at a URL that answered 404. Two of them
// then told the person it had worked anyway:
//
//   test-centres  "Booking received. We will reach out via email within 24 h to confirm payment
//                  + seat."          — printed in the failure branch, with a comment saying so
//   forge         "Slot reserved. Operator will confirm via email within 30 minutes."
//   commons       "Saved locally. We will sync it shortly."  — nothing syncs anything
//
// A candidate who read the first of those believed a test seat was held for them. Nothing was
// stored anywhere, and nobody was ever going to email.
//
// So these endpoints exist to make those sentences true, and this module holds the parts all six
// need, so that six public write endpoints do not each invent their own validation.
//
// =================================================================================================
// THESE ARE PUBLIC, UNAUTHENTICATED WRITES
// =================================================================================================
//
// The campus pages have no login gate — that is deliberate, they are how somebody first reaches the
// place. So every one of these endpoints accepts input from anybody on the internet, and the rules
// below are the whole defence: cap every string, refuse anything that is not an email in the field
// called email, and never echo back what was stored.
//
// tooFast() is a per-process, in-memory limiter. It is honestly labelled: on serverless it bounds
// one instance, not the fleet, so it stops a stuck retry loop and a casual flood and nothing more.
// It is not a substitute for a real limiter and is not described as one anywhere.

const rowsOfRaw = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
export const rowsOf = rowsOfRaw;

export function json(d: any, status = 200): Response {
  return new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Trim, cap, and treat blank as absent. Returns null rather than '' so NOT NULL columns bite. */
export function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s.length ? s : null;
}

/** Shape only. Deliverability is not knowable here and pretending otherwise would reject real addresses. */
export function email(v: unknown): string | null {
  const s = text(v, 200);
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s.toLowerCase() : null;
}

/** A timestamp the database will accept, or null. Never passes an unparseable string through. */
export function when(v: unknown): string | null {
  const s = text(v, 64);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function num(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

// -------------------------------------------------------------------------------------------------
// Best-effort flood guard. Per process, in memory, and described as exactly that.
// -------------------------------------------------------------------------------------------------
const hits = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_IN_WINDOW = 6;

export function tooFast(bucket: string, who: string): boolean {
  const key = bucket + '|' + (who || 'unknown');
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();   // never let the guard become the leak
  return recent.length > MAX_IN_WINDOW;
}

/** The real Postgres reason is on e.cause; e.message is only the failed statement. */
export function logFail(where: string, e: any): void {
  console.error('[' + where + '] ' + (e?.cause?.message || e?.message || String(e)));
}

/** Read a JSON body without throwing on a malformed one. */
export async function bodyOf(request: Request): Promise<any> {
  try { return await request.json(); } catch { return null; }
}
