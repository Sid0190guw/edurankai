// POST /api/admin/rbac/tokens — Block 10: manage capability tokens.
// Caller must hold 'delegate' (or 'administer'). Issued/delegated secrets are returned ONCE
// and never logged/audited. actions: issue | delegate | revoke | list
import type { APIRoute } from 'astro';
import { can, requireCapability, ForbiddenError, issueToken, delegateToken, revokeToken, listTokens } from '@/lib/rbac';
import { issueTokenSchema } from '@/lib/rbac/types';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// Declared at module top — `const` is not hoisted and the handler reads this on its issue path.
//
// The gate below asks for `delegate`, which the seeded `registrar` role holds. Nothing here capped
// what a token could CARRY, so a delegate-holder could mint a token for ['administer'] or ['*'] on
// resource '*' — the engine's Tier 4, and `administer` is its Tier-2 override. Presented tokens are
// attached to a Principal in only one place today (src/pages/api/rbac/check.ts, an advisory endpoint
// that performs no action), so this authorises nothing real yet; the cap is here so it never becomes
// real by someone wiring tokens into a live guard. Minting a god-token requires `administer`,
// exactly like using one.
const GOD_OPERATIONS: ReadonlySet<string> = new Set(['administer', '*']);
const carriesGodOperation = (ops: unknown): boolean =>
  Array.isArray(ops) && ops.some((o) => GOD_OPERATIONS.has(String(o)));

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  try {
    await requireCapability(user, 'delegate', { type: 'rbac' });   // throws ForbiddenError if denied
  } catch (e) {
    if (e instanceof ForbiddenError) return j({ ok: false, error: 'not permitted (need the delegate capability)', reason: e.decision.reason }, 403);
    throw e;
  }

  let b: any = {};
  try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const action = String(b.action || '');

  // A token that carries `administer` (or the `*` wildcard) is a superadmin credential in a header.
  // Issuing or delegating one requires the capability itself, above every write below. can() audits.
  if ((action === 'issue' || action === 'delegate') && carriesGodOperation(b.allowedOperations)) {
    const sup = await can(user, 'administer', { type: 'rbac' });
    if (!sup.allow) {
      return j({ ok: false, error: 'superadmin only (a token carrying administer or *)', reason: sup.reason }, 403);
    }
  }

  try {
    if (action === 'issue') {
      const parsed = issueTokenSchema.safeParse(b);
      if (!parsed.success) return j({ ok: false, error: 'invalid body', issues: parsed.error.issues.map((i) => i.message) }, 400);
      const p = parsed.data;
      const { tokenId, token } = await issueToken({
        ownerIdentity: p.ownerIdentity, targetResource: p.targetResource, allowedOperations: p.allowedOperations as any,
        scope: p.scope, maxDelegationDepth: p.maxDelegationDepth, expiresAt: p.expiresAt ?? null, reason: p.reason,
      }, user.id);
      return j({ ok: true, tokenId, token });   // token shown ONCE
    }

    if (action === 'delegate') {
      if (!b.parentToken || !b.ownerIdentity || !Array.isArray(b.allowedOperations) || !b.allowedOperations.length) {
        return j({ ok: false, error: 'parentToken, ownerIdentity, allowedOperations[] required' }, 400);
      }
      const { tokenId, token } = await delegateToken(String(b.parentToken), user.id, {
        ownerIdentity: String(b.ownerIdentity), allowedOperations: b.allowedOperations,
        targetResource: b.targetResource ? String(b.targetResource) : undefined,
        scope: b.scope, expiresAt: b.expiresAt ?? null, reason: b.reason,
      });
      return j({ ok: true, tokenId, token });
    }

    if (action === 'revoke') {
      if (!b.tokenId) return j({ ok: false, error: 'tokenId required' }, 400);
      const revoked = await revokeToken(String(b.tokenId), { cascade: b.cascade !== false });
      return j({ ok: true, revoked });
    }

    if (action === 'list') {
      if (!b.ownerIdentity) return j({ ok: false, error: 'ownerIdentity required' }, 400);
      const tokens = await listTokens(String(b.ownerIdentity));
      return j({ ok: true, tokens });
    }

    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 400);
  }
};
