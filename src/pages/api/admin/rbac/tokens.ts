// POST /api/admin/rbac/tokens — Block 10: manage capability tokens.
// Caller must hold 'delegate' (or 'administer'). Issued/delegated secrets are returned ONCE
// and never logged/audited. actions: issue | delegate | revoke | list
import type { APIRoute } from 'astro';
import { requireCapability, ForbiddenError, issueToken, delegateToken, revokeToken, listTokens } from '@/lib/rbac';
import { issueTokenSchema } from '@/lib/rbac/types';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

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
