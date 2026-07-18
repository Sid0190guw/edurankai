// POST /api/admin/credentials — issue / revoke course credentials (Prompt 10). Gated by
// can(user,'manage',{type:'credential'}) — registrar (manage) or superadmin (administer); a
// content_author/faculty cannot. Every call is audited by can(). Issuing enforces P8 eligibility.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { issueCredential, revokeCredential, isEligible } from '@/lib/credential';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const d = await can(user, 'manage', { type: 'credential' });
  if (!d.allow) return j({ ok: false, error: 'not permitted (registrar/superadmin only)', reason: d.reason }, 403);

  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'check') {
      if (!b.userId || !b.courseObjId) return j({ ok: false, error: 'userId + courseObjId required' }, 400);
      return j({ ok: true, ...(await isEligible(String(b.userId), String(b.courseObjId))) });
    }
    if (b.action === 'issue') {
      if (!b.userId || !b.courseObjId) return j({ ok: false, error: 'userId + courseObjId required' }, 400);
      const r = await issueCredential(String(b.userId), String(b.courseObjId), user.id);
      return j(r.ok ? { ok: true, code: r.code } : { ok: false, error: r.error });
    }
    if (b.action === 'revoke') {
      if (!b.code) return j({ ok: false, error: 'code required' }, 400);
      await revokeCredential(String(b.code), user.id, String(b.reason || 'revoked'));
      return j({ ok: true });
    }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'server error' }, 200); }
};
