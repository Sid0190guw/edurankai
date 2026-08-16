// mail-engine/src/publish/signature.ts — the request signature, and nothing else.
//
// SEPARATE FROM http.ts ON PURPOSE. The application's routes under src/pages/api/mail/engine/ need
// to VERIFY a signature, and nothing more. Importing the publisher to get at that pulled the durable
// outbox, node:fs and the metrics registry into an Astro serverless bundle whose only job is to
// check a hash — weight and filesystem access that a function running on Vercel has no use for.
//
// Both sides of the link import this one file, so there is exactly one implementation of the scheme
// to get right, and it depends on node:crypto alone.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-mail-engine-signature';
export const TIMESTAMP_HEADER = 'x-mail-engine-timestamp';

/**
 * `HMAC-SHA256(secret, "<timestamp>.<body>")`, hex.
 *
 * The timestamp is inside the hash, not beside it: that is what makes a captured request
 * non-replayable once the receiver rejects old timestamps. The body is inside it too, so a captured
 * request cannot be edited either. A bearer token in a header gives neither property.
 */
export function signBody(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Constant-time comparison. A plain `===` on a hex digest leaks, through timing, how many leading
 * characters were correct — which is enough to reconstruct a valid signature one character at a
 * time given enough requests.
 */
export function verifySignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = signBody(secret, timestamp, body);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  // timingSafeEqual throws on a length mismatch, so the lengths are compared first. That comparison
  // is not constant-time, and it does not need to be: the length of a SHA-256 hex digest is public.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Requests older than this are refused even with a valid signature. Shared by both ends. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Is this timestamp close enough to now to be worth checking the signature of? */
export function timestampIsFresh(timestamp: string, now = Date.now()): boolean {
  const age = Math.abs(now - Number(timestamp));
  return Number.isFinite(age) && age <= MAX_CLOCK_SKEW_MS;
}
