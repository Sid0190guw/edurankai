// src/lib/mailplatform/domains/api.ts — the guard every domain route goes through.
//
// One place, because seven routes each answering "who is this and may they?" in their own way is
// how one of them ends up answering it differently. The shape is deliberately blunt: a route either
// gets a Ctx it can use, or a Response it must return.
//
// Note what `guard` does NOT do: it never trusts an org id from the request. The Principal carries
// the organization, resolved from the session or the API key by ../adapters/auth-platform.ts, and
// every store call scopes to `principal.orgId`. A route that accepted `?org=` and passed it through
// would be a tenant boundary made of a query string.

import { platformAuth } from '../adapters/auth-platform';
import type { MailPermission, Principal } from '../types';
import type { Ctx } from './store';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function principalFor(request: Request, locals: unknown): Promise<Principal | null> {
  try {
    return await platformAuth().authenticate({ request, locals });
  } catch (e: any) {
    console.error('[mailplatform/domains] authentication failed -', String(e?.cause?.message || e?.message || e));
    return null;
  }
}

export type Guarded = { ok: true; ctx: Ctx } | { ok: false; response: Response };

/**
 * Resolve the caller and check one capability.
 *
 * 401 and 403 are kept distinct: "we do not know who you are" and "we know, and no" lead a caller
 * to different actions, and collapsing them into one status is a small cruelty to whoever is
 * debugging an integration at two in the morning.
 */
export async function guard(request: Request, locals: unknown, permission: MailPermission): Promise<Guarded> {
  const principal = await principalFor(request, locals);
  if (!principal) {
    return { ok: false, response: json({ ok: false, error: 'Not signed in.', code: 'unauthenticated' }, 401) };
  }
  const { can } = await import('../permissions');
  if (!can(principal, permission)) {
    return { ok: false, response: json({ ok: false, error: 'You do not have permission to do this.', code: 'insufficient_permission' }, 403) };
  }
  return {
    ok: true,
    ctx: {
      principal,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
      userAgent: request.headers.get('user-agent'),
    },
  };
}

/** Parse a JSON body without letting a malformed one become a 500. */
export async function body<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text.trim()) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Turn a store Result into a Response. Keeps the error CODE, which clients switch on. */
export function respond<T>(result: { ok: true; data: T } | { ok: false; error: string; code?: string }, status = 200): Response {
  if (result.ok) return json({ ok: true, data: result.data }, status);
  const code = result.code || 'error';
  const httpStatus =
    code === 'insufficient_permission' ? 403 :
    code === 'not_found' ? 404 :
    code === 'duplicate_domain' || code === 'duplicate' || code === 'selector_taken' || code === 'claimed_elsewhere' ? 409 :
    code === 'db_error' || code === 'graph_unreadable' ? 500 :
    400;
  return json({ ok: false, error: result.error, code }, httpStatus);
}
