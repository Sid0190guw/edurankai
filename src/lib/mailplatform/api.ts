// src/lib/mailplatform/api.ts — the shared shape of every /api/v1 route.
//
// One place decides what a response looks like, what a refusal looks like, how a page is requested
// and how a body is validated. Thirteen route files each inventing their own is how an API ends up
// with four different error shapes and a client that has to special-case every endpoint.
//
// RESPONSE SHAPE, fixed:
//   success  { "ok": true,  ...payload }
//   failure  { "ok": false, "error": "<sentence a human can act on>", "code": "<machine token>" }
//
// The `error` is written for a person reading a log at 2am; the `code` is for a program branching.
// Refusals for AUTHORIZATION deliberately say only "forbidden" — telling an unauthorised caller
// which capability they lack tells them what to go looking for.

import type { APIContext } from 'astro';
import { providers } from './providers';
import { can } from './permissions';
import type { MailPermission, Page, Principal } from './types';

export const API_VERSION = 'v1';

/** CORS for the public API. Mirrors src/lib/api-keys.ts so partners see one consistent policy. */
export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-edurankai-org',
  'Access-Control-Max-Age': '86400',
};

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
  });
}

export function ok(payload: Record<string, unknown> = {}, status = 200): Response {
  return json({ ok: true, ...payload }, status);
}

export function error(message: string, status = 400, code?: string): Response {
  return json({ ok: false, error: message, code: code || codeForStatus(status) }, status);
}

function codeForStatus(status: number): string {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'error';
}

export const preflight = (): Response => new Response(null, { status: 204, headers: CORS });

// ---------------------------------------------------------------------------
// Authentication and authorization
// ---------------------------------------------------------------------------

export interface Authed {
  principal: Principal;
}

/**
 * Resolve the caller, or return the Response to send back.
 *
 *   const auth = await requirePrincipal(ctx, 'mail.send');
 *   if (auth instanceof Response) return auth;
 *   const { principal } = auth;
 *
 * 401 when nobody is signed in — the caller can fix that by signing in. 403 for everything else.
 * The distinction matters: a client that retries a 403 with a fresh token loops forever.
 */
export async function requirePrincipal(
  ctx: Pick<APIContext, 'request' | 'locals'>,
  permission?: MailPermission,
): Promise<Authed | Response> {
  let principal: Principal | null = null;
  try {
    principal = await providers().auth.authenticate({ request: ctx.request, locals: ctx.locals });
  } catch (e: any) {
    // An authentication system that throws must not read as "authenticated". It reads as 500, and
    // the reason is logged where an operator will find it.
    console.error('[mailplatform/api] authentication threw -', String(e?.cause?.message || e?.message || e));
    return error('Could not verify who is making this request.', 500, 'auth_unavailable');
  }

  if (!principal) {
    return error(
      'Not signed in. Send a session cookie, or an API key in the x-api-key header.',
      401,
      'unauthorized',
    );
  }
  if (permission && !can(principal, permission)) {
    return error('forbidden', 403, 'insufficient_permission');
  }
  return { principal };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/** Parse a JSON body, or return the Response. Refuses a body larger than 5 MB. */
export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 5_000_000): Promise<T | Response> {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    return error(`That request body is larger than ${Math.floor(maxBytes / 1_000_000)} MB.`, 413, 'payload_too_large');
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return error('The request body could not be read.', 400, 'unreadable_body');
  }
  if (text.length > maxBytes) {
    return error(`That request body is larger than ${Math.floor(maxBytes / 1_000_000)} MB.`, 413, 'payload_too_large');
  }
  if (!text.trim()) return {} as T;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return error('The request body must be a JSON object.', 400, 'invalid_json');
    }
    return parsed as T;
  } catch {
    return error('The request body is not valid JSON.', 400, 'invalid_json');
  }
}

export interface PageParams {
  limit: number;
  cursor: string | null;
}

/**
 * Read `?limit` and `?cursor`.
 *
 * The limit is CLAMPED rather than rejected: a client asking for 10,000 rows gets `max`, not a 400.
 * An unbounded limit is how one client request becomes a full table scan, and the honest answer to
 * "give me everything" is a page plus a cursor.
 */
export function pageParams(url: URL, defaultLimit = 25, max = 100): PageParams {
  const raw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), max) : defaultLimit;
  const cursor = url.searchParams.get('cursor');
  return { limit, cursor: cursor && cursor.trim() ? cursor.trim() : null };
}

/** The envelope every list endpoint returns. */
export function pageResponse<T>(page: Page<T>, key = 'items'): Response {
  return json({
    ok: true,
    [key]: page.items,
    pagination: { hasMore: page.hasMore, nextCursor: page.nextCursor, ...(page.total != null ? { total: page.total } : {}) },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a path parameter that must be a uuid.
 *
 * Postgres raises 22P02 on a malformed uuid, and without this the client sees a database complaint
 * about its own URL. That exact problem is written up on this repository's key-revocation path.
 */
export function requireUuid(value: unknown, name = 'id'): string | Response {
  const s = String(value || '').trim();
  if (!UUID_RE.test(s)) return error(`"${name}" must be a uuid.`, 400, 'invalid_id');
  return s;
}

export function isUuid(value: unknown): boolean {
  return UUID_RE.test(String(value || '').trim());
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export interface FieldSpec {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  maxLength?: number;
  oneOf?: readonly string[];
}

/**
 * Small, explicit body validation.
 *
 * `zod` is in this project's dependencies and would do this too. It is not used here on purpose:
 * these routes need to return the SENTENCE a person reads, and a schema library's default messages
 * ("Expected string, received number at to[0]") are not that. The rule set is small enough that
 * hand-written beats a translation layer over generated text.
 */
export function validate(
  body: Record<string, unknown>,
  spec: Record<string, FieldSpec>,
): { ok: true } | { ok: false; response: Response } {
  const problems: string[] = [];

  for (const [field, rule] of Object.entries(spec)) {
    const value = body[field];
    const absent = value === undefined || value === null || value === '';

    if (rule.required && absent) {
      problems.push(`"${field}" is required.`);
      continue;
    }
    if (absent) continue;

    if (rule.type) {
      const actual = Array.isArray(value) ? 'array' : typeof value;
      const matches = rule.type === 'array' ? Array.isArray(value) : actual === rule.type;
      if (!matches) {
        problems.push(`"${field}" must be ${rule.type === 'array' ? 'an array' : 'a ' + rule.type}.`);
        continue;
      }
    }
    if (rule.maxLength && typeof value === 'string' && value.length > rule.maxLength) {
      problems.push(`"${field}" is longer than ${rule.maxLength} characters.`);
    }
    if (rule.oneOf && !rule.oneOf.includes(String(value))) {
      problems.push(`"${field}" must be one of: ${rule.oneOf.join(', ')}.`);
    }
  }

  // Every problem at once, not the first one. An API that reports one field error per round trip
  // makes a form with six fields a six-request conversation.
  if (problems.length) return { ok: false, response: error(problems.join(' '), 422, 'validation_failed') };
  return { ok: true };
}

/** The client's IP, for audit rows. Trusts the platform's own proxy headers, in Vercel's order. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const first = forwarded.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip') || null;
}

/** Write an audit row. Never throws — an audit failure must not fail the operation it describes. */
export async function audit(input: {
  principal: Principal;
  request: Request;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`
      INSERT INTO mp_audit_logs (org_id, actor_user_id, actor_api_key_id, action, target_type, target_id, meta, ip_address, user_agent)
      VALUES (${input.principal.orgId},
              ${input.principal.kind === 'user' ? input.principal.id : null},
              ${input.principal.kind === 'api_key' ? input.principal.id : null},
              ${input.action}, ${input.targetType || null}, ${input.targetId || null},
              ${JSON.stringify(input.meta || {})}::jsonb,
              ${clientIp(input.request)}, ${input.request.headers.get('user-agent') || null})`);
  } catch (e: any) {
    console.error('[mailplatform/api] audit write failed for', input.action, '-', String(e?.cause?.message || e?.message || e));
  }
}
