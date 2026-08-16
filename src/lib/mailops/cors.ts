// src/lib/mailops/cors.ts — the browser-facing CORS policy for mail endpoints.
//
// WHY NOT REUSE `CORS` FROM src/lib/api-keys.ts. That one is `Access-Control-Allow-Origin: *`, and
// it is correct where it is used: the public REST API is authenticated by an `x-api-key` header,
// carries no cookies, and is meant to be callable from anywhere. Mail is the opposite case. A mail
// endpoint is authenticated by the SESSION COOKIE, and a wildcard origin on a cookie-bearing
// endpoint is the classic setup for reading a signed-in user's mailbox from any page they visit.
//
// The browser enforces this rule, which means two things people get backwards:
//   1. CORS is not access control. It stops a SCRIPT on another origin reading the response. It
//      stops nothing at all coming from curl, a server, or a native app. Authorization still has to
//      be checked in the handler — always.
//   2. `Allow-Origin: *` with `Allow-Credentials: true` is not permissive, it is INVALID; browsers
//      reject the combination. Code that emits both looks maximally open and is actually broken,
//      which is how it survives review.
//
// So: an explicit allowlist, echoed back one origin at a time, `Vary: Origin` so a cache never
// hands one site's permission to another, and no header at all for an origin not on the list.

/** Parse the comma-separated allowlist. Trailing slashes and case are normalised away. */
export function parseOrigins(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | null | undefined, allowlist: string[]): boolean {
  if (!origin) return false;
  const o = origin.trim().replace(/\/+$/, '').toLowerCase();
  // No wildcards, no suffix matching. `*.edurankai.in` would match `evil-edurankai.in.attacker.com`
  // under a naive endsWith, and every CORS bypass write-up starts with someone's suffix match.
  return allowlist.includes(o);
}

export interface CorsOptions {
  allowlist: string[];
  methods?: string[];
  headers?: string[];
  /** Cookie-bearing endpoints. Requires an exact origin echo; never combined with `*`. */
  credentials?: boolean;
  maxAgeSeconds?: number;
}

/**
 * Headers for an actual (non-preflight) response.
 *
 * Returns `{}` — not a wildcard — when the origin is not allowed. An unknown origin gets no CORS
 * headers, the browser blocks the read, and the endpoint's own authorization still decides whether
 * anything happened at all.
 */
export function corsHeaders(origin: string | null | undefined, opts: CorsOptions): Record<string, string> {
  if (!isAllowedOrigin(origin, opts.allowlist)) return {};
  const h: Record<string, string> = {
    'Access-Control-Allow-Origin': String(origin),
    // Without this, a shared cache can serve the response it stored for origin A to origin B,
    // complete with A's Allow-Origin header. That is a cache-poisoned CORS bypass.
    Vary: 'Origin',
  };
  if (opts.credentials) h['Access-Control-Allow-Credentials'] = 'true';
  return h;
}

/** Headers for an OPTIONS preflight. */
export function preflightHeaders(origin: string | null | undefined, opts: CorsOptions): Record<string, string> {
  const base = corsHeaders(origin, opts);
  if (!Object.keys(base).length) return {};
  return {
    ...base,
    'Access-Control-Allow-Methods': (opts.methods || ['GET', 'POST', 'OPTIONS']).join(', '),
    'Access-Control-Allow-Headers': (opts.headers || ['Content-Type', 'Authorization']).join(', '),
    'Access-Control-Max-Age': String(opts.maxAgeSeconds ?? 600),
  };
}

/** The mail policy, read from MAIL_ALLOWED_ORIGINS. Credentialed, because mail uses the session cookie. */
export function mailCorsOptions(env: Record<string, string | undefined> = process.env as any): CorsOptions {
  return {
    allowlist: parseOrigins(env.MAIL_ALLOWED_ORIGINS),
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    headers: ['Content-Type', 'Authorization'],
    maxAgeSeconds: 600,
  };
}

/**
 * Preflight response for a mail endpoint.
 *
 * 204 with no headers when the origin is unknown — the request is answered, the browser blocks the
 * follow-up. Answering 403 here would be a probe oracle telling an attacker exactly which origins
 * are on the list.
 */
export function handlePreflight(request: Request, opts?: CorsOptions): Response {
  const options = opts || mailCorsOptions();
  return new Response(null, { status: 204, headers: preflightHeaders(request.headers.get('origin'), options) });
}
