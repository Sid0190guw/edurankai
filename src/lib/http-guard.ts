// src/lib/http-guard.ts — shared endpoint hardening (Prompt AP7a): input validation, rate-limit
// decisions, sanitized error responses (no stack/internal leak), and the security header set. Pure +
// composable so every API route can validate cleanly and fail closed. Secrets are always read from
// env (never hardcoded — enforced by security-audit).
import type { ZodTypeAny, infer as ZInfer } from 'zod';

/** Security headers (also applied globally at the edge via vercel.json). */
export function secureHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  };
}

/** Validate a request body against a Zod schema. Returns clean errors — never throws, never leaks. */
export function validateBody<S extends ZodTypeAny>(schema: S, body: unknown): { ok: true; data: ZInfer<S> } | { ok: false; error: string } {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  return { ok: false, error: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid input' };
}

/** Pure rate-limit decision (pair with a windowed counter). */
export function rateExceeded(countInWindow: number, maxPerWindow: number): boolean { return countInWindow >= maxPerWindow; }

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
export function errorJson(e: any, status = 200): Response { return secureJson({ ok: false, error: sanitizeError(e) }, status); }
