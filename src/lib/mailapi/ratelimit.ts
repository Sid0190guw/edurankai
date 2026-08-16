// src/lib/mailapi/ratelimit.ts — fixed-window rate limiting across five dimensions.
//
// WHY FIVE DIMENSIONS AND NOT ONE. A single per-key limit protects nothing that matters: a leaked
// key can be replaced with a second key on the same organization, one runaway loop in a staging
// script can spend the whole organization's budget, and a shared IP can hammer an endpoint with no
// key at all. Each dimension answers a different failure:
//
//   organization       — one product cannot starve another
//   API key            — one integration cannot starve its siblings
//   IP                 — an unauthenticated flood is stopped before it reaches the database
//   endpoint (per key) — a tight loop on one route cannot exhaust the key's whole allowance
//   sending identity   — one From address cannot burn the domain's reputation on its own
//
// THE CHECK AND THE INCREMENT ARE ONE STATEMENT. A SELECT followed by an UPDATE lets two concurrent
// requests both read "under the limit" and both proceed, which is precisely the shape that makes a
// rate limit look present and not be one. `INSERT … ON CONFLICT DO UPDATE … RETURNING count` is
// atomic, and the returned count is the post-increment value this request actually consumed.
//
// NOTHING IN THE RESPONSE NAMES OUR INFRASTRUCTURE. The caller learns the limit, what is left, when
// it resets and how long to wait. Which dimension tripped, what the database is, and how many
// instances are running are ours.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailApiSchema, rows } from './schema';
import type { AuthContext } from './keys';

// ---------------------------------------------------------------------------
// Pure window arithmetic — no database
// ---------------------------------------------------------------------------

export interface Limit { limit: number; windowSec: number }

/** Defaults, overridable per key (mailapi_keys.rate_limit_per_minute) and by environment variable. */
export const DEFAULT_LIMITS: Record<'org' | 'key' | 'ip' | 'endpoint' | 'identity', Limit> = {
  org: { limit: envInt('MAILAPI_LIMIT_ORG', 600), windowSec: 60 },
  key: { limit: envInt('MAILAPI_LIMIT_KEY', 300), windowSec: 60 },
  ip: { limit: envInt('MAILAPI_LIMIT_IP', 300), windowSec: 60 },
  endpoint: { limit: envInt('MAILAPI_LIMIT_ENDPOINT', 240), windowSec: 60 },
  identity: { limit: envInt('MAILAPI_LIMIT_IDENTITY', 200), windowSec: 60 },
};

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** The start of the fixed window containing `nowMs`, in epoch milliseconds. */
export function windowStartMs(nowMs: number, windowSec: number): number {
  const w = Math.max(1, Math.floor(windowSec)) * 1000;
  return Math.floor(nowMs / w) * w;
}

/** Whole seconds until the current window ends. Always at least 1, so Retry-After is never 0. */
export function resetInSec(nowMs: number, windowSec: number): number {
  const start = windowStartMs(nowMs, windowSec);
  return Math.max(1, Math.ceil((start + windowSec * 1000 - nowMs) / 1000));
}

/** The bucket identity. Hashing is unnecessary — these values are already ids we own. */
export function bucketKey(dimension: string, id: string, windowSec: number): string {
  return dimension + ':' + String(id || 'none').slice(0, 120) + ':' + windowSec;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
}

/** Given the post-increment count, decide. Pure, so the boundary case is a test and not a guess. */
export function decide(count: number, limit: number, resetSec: number): RateDecision {
  const remaining = Math.max(0, limit - count);
  return { allowed: count <= limit, limit, remaining, resetSec };
}

/** The most restrictive of several decisions — the one the caller is actually bound by. */
export function strictest(decisions: RateDecision[]): RateDecision {
  if (decisions.length === 0) return { allowed: true, limit: 0, remaining: 0, resetSec: 1 };
  const blocked = decisions.filter((d) => !d.allowed);
  const pool = blocked.length ? blocked : decisions;
  return pool.reduce((a, b) => (b.remaining < a.remaining ? b : a));
}

/** The response headers. Draft-RFC names (`RateLimit-*`) plus Retry-After when blocked. */
export function rateLimitHeaders(d: RateDecision): Record<string, string> {
  const h: Record<string, string> = {
    'RateLimit-Limit': String(d.limit),
    'RateLimit-Remaining': String(d.remaining),
    'RateLimit-Reset': String(d.resetSec),
  };
  if (!d.allowed) h['Retry-After'] = String(d.resetSec);
  return h;
}

/** The client IP, from the proxy header Vercel sets. Never trusted for authorization — only counted. */
export function clientIp(request: Request, fallback?: string | null): string {
  const fwd = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return (fwd || fallback || 'unknown').slice(0, 64);
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** Increment one bucket and return the decision for it. */
export async function consume(dimension: string, id: string, limit: Limit, nowMs = Date.now()): Promise<RateDecision> {
  await ensureMailApiSchema();
  const bucket = bucketKey(dimension, id, limit.windowSec);
  const start = new Date(windowStartMs(nowMs, limit.windowSec));
  const r = rows(await db.execute(sql`
    INSERT INTO mailapi_rate_windows (bucket, window_start, count) VALUES (${bucket}, ${start.toISOString()}, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = mailapi_rate_windows.count + 1
    RETURNING count`));
  const count = Number(r[0]?.count || 1);
  return decide(count, limit.limit, resetInSec(nowMs, limit.windowSec));
}

export interface RateCheckInput {
  auth?: AuthContext | null;
  ip: string;
  endpoint: string;
  /** The From address for a send, so one identity cannot burn the domain's reputation alone. */
  identity?: string | null;
}

/**
 * Check every applicable dimension and return the binding decision.
 *
 * A DATABASE FAULT DOES NOT BECOME AN OUTAGE. If the counters cannot be read, the request is allowed
 * and the failure is logged: a rate limiter that fails closed turns a slow database into a total
 * sending outage for every product at once, which is a far larger incident than the burst it would
 * have prevented. The log line is what makes the degraded state visible.
 */
export async function checkRateLimits(input: RateCheckInput, nowMs = Date.now()): Promise<RateDecision> {
  const checks: Promise<RateDecision>[] = [];
  const keyLimit: Limit = input.auth?.rateLimitPerMinute
    ? { limit: input.auth.rateLimitPerMinute, windowSec: 60 }
    : DEFAULT_LIMITS.key;

  checks.push(consume('ip', input.ip, DEFAULT_LIMITS.ip, nowMs));
  if (input.auth) {
    checks.push(consume('org', input.auth.orgId, DEFAULT_LIMITS.org, nowMs));
    checks.push(consume('key', input.auth.keyId, keyLimit, nowMs));
    checks.push(consume('endpoint', input.auth.keyId + '|' + input.endpoint, DEFAULT_LIMITS.endpoint, nowMs));
    if (input.identity) {
      checks.push(consume('identity', input.auth.orgId + '|' + input.identity.toLowerCase(), DEFAULT_LIMITS.identity, nowMs));
    }
  }

  try {
    return strictest(await Promise.all(checks));
  } catch (e: any) {
    console.error('[mailapi] rate limiter unavailable, allowing request:', e?.cause?.message || e?.message);
    return { allowed: true, limit: keyLimit.limit, remaining: keyLimit.limit, resetSec: resetInSec(nowMs, 60) };
  }
}

/** Housekeeping: drop windows nobody can be inside any more. Called by the dispatcher. */
export async function pruneRateWindows(olderThanMinutes = 120): Promise<number> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    DELETE FROM mailapi_rate_windows
    WHERE window_start < now() - (${String(Math.max(5, olderThanMinutes))} || ' minutes')::interval
    RETURNING bucket`));
  return r.length;
}
