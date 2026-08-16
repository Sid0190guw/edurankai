// src/lib/mailgov/http.ts — the small amount of HTTP shape every governance route repeats.
//
// Kept in lib rather than beside the routes so it is importable from a test and from an .astro page,
// and so a route file contains only its own decisions.
//
// `no-store` ON EVERY RESPONSE. These endpoints return one tenant's administration data, and a
// cached governance response served to the next request is a cross-tenant disclosure caused by a
// missing header. secureHeaders() from src/lib/http-guard.ts supplies the rest of the house rules.
import { secureHeaders } from '@/lib/http-guard';

export function govJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...secureHeaders(),
      'Content-Type': 'application/json',
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  });
}

/** Parse a JSON body without letting a malformed one become a 500. */
export async function readJson(request: Request): Promise<{ ok: true; body: any } | { ok: false; response: Response }> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') {
      return { ok: false, response: govJson({ ok: false, error: 'The request body must be a JSON object.' }, 400) };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, response: govJson({ ok: false, error: 'The request body was not valid JSON.' }, 400) };
  }
}

/**
 * The organization a request is about.
 *
 * A TENANT-SCOPED ACTOR'S OWN ORG ALWAYS WINS. If the request names a different one, this returns the
 * actor's — and authorizeGov() then compares the two and refuses. The parameter is a convenience for
 * platform actors switching customers, never a way to choose your own tenant.
 */
export function orgParam(url: URL, actorOrgId: string | null): string | null {
  if (actorOrgId) return actorOrgId;
  const v = (url.searchParams.get('org') || url.searchParams.get('orgId') || '').trim();
  return v || null;
}

/** A uniform "method not allowed", so a wrong verb is not a mysterious 404. */
export function methodNotAllowed(allowed: string[]): Response {
  return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed', allowed }), {
    status: 405,
    headers: { ...secureHeaders(), 'Content-Type': 'application/json', Allow: allowed.join(', '), 'cache-control': 'no-store' },
  });
}
