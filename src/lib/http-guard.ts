// src/lib/http-guard.ts — shared endpoint hardening (Prompt AP7a): input validation, rate-limit
// decisions, sanitized error responses (no stack/internal leak), and the security header set. Pure +
// composable so every API route can validate cleanly and fail closed. Secrets are always read from
// env (never hardcoded — enforced by security-audit).
import type { ZodTypeAny, infer as ZInfer } from 'zod';
import { mailCsp, type CspProfile } from './mailsec/csp';

/**
 * Security headers (also applied globally at the edge via vercel.json).
 *
 * CSP WAS THE ONE THAT WAS MISSING. This set and the vercel.json set between them covered
 * transport, sniffing, framing, referrer and permissions — and nothing at all bounded script
 * execution, which is what actually mattered when mail HTML rendered into the reading pane could
 * carry a payload. The sanitiser in src/lib/mailsec/html.ts closed that hole; this is the control
 * that makes the NEXT gap in it survivable rather than total.
 *
 * It ships REPORT-ONLY and it must stay that way until the four steps documented at the top of
 * src/lib/mailsec/csp.ts are done — the blocker is that 75 pages use `define:vars`, which Astro
 * can only emit as an inline <script>, so enforcing today would blank working pages in production.
 *
 * The profile defaults to API because every current caller of this function returns JSON or a
 * file: src/lib/mailapi/errors.ts, src/lib/mailgov/http.ts and
 * src/pages/api/mail/gov/export-download.ts. An API response loads nothing, so it is allowed
 * nothing. A caller that is returning an HTML DOCUMENT must pass `{ csp: 'DOCUMENT' }` — the API
 * policy on a page would report every asset on it as a violation, which is noise, not a finding.
 */
export function secureHeaders(opts: { csp?: CspProfile } = {}): Record<string, string> {
  const csp = mailCsp({ profile: opts.csp ?? 'API' });
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    [csp.header]: csp.value,
  };
}

/** Validate a request body against a Zod schema. Returns clean errors — never throws, never leaks. */
export function validateBody<S extends ZodTypeAny>(schema: S, body: unknown): { ok: true; data: ZInfer<S> } | { ok: false; error: string } {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  return { ok: false, error: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid input' };
}

/** A sanitized, user-safe error message — the real cause is logged server-side, never returned. */
export function sanitizeError(e: any): string {
  const msg = String(e?.cause?.message || e?.message || '');
  // never surface stack traces, SQL, or connection strings
  if (!msg || /at\s+\w+\s+\(|\/node_modules\/|postgres:\/\/|password|ECONN|syntax error|relation "/i.test(msg)) return 'Something went wrong. Please try again.';
  return msg.slice(0, 160);
}

/** A JSON response carrying the security headers. */
export function secureJson(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...secureHeaders() } });
}
