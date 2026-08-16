// src/lib/mailops/service-auth.ts — the Vercel app calling the ZBook mail service.
//
// THE BOUNDARY THIS PROTECTS.
//
//   Browser  ->  Vercel API  ->  mail service (ZBook)  ->  Postfix
//
// The browser never reaches the mail service. That is not a convention, it is the security model:
// the mail service can inject into any mailbox and relay to the internet, so the only client it
// trusts is the application, and the only thing that proves an application is an HMAC over the
// request it is actually making.
//
// A STATIC BEARER TOKEN WOULD NOT DO. A bearer token in a header is replayable and, once captured
// from one request, authorises every other request including ones the holder never saw. The token
// minted here is bound to the METHOD, the PATH and a HASH OF THE BODY, and expires — so a captured
// "send one message" call cannot be reused to send a different message, or the same one twice.
//
// CLOCK SKEW IS THE OPERATIONAL RISK. The ZBook and Vercel do not share a clock. The window is
// generous enough (default 300s) to survive ordinary drift and short enough that a captured token
// is worthless by the time it is found in a log. A machine whose clock is minutes wrong will fail
// every call, and it will say so — `reason: 'token expired'` is a far better symptom than an
// intermittent 401.
import { createHmac, timingSafeEqual, createHash, randomUUID } from 'node:crypto';

export const AUTH_HEADER = 'authorization';
export const SCHEME = 'ERA-HMAC-SHA256';

export interface MintOptions {
  key: string;
  method: string;
  path: string;
  body?: string;
  ttlSeconds?: number;
  now?: number;
  nonce?: string;
}

export interface ServiceToken {
  header: string;
  nonce: string;
  expiresAt: number;
}

/** sha256 of the body, hex. Empty body hashes the empty string — a fixed, known value. */
export function bodyHash(body: string | undefined): string {
  return createHash('sha256').update(body ?? '').digest('hex');
}

/**
 * The string the MAC covers. Every field that changes the meaning of the request is in it, joined
 * by a character that cannot appear in any of them — otherwise `POST /a/b` and `POST /a` + `/b`
 * produce the same string and one signature authorises both.
 */
export function canonicalRequest(method: string, path: string, expiresAt: number, nonce: string, body?: string): string {
  return [String(method).toUpperCase(), path, String(expiresAt), nonce, bodyHash(body)].join('\n');
}

export function mintServiceToken(opts: MintOptions): ServiceToken {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const expiresAt = now + (opts.ttlSeconds ?? 300);
  const nonce = opts.nonce || randomUUID();
  const mac = createHmac('sha256', opts.key)
    .update(canonicalRequest(opts.method, opts.path, expiresAt, nonce, opts.body))
    .digest('hex');
  return {
    header: `${SCHEME} exp=${expiresAt},nonce=${nonce},sig=${mac}`,
    nonce,
    expiresAt,
  };
}

export interface VerifyServiceResult {
  ok: boolean;
  reason?: string;
  nonce?: string;
}

function parseHeader(value: string): Record<string, string> | null {
  const v = String(value || '').trim();
  if (!v.toUpperCase().startsWith(SCHEME.toUpperCase() + ' ')) return null;
  const out: Record<string, string> = {};
  for (const part of v.slice(SCHEME.length + 1).split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function equal(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try { return timingSafeEqual(ba, bb); } catch { return false; }
}

/**
 * Verify a request presented to the mail service.
 *
 * FAILS CLOSED on a missing key. A mail service running without MAIL_SERVICE_KEY set must refuse
 * everything: the alternative is an open relay with an API in front of it.
 */
export async function verifyServiceToken(
  headerValue: string | null | undefined,
  ctx: { key: string; method: string; path: string; body?: string; now?: number; seenNonce?: (n: string) => boolean | Promise<boolean> },
): Promise<VerifyServiceResult> {
  const key = (ctx.key || '').trim();
  if (!key) return { ok: false, reason: 'no service key configured — refusing all calls' };
  if (!headerValue) return { ok: false, reason: 'missing Authorization header' };

  const parts = parseHeader(headerValue);
  if (!parts) return { ok: false, reason: 'unrecognised authorization scheme' };

  const exp = Number(parts.exp);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed exp' };
  const now = Math.floor((ctx.now ?? Date.now()) / 1000);
  if (now > exp) return { ok: false, reason: `token expired ${now - exp}s ago (check clock skew between the app host and the mail host)` };
  // A far-future expiry is a forged or misconfigured token trying to mint itself a permanent key.
  if (exp - now > 3600) return { ok: false, reason: 'exp is more than an hour ahead — refusing a long-lived service token' };

  const nonce = parts.nonce || '';
  const sig = parts.sig || '';
  if (!nonce || !sig) return { ok: false, reason: 'missing nonce or sig' };

  const expected = createHmac('sha256', key).update(canonicalRequest(ctx.method, ctx.path, exp, nonce, ctx.body)).digest('hex');
  if (!equal(expected, sig)) return { ok: false, reason: 'signature does not match method, path, body or expiry' };

  if (ctx.seenNonce && (await ctx.seenNonce(nonce))) {
    return { ok: false, reason: 'nonce already used (replay)', nonce };
  }
  return { ok: true, nonce };
}

/** fetch() wrapper the app uses. Signs, sends, and never logs the header it just minted. */
export async function callMailService(
  path: string,
  init: { method?: string; body?: any; key?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  const base = (init.baseUrl || process.env.MAIL_SERVICE_URL || '').replace(/\/+$/, '');
  const key = init.key || process.env.MAIL_SERVICE_KEY || '';
  if (!base) return { ok: false, status: 0, error: 'MAIL_SERVICE_URL is not set' };
  if (!key) return { ok: false, status: 0, error: 'MAIL_SERVICE_KEY is not set' };

  const method = (init.method || 'POST').toUpperCase();
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const token = mintServiceToken({ key, method, path, body });

  // A call to the mail service must not hold a serverless function open. Vercel kills the function
  // at its own limit and the caller learns nothing; an explicit timeout produces a real error.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10000);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: token.header },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = { raw: text.slice(0, 500) }; }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : (data?.error || `mail service returned ${res.status}`) };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.name === 'AbortError' ? 'mail service did not respond in time' : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
