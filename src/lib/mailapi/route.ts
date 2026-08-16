// src/lib/mailapi/route.ts — the one place a developer-API request is authenticated, counted and
// error-handled.
//
// EVERY ROUTE GOES THROUGH THIS, SO NO ROUTE CAN FORGET. The alternative — each endpoint calling
// authenticate(), then the rate limiter, then remembering to attach the RateLimit headers, then
// wrapping itself in a try/catch that does not leak SQL — is the shape where the twelfth endpoint
// somebody adds quietly skips one of the four. Here, a route body receives an already-authenticated
// context and returns data; the envelope, the headers and the failure modes are decided once.
//
// THE HEADERS ARE ON THE SUCCESS PATH TOO. RateLimit-Remaining only helps a client that can see it
// before it gets blocked; attaching the counters only to the 429 tells them how much room they had
// exactly when it is too late to use it.
//
// A REFUSED CREDENTIAL IS COUNTED. It used to be free. authenticate() ran first and the five
// dimensions were only charged once it had succeeded, so a request carrying an unknown, malformed,
// expired or revoked key was charged to nothing at all: no bucket moved, no ceiling applied, and the
// caller could repeat it as fast as the network allowed while every single attempt still ran the
// `WHERE k.key_hash = …` lookup against the keys table. That is an unmetered credential-stuffing
// oracle with a database query attached to it. Two buckets now bound it, both charged here and both
// described where they are declared below.
import type { APIRoute } from 'astro';
import { ApiError, apiError, apiJson, handleApiError, newRequestId, preflight, type ErrorCode } from './errors';
import { authenticate, requireScope, type AuthContext, type Scope } from './keys';
import { DEFAULT_LIMITS, checkRateLimits, clientIp, consume, rateLimitHeaders, type Limit, type RateDecision } from './ratelimit';

// ---------------------------------------------------------------------------
// Metering the requests that never reach a route
//
// EVERY `const` HERE IS DECLARED ABOVE apiRoute() ON PURPOSE. `const` is not hoisted, and this
// project has already shipped two handlers that threw on their first line because a constant was
// declared underneath the function that read it. This is the funnel for every /api/v1 route, so
// that mistake here is the whole API returning 500.
// ---------------------------------------------------------------------------

/** The same reader ratelimit.ts uses for its own defaults. It is not exported from there. */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * The budget charged BEFORE we know who the caller is.
 *
 * Deliberately the same size as the per-IP budget the five-dimension check already enforces, so a
 * caller that never fails authentication is not made one request stricter: it used to charge `ip`
 * once per request and now charges `preauth_ip` once and `ip` once at the same ceiling, so the
 * request that gets refused is the same request that got refused before. What changed is who gets
 * counted — an attempt that dies inside authenticate() now moves a counter instead of being free.
 */
const PRE_AUTH_IP_LIMIT: Limit = {
  limit: envInt('MAILAPI_LIMIT_PREAUTH_IP', DEFAULT_LIMITS.ip.limit),
  windowSec: DEFAULT_LIMITS.ip.windowSec,
};

/**
 * The tight budget, charged ONLY by a caller who is already failing.
 *
 * A working key never touches this bucket, which is the point: throttling refusals hard is safe
 * precisely because a legitimate integration does not produce them. Ten refusals in five minutes is
 * more than a developer pasting the wrong key needs and far less than a guessing loop wants.
 */
const AUTH_FAILURE_LIMIT: Limit = {
  limit: envInt('MAILAPI_LIMIT_AUTH_FAILURES', 10),
  windowSec: envInt('MAILAPI_WINDOW_AUTH_FAILURES', 300),
};

/**
 * The codes that mean THE CREDENTIAL WAS REFUSED, as distinct from WE COULD NOT CHECK IT.
 *
 * Only these charge the failure bucket. If authenticate() throws because the database is unreachable
 * that is our fault, not the caller's, and billing it to their failure budget would turn one of our
 * outages into a lockout of every client that happened to be calling during it. Such a throw goes to
 * the outer catch and becomes the sanitized 500 it already was.
 *
 * `insufficient_scope` is absent for the opposite reason: that caller HAS a working key. It is a
 * misconfigured integration, not a guess, and it is already bounded by the pre-auth IP budget.
 */
const CREDENTIAL_FAILURE_CODES: readonly ErrorCode[] = [
  'missing_api_key', 'invalid_api_key', 'expired_api_key', 'revoked_api_key',
  'environment_mismatch', 'organization_inactive',
];

/** Was this throw a refused credential? Pure, so the distinction above is a test and not a guess. */
export function isCredentialFailure(e: unknown): boolean {
  return e instanceof ApiError && (CREDENTIAL_FAILURE_CODES as readonly string[]).includes(e.code);
}

/** One wording for both 429s, so a pre-auth refusal reads exactly like a post-auth one. */
export function retryMessage(resetSec: number): string {
  return 'Too many requests. Retry in ' + resetSec + ' second' + (resetSec === 1 ? '' : 's') + '.';
}

/**
 * The headers on a refused credential: Retry-After when the failure budget is spent, and nothing
 * else.
 *
 * NO `RateLimit-Remaining` HERE, UNLIKE THE SUCCESS PATH. On a 401 that counter is a countdown of
 * how many guesses the caller has left before we stop answering, which is a number worth having
 * only if you are guessing. Retry-After alone tells an honest client to back off and tells a
 * dishonest one nothing it could not measure by waiting.
 */
export function authFailureHeaders(requestId: string, d: RateDecision | null): Record<string, string> {
  const h: Record<string, string> = { 'X-Request-Id': requestId };
  if (d && !d.allowed) h['Retry-After'] = String(Math.max(1, d.resetSec));
  return h;
}

/**
 * Charge the pre-auth budget. FAILS OPEN, matching checkRateLimits().
 *
 * ratelimit.ts explains the direction and it applies with more force here: this bucket is charged by
 * EVERY caller including the well-behaved ones, so refusing when the counters cannot be read would
 * convert a slow database into a total API outage for every product at once — a far larger incident
 * than the burst it would have prevented. `null` is returned rather than a fabricated allow, so the
 * caller can tell "we could not check" from "the check said yes"; the log line is what makes the
 * degraded state visible instead of silent.
 */
async function chargePreAuth(ip: string): Promise<RateDecision | null> {
  try {
    return await consume('preauth_ip', ip, PRE_AUTH_IP_LIMIT);
  } catch (e: any) {
    console.error('[mailapi] pre-auth IP limiter unavailable, allowing request:', e?.cause?.message || e?.message);
    return null;
  }
}

/**
 * Charge the failure budget. FAILS CLOSED — the opposite direction to the one above, on purpose.
 *
 * This bucket is only ever reached by a request that has ALREADY been refused, so failing closed
 * costs a legitimate caller nothing: they were getting this exact 401 either way and the only
 * difference is that it now carries Retry-After, which during a database fault is advice we
 * genuinely mean. Failing open here would instead hand back the unmetered guessing oracle at
 * precisely the moment we are least able to see it happening. Bounding abuse is the one place this
 * codebase fails closed, and this is that place.
 */
async function chargeAuthFailure(ip: string): Promise<RateDecision> {
  try {
    return await consume('authfail_ip', ip, AUTH_FAILURE_LIMIT);
  } catch (e: any) {
    console.error('[mailapi] auth-failure limiter unavailable, throttling this refusal anyway:', e?.cause?.message || e?.message);
    return { allowed: false, limit: AUTH_FAILURE_LIMIT.limit, remaining: 0, resetSec: Math.max(1, AUTH_FAILURE_LIMIT.windowSec) };
  }
}

export interface ApiContext {
  request: Request;
  url: URL;
  /** Astro's route parameters, so a [id].ts route does not have to re-parse the path. */
  params: Record<string, string | undefined>;
  auth: AuthContext;
  requestId: string;
  /** Rate-limit headers to merge into whatever this route returns. */
  headers: Record<string, string>;
  json: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response;
}

export interface RouteOptions {
  /** Stable name for the per-endpoint rate-limit bucket and the log line. */
  endpoint: string;
  /** Scope required to call it at all. */
  scope?: Scope;
  /** For the send route: the From address, so one identity cannot burn the domain alone. */
  identityOf?: (request: Request, body: any) => string | null;
}

/**
 * Build an Astro APIRoute from a body that only has to do its own job.
 *
 * The handler is called with an authenticated context. Anything it throws is converted: an ApiError
 * carries its own code and message to the caller, and anything else is logged with the request id and
 * answered with a sanitized 500 — the rule src/lib/http-guard.ts sets for the whole codebase.
 */
export function apiRoute(opts: RouteOptions, handler: (ctx: ApiContext) => Promise<Response>): APIRoute {
  return async ({ request, clientAddress, params }) => {
    const requestId = newRequestId();
    const url = new URL(request.url);
    const ip = clientIp(request, clientAddress);
    try {
      // CHARGED BEFORE authenticate() SO THAT A REQUEST WHICH NEVER AUTHENTICATES STILL COSTS
      // SOMETHING. Once this ceiling is reached we answer without touching the keys table at all,
      // which is the half of the fix that stops the database query, not just the guessing.
      const gate = await chargePreAuth(ip);
      if (gate && !gate.allowed) {
        return apiError('rate_limit_exceeded', retryMessage(gate.resetSec),
          { requestId, headers: { ...rateLimitHeaders(gate), 'X-Request-Id': requestId } });
      }

      // authenticate() gets its own catch so that a refused credential can be charged for WITHOUT
      // also charging every unrelated throw from the handler below it.
      let auth: AuthContext;
      try {
        auth = await authenticate(request);
      } catch (e) {
        if (!isCredentialFailure(e)) throw e;
        const failed = await chargeAuthFailure(ip);
        const err = e as ApiError;
        // The SAME code, message and status as before this bucket existed, for every reason. Being
        // throttled must not be a new signal: if a spent budget answered differently from a fresh
        // one, the difference would be the oracle we are here to remove.
        return apiError(err.code, err.message,
          { param: err.param, requestId, headers: authFailureHeaders(requestId, failed), extra: err.extra });
      }

      if (opts.scope) requireScope(auth, opts.scope);

      const rate = await checkRateLimits({ auth, ip, endpoint: opts.endpoint });
      const headers = { ...rateLimitHeaders(rate), 'X-Request-Id': requestId };
      if (!rate.allowed) {
        return apiError('rate_limit_exceeded', retryMessage(rate.resetSec), { requestId, headers });
      }

      const ctx: ApiContext = {
        request, url, auth, requestId, headers, params: (params || {}) as Record<string, string | undefined>,
        json: (data, status = 200, extraHeaders = {}) => apiJson(data, status, { ...headers, ...extraHeaders }),
      };
      return await handler(ctx);
    } catch (e) {
      // What reaches here now: a scope refusal, anything the handler threw, and an authenticate()
      // fault that was NOT a refused credential (a database outage, say) — deliberately re-thrown
      // above so that our failure is never billed to the caller's failure budget. None of them got a
      // rate-limit decision, so none of them get rate-limit headers; they still get the request id,
      // which is what a developer needs to ask us about a specific failed call.
      const headers = { 'X-Request-Id': requestId };
      if (e instanceof ApiError) {
        return apiError(e.code, e.message, { param: e.param, requestId, headers, extra: e.extra });
      }
      return handleApiError(e, requestId, opts.endpoint);
    }
  };
}

/** Shared preflight handler. Every route exports this as OPTIONS. */
export const OPTIONS: APIRoute = async () => preflight();

/** A 405 with the methods that do exist, so a wrong verb is a useful answer rather than a mystery. */
export function methodNotAllowed(allowed: string[]): APIRoute {
  return async () => apiError('method_not_allowed', 'Allowed: ' + allowed.join(', ') + '.', { headers: { Allow: allowed.join(', ') } });
}
