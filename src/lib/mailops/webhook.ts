// src/lib/mailops/webhook.ts — signing and verifying the boundary between the MTA and the app.
//
// WHAT IS WRONG WITH THE SHARED SECRET WE HAVE. /api/mail/inbound authenticates with a bare secret
// in `x-mail-secret`. That proves the caller once knew the secret. It does not prove the body was
// not altered, and it does not prove the request is not a copy of one sent an hour ago — anything
// that ever saw one valid request can replay it forever, and every replay delivers another copy of
// the message into somebody's inbox.
//
// WHAT THIS ADDS. An HMAC over `timestamp . body`, plus a freshness window. Altering the body
// breaks the signature; replaying an old request falls outside the window. The secret is never
// transmitted.
//
// BACKWARD COMPATIBILITY IS THE POINT, NOT AN AFTERTHOUGHT. Patch 2 owns the inbound route and an
// MTA in the field is already configured with the shared secret. `verifyInbound()` accepts EITHER
// scheme and reports WHICH one authenticated, so the route can keep working today, the operator can
// see on a dashboard that a sender is still on the weaker scheme, and the shared secret can be
// retired on evidence rather than on hope. Nothing here changes an existing contract.
//
// TIMING. Comparison is constant-time. A byte-by-byte compare on a signature leaks the signature
// one byte at a time to anyone patient enough to measure.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-era-signature';
export const TIMESTAMP_HEADER = 'x-era-timestamp';
export const ID_HEADER = 'x-era-delivery-id';
export const LEGACY_SECRET_HEADER = 'x-mail-secret';

/** Version prefix on the signature. A scheme with no version cannot be replaced without a flag day. */
export const SIG_VERSION = 'v1';

export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * The signed payload. Version and timestamp are INSIDE the MAC, not just alongside it — a signature
 * that covers only the body lets an attacker keep the signature and move the timestamp.
 */
export function signingString(version: string, timestamp: number, body: string): string {
  return `${version}.${timestamp}.${body}`;
}

export function sign(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(signingString(SIG_VERSION, timestamp, body)).digest('hex');
  return `${SIG_VERSION}=${mac}`;
}

/** Constant-time compare that does not throw on a length mismatch (timingSafeEqual does). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return timingSafeEqual(ba, bb); } catch { return false; }
}

export type AuthScheme = 'hmac' | 'shared-secret' | 'none';

export interface VerifyResult {
  ok: boolean;
  scheme: AuthScheme;
  /** Present when ok is false. Safe to log; deliberately never echoes the presented signature. */
  reason?: string;
  /** Set when the caller used the legacy scheme, so an operator can find senders still to migrate. */
  legacy?: boolean;
  deliveryId?: string;
}

export interface VerifyOptions {
  hmacSecret?: string;
  sharedSecret?: string;
  toleranceSeconds?: number;
  /** Injected so tests are not clock-dependent. */
  now?: number;
  /**
   * Reject a delivery id already seen. Replay protection inside the window needs state; without a
   * store, the timestamp window is the only defence and a duplicate inside 5 minutes still lands.
   * Left to the caller because the right store differs per deployment (Postgres today, Redis later).
   */
  seen?: (id: string) => boolean | Promise<boolean>;
}

/**
 * Verify an inbound webhook request.
 *
 * FAILS CLOSED. No secret configured means nothing is accepted — an unauthenticated inbound route
 * is an open door into every user's inbox, and "it stopped working after deploy" is a far better
 * outcome than "anyone can inject mail".
 */
export async function verifyInbound(
  headers: Headers | Record<string, string | null | undefined>,
  rawBody: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const get = (name: string): string => {
    const v = headers instanceof Headers ? headers.get(name) : (headers as any)[name] ?? (headers as any)[name.toLowerCase()];
    return (v ?? '').toString();
  };

  const hmacSecret = (opts.hmacSecret || '').trim();
  const sharedSecret = (opts.sharedSecret || '').trim();
  if (!hmacSecret && !sharedSecret) {
    return { ok: false, scheme: 'none', reason: 'no inbound secret configured — refusing every request rather than accepting any' };
  }

  const presented = get(SIGNATURE_HEADER);
  if (presented && hmacSecret) {
    const tsRaw = get(TIMESTAMP_HEADER);
    const ts = Number(tsRaw);
    if (!tsRaw || !Number.isFinite(ts)) return { ok: false, scheme: 'hmac', reason: 'signature present but timestamp header missing or not a number' };

    const now = Math.floor((opts.now ?? Date.now()) / 1000);
    const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    const drift = Math.abs(now - ts);
    if (drift > tolerance) {
      return { ok: false, scheme: 'hmac', reason: `timestamp is ${drift}s away from now, outside the ${tolerance}s window` };
    }

    const expected = sign(hmacSecret, rawBody, ts);
    if (!safeEqual(expected, presented)) return { ok: false, scheme: 'hmac', reason: 'signature does not match' };

    const deliveryId = get(ID_HEADER) || undefined;
    if (deliveryId && opts.seen) {
      const already = await opts.seen(deliveryId);
      if (already) return { ok: false, scheme: 'hmac', reason: 'delivery id already processed (replay)', deliveryId };
    }
    return { ok: true, scheme: 'hmac', deliveryId };
  }

  // Legacy path. Still constant-time, still refuses an empty presented value against an empty
  // configured value — `'' === ''` would otherwise authenticate every anonymous request the moment
  // the secret is cleared, which is exactly when you least want an open door.
  if (sharedSecret) {
    const legacyPresented = get(LEGACY_SECRET_HEADER);
    if (!legacyPresented) return { ok: false, scheme: 'none', reason: 'no signature and no shared secret presented' };
    if (!safeEqual(sharedSecret, legacyPresented)) return { ok: false, scheme: 'shared-secret', reason: 'shared secret does not match' };
    return { ok: true, scheme: 'shared-secret', legacy: true };
  }

  return { ok: false, scheme: 'none', reason: 'signature header present but no HMAC secret configured' };
}

/** Headers a sender attaches. Used by the mail worker, the test harness and the docs example. */
export function signedHeaders(secret: string, body: string, opts: { now?: number; deliveryId?: string } = {}): Record<string, string> {
  const ts = Math.floor((opts.now ?? Date.now()) / 1000);
  return {
    'Content-Type': 'application/json',
    [TIMESTAMP_HEADER]: String(ts),
    [SIGNATURE_HEADER]: sign(secret, body, ts),
    [ID_HEADER]: opts.deliveryId || randomUUID(),
  };
}
