// src/lib/mailplatform/adapters/auth-platform.ts — AuthenticationProvider.
//
// NOT SUPABASE AUTH, and that is a decision rather than an omission. The brief names Supabase Auth
// as the starting point; this repository already runs a self-built multi-method auth stack —
// password, passkey (WebAuthn, hand-rolled), face, TOTP — over its own `sessions` table, with a
// middleware that populates `locals.user` on every request. Introducing a second identity system
// would mean two sources of truth for who someone is, and the mail platform is not the place to
// fork that. Supabase here is the Postgres host, which is exactly the coupling that stays cheap to
// undo.
//
// The interface is the insurance policy: if identity does move to Supabase Auth or an OIDC provider
// later, that is a new file implementing AuthenticationProvider and one line in ../providers.ts.
//
// TWO WAYS IN, ONE Principal OUT:
//   1. Session cookie  -> locals.user, populated by src/middleware.ts
//   2. API key         -> x-api-key / Authorization: Bearer, validated against hashed api_keys
// Everything downstream sees the same shape and never asks which it was, except where the
// difference genuinely matters (an API key acts as `service` and cannot administer anything).

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import type { AuthContext, AuthenticationProvider, ProviderInfo } from '../interfaces';
import type { MailPermission, OrgMemberRole, Principal } from '../types';
import { can, intersectScopes, PERMISSIONS_BY_ROLE } from '../permissions';
import { defaultOrgId, resolveOrgRole } from '../orgs';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** Header/query names an API key may arrive under. Matches src/lib/api-keys.ts exactly. */
function extractApiKey(request: Request): string {
  let key = request.headers.get('x-api-key') || '';
  if (!key) {
    const auth = request.headers.get('authorization') || '';
    if (/^bearer /i.test(auth)) key = auth.slice(7).trim();
  }
  if (!key) {
    try {
      key = new URL(request.url).searchParams.get('api_key') || '';
    } catch {
      /* a malformed URL is not an auth failure worth logging */
    }
  }
  return key.trim();
}

/**
 * The organization a request is acting on.
 *
 * An explicit `X-EduRankAI-Org` header (or `?org=`) is honoured ONLY if the caller actually belongs
 * to it — the check is in authenticate(), not here. This function just reads the intent.
 */
function requestedOrg(request: Request): string | null {
  const header = request.headers.get('x-edurankai-org') || request.headers.get('x-org') || '';
  if (header.trim()) return header.trim();
  try {
    return new URL(request.url).searchParams.get('org');
  } catch {
    return null;
  }
}

export function platformAuth(): AuthenticationProvider {
  return {
    info(): ProviderInfo {
      return {
        kind: 'edurankai-session+apikey',
        enabled: true,
        detail:
          'Sessions from the repository\'s own auth (src/lib/auth/session.ts) and hashed API keys from api_keys. No third-party identity provider.',
      };
    },

    async authenticate(ctx: AuthContext): Promise<Principal | null> {
      const orgHint = requestedOrg(ctx.request);

      // --- 1. API key ------------------------------------------------------
      const rawKey = extractApiKey(ctx.request);
      if (rawKey && rawKey.startsWith('erk_')) {
        try {
          const { validateApiKey } = await import('@/lib/api-keys');
          const key = await validateApiKey(ctx.request);
          if (!key) return null;

          // org_id and scopes are columns this patch ADDED to api_keys (see schema.ts). A key
          // issued before that migration has neither, and must keep working: it falls back to the
          // default organization with the full `service` permission set, which is what it had.
          let keyOrgId: string | null = null;
          let scopes: string[] = [];
          try {
            const r = rows(await db.execute(sql`SELECT org_id, scopes FROM api_keys WHERE id = ${key.id} LIMIT 1`));
            keyOrgId = r[0]?.org_id ?? null;
            scopes = Array.isArray(r[0]?.scopes) ? r[0].scopes : [];
          } catch (e: any) {
            // The columns may not exist yet on a deployment that has not run the migration. That is
            // not an authentication failure — it is an un-migrated database, and it is said out loud.
            console.error('[mailplatform/auth] could not read api_keys org scoping -', causeOf(e));
          }

          const orgId = keyOrgId || (await defaultOrgId());
          if (!orgId) return null;

          // A key may not act on an organization it was not issued for, whatever it asks for.
          if (orgHint && keyOrgId && orgHint !== keyOrgId) return null;

          const base = PERMISSIONS_BY_ROLE.service;
          return {
            kind: 'api_key',
            id: key.id,
            orgId,
            role: 'service',
            permissions: intersectScopes(base, scopes),
            label: key.label || key.organization || null,
          };
        } catch (e: any) {
          console.error('[mailplatform/auth] API key validation failed -', causeOf(e));
          return null;
        }
      }

      // --- 2. Session ------------------------------------------------------
      const user = (ctx.locals as any)?.user;
      if (!user?.id) return null;

      // isActive false means a disabled account. validateSessionToken() already deletes the session
      // in that case, but a locals object can be constructed by other code paths, so it is checked.
      if (user.isActive === false) return null;

      let orgId = await defaultOrgId();
      if (orgHint) {
        const { getOrg } = await import('../orgs');
        const target = await getOrg(orgHint);
        if (!target) return null;
        orgId = target.id;
      }
      if (!orgId) return null;

      const role: OrgMemberRole | null = await resolveOrgRole(orgId, {
        id: user.id,
        role: user.role,
        isActive: user.isActive,
      });
      // No membership and no internal mapping means: not a member of this organization. An
      // EduRankAI employee is not automatically a member of a customer's tenant, and this null is
      // the line that enforces it.
      if (!role) return null;

      return {
        kind: 'user',
        id: user.id,
        orgId,
        role,
        permissions: [...(PERMISSIONS_BY_ROLE[role] || [])],
        email: user.email,
        label: user.name || null,
      };
    },

    authorize(principal: Principal | null, permission: string): boolean {
      return can(principal, permission as MailPermission);
    },
  };
}

/**
 * A fixed principal, for tests.
 *
 * Takes the principal it should return rather than fabricating one, so a suite states exactly who
 * it is testing as. `null` tests the unauthenticated path.
 */
export function stubAuth(principal: Principal | null): AuthenticationProvider {
  return {
    info: () => ({ kind: 'stub-auth', enabled: true, detail: 'Fixed principal for tests.' }),
    async authenticate() {
      return principal;
    },
    authorize(p, permission) {
      return can(p, permission as MailPermission);
    },
  };
}
